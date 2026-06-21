from __future__ import annotations

from pathlib import Path

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from anchors import router as anchors_router

# Load backend/.env so ANTHROPIC_API_KEY is available to the SDK.
load_dotenv()

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
    path = UPLOAD_DIR / f"{doc_id}_{file.filename}"
    path.write_bytes(raw)
    DOCUMENTS[doc_id] = {
        "name": file.filename,
        "text": text,
        "path": str(path),
        "content_type": file.content_type or "application/octet-stream",
    }
    return {"id": doc_id, "name": file.filename}


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: str):
    doc = DOCUMENTS.get(doc_id)
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
    doc = DOCUMENTS.get(doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return FileResponse(
        doc["path"],
        media_type=doc["content_type"],
        filename=doc["name"],
        # "inline" lets the browser render the file in the preview <iframe>;
        # the default "attachment" would force a download instead.
        content_disposition_type="inline",
    )


@app.post("/api/prompt", response_model=PromptResponse)
def prompt(req: PromptRequest):
    context = ""
    if req.document_id:
        doc = DOCUMENTS.get(req.document_id)
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