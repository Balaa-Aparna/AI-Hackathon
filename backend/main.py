from __future__ import annotations

import anthropic
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from anchors import router as anchors_router
from related_links import router as related_links_router
from fetch_markdown import router as fetch_markdown_router
from generate_post import router as generate_post_router
import memory
import embeddings as emb
import vector_store

# Load backend/.env so API keys are available regardless of working directory.
load_dotenv(Path(__file__).parent / ".env")

# Reads ANTHROPIC_API_KEY from the environment.
client = anthropic.Anthropic()

MODEL = "claude-opus-4-8"

app = FastAPI(title="Doc Prompt API")
app.include_router(anchors_router)

# Allow the Vite dev server to call this API during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount the LLM-powered anchor extraction routes (POST /api/anchors).
app.include_router(anchors_router)

# Mount the Browserbase-powered related-links route (POST /api/related-links).
app.include_router(related_links_router)

# Mount the Browserbase-powered URL-to-markdown route (POST /api/fetch-markdown).
app.include_router(fetch_markdown_router)

# Mount the X-post generator (POST /api/generate-post).
app.include_router(generate_post_router)

UPLOAD_DIR = Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)


class PromptRequest(BaseModel):
    prompt: str
    document_id: str | None = None


class PromptResponse(BaseModel):
    answer: str


class FetchUrlRequest(BaseModel):
    url: str


class SearchRequest(BaseModel):
    query: str
    top_k: int = 5


def _extract_text(html: str) -> tuple[str, str]:
    """Return (title, readable_text) extracted from an HTML page."""
    soup = BeautifulSoup(html, "html.parser")

    # Drop elements that never carry article content.
    for tag in soup(["script", "style", "noscript", "header", "footer", "nav", "aside"]):
        tag.decompose()

    title = soup.title.get_text(strip=True) if soup.title else ""

    # Join block-level text with blank lines so paragraphs stay separated.
    blocks = soup.find_all(["h1", "h2", "h3", "h4", "p", "li", "blockquote", "pre"])
    if blocks:
        parts = [b.get_text(" ", strip=True) for b in blocks]
    else:
        parts = [soup.get_text("\n", strip=True)]

    text = "\n\n".join(p for p in parts if p)
    return title, text


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/documents")
def list_documents():
    return memory.list_documents()


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = ""

    path = UPLOAD_DIR / file.filename
    path.write_bytes(raw)

    doc_id = memory.store_document(
        name=file.filename,
        text=text,
        path=str(path),
        content_type=file.content_type or "application/octet-stream",
    )
    return {"id": doc_id, "name": file.filename}


@app.post("/api/fetch-url")
def fetch_url(req: FetchUrlRequest):
    url = req.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    try:
        resp = requests.get(
            url,
            timeout=15,
            headers={"User-Agent": "Mozilla/5.0 (compatible; DocPromptBot/1.0)"},
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=400, detail=f"Could not fetch URL: {exc}")

    title, text = _extract_text(resp.text)
    if not text:
        raise HTTPException(status_code=422, detail="No readable text found at that URL.")

    name = title or url
    doc_id = memory.store_document(
        name=name,
        text=text,
        source_url=url,
    )
    return {"id": doc_id, "name": name, "text": text, "url": url}


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: str):
    doc = memory.get_document(doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return {
        "id": doc_id,
        "name": doc["name"],
        "text": doc["text"],
        "content_type": doc["content_type"],
        "is_text": bool(doc["text"]),
    }


@app.get("/api/documents/{doc_id}/raw")
def get_document_raw(doc_id: str):
    doc = memory.get_document(doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if not doc.get("path"):
        raise HTTPException(status_code=404, detail="No raw file for this document")
    return FileResponse(
        doc["path"],
        media_type=doc["content_type"],
        filename=doc["name"],
        content_disposition_type="inline",
    )


@app.post("/api/prompt", response_model=PromptResponse)
def prompt(req: PromptRequest):
    context = ""
    if req.document_id:
        doc = memory.get_document(req.document_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")
        context = doc["text"]

    system = "You are a helpful assistant that answers questions about the user's document."
    if context:
        system += f"\n\nHere is the document the user is asking about:\n\n{context}"

    try:
        message = client.messages.create(
            model=MODEL,
            max_tokens=4096,
            system=system,
            messages=[{"role": "user", "content": req.prompt}],
        )
    except anthropic.APIError as exc:
        raise HTTPException(status_code=502, detail=f"LLM request failed: {exc}") from exc

    answer = "".join(block.text for block in message.content if block.type == "text")
    return PromptResponse(answer=answer)


@app.post("/api/search")
def search(req: SearchRequest):
    """Semantic search over indexed anchor embeddings, with Claude-synthesized answer."""
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="query is required")

    query_embeddings = emb.embed([req.query])
    if query_embeddings is None:
        raise HTTPException(
            status_code=503,
            detail="VOYAGE_API_KEY not configured. Set it in .env to enable vector search.",
        )

    results = vector_store.search(query_embeddings[0], top_k=req.top_k)
    if not results:
        return {
            "results": [],
            "answer": "No indexed content yet. Extract anchors from content first.",
        }

    context = "\n\n---\n\n".join(
        f"[Anchor: {r['anchor']}]\n{r['chunk']}" for r in results
    )

    try:
        message = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=(
                "You are a research assistant. Answer the question using only the context "
                "chunks provided. Be concise and cite which anchor the information came from."
            ),
            messages=[{
                "role": "user",
                "content": f"Context:\n{context}\n\nQuestion: {req.query}",
            }],
        )
        answer = "".join(block.text for block in message.content if block.type == "text")
    except anthropic.APIError as exc:
        answer = f"Could not synthesize answer: {exc}"

    return {"results": results, "answer": answer}
