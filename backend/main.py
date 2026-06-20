from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Doc Prompt API")

# Allow the Vite dev server to call this API during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# In-memory store of uploaded docs: {id: {"name": str, "text": str}}
DOCUMENTS: dict[str, dict] = {}


class PromptRequest(BaseModel):
    prompt: str
    document_id: str | None = None


class PromptResponse(BaseModel):
    answer: str


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/documents")
def list_documents():
    return [{"id": doc_id, "name": doc["name"]} for doc_id, doc in DOCUMENTS.items()]


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        # Non-text files are stored but not decoded in this skeleton.
        text = ""

    doc_id = str(len(DOCUMENTS) + 1)
    (UPLOAD_DIR / f"{doc_id}_{file.filename}").write_bytes(raw)
    DOCUMENTS[doc_id] = {"name": file.filename, "text": text}
    return {"id": doc_id, "name": file.filename}


@app.post("/api/prompt", response_model=PromptResponse)
def prompt(req: PromptRequest):
    context = ""
    if req.document_id:
        doc = DOCUMENTS.get(req.document_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")
        context = doc["text"]

    # TODO: wire up a real LLM call here (e.g. the Anthropic API).
    answer = (
        f"[stub] You asked: {req.prompt!r}. "
        f"Context length: {len(context)} chars."
    )
    return PromptResponse(answer=answer)
