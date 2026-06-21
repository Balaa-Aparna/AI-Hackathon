from __future__ import annotations

import os
from typing import Optional

from anthropic import Anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import memory
import embeddings as emb
import vector_store

MODEL = "claude-haiku-4-5"
MAX_ANCHORS = 10
MAX_TEXT_CHARS = 50_000


SYSTEM_PROMPT = """
## ROLE

You are an anchor extractor. Given a chunk of text, you identify the exact sentences that do the most argumentative or explanatory work — the anchor sentences without which the author cannot make their point.

---

## WHAT AN ANCHOR IS

An anchor is a verbatim sentence from the text that:

- Makes the core claim, assertion, or insight the section is built around
- Cannot be removed without collapsing the author's argument
- Is not a transitional, introductory, or summary sentence
- Is not a heading or label

---

## RULES

1. Copy anchor sentences verbatim from the text — do not paraphrase or shorten
2. Only return sentences that carry the argument forward
3. Do not return headings, bullet labels, or meta-commentary
4. If an anchor sentence is only meaningful with context, include that context sentence too
5. Return 3–7 anchor sentences per chunk

---

## OUTPUT

Return 3–7 verbatim anchor sentences from the text.
"""


router = APIRouter()
_client: Optional[Anthropic] = None


class AnchorRequest(BaseModel):
    text: str
    topic: str = ""


class AnchorResult(BaseModel):
    anchors: list[str] = Field(
        ..., description="5-10 anchor words or short phrases extracted from the document"
    )


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise HTTPException(
                status_code=503,
                detail="ANTHROPIC_API_KEY is not set on the server.",
            )
        _client = Anthropic(api_key=api_key)
    return _client


def _clean(anchors: list[str]) -> list[str]:
    seen = set()
    out = []
    for a in anchors:
        a = a.strip()
        k = a.lower()
        if a and k not in seen:
            seen.add(k)
            out.append(a)
    return out[:MAX_ANCHORS]


_TOOL = {
    "name": "extract_anchors",
    "description": "Return the anchor sentences extracted from the document.",
    "input_schema": {
        "type": "object",
        "properties": {
            "anchors": {
                "type": "array",
                "items": {"type": "string"},
                "description": "3-7 verbatim anchor sentences copied from the document",
            }
        },
        "required": ["anchors"],
    },
}


def extract_anchors(text: str, topic: str = "") -> list[str]:
    client = _get_client()

    document = text[:MAX_TEXT_CHARS]

    user_content = (
        f"Topic focus: {topic.strip() or '(infer from document)'}\n\n"
        f"Document:\n{document}"
    )

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
            tools=[_TOOL],
            tool_choice={"type": "tool", "name": "extract_anchors"},
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Claude request failed: {exc}")

    for block in response.content:
        if block.type == "tool_use" and block.name == "extract_anchors":
            return _clean(block.input.get("anchors", []))

    raise HTTPException(status_code=502, detail="No anchors returned by model.")


@router.post("/api/anchors", response_model=AnchorResult)
def anchors_endpoint(req: AnchorRequest) -> AnchorResult:
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    # Return cached result if this exact chunk has been seen before.
    cached = memory.get_cached_anchors(req.text)
    if cached is not None:
        return AnchorResult(anchors=cached)

    anchors = extract_anchors(req.text, req.topic)

    # Persist result so the same chunk doesn't re-invoke Claude next session.
    memory.cache_anchors(req.text, anchors)

    # Embed anchors and index them for vector search (fire-and-forget; skip if
    # Voyage key is absent so the endpoint still works without it).
    anchor_embeddings = emb.embed(anchors)
    if anchor_embeddings is not None:
        for anchor_text, embedding in zip(anchors, anchor_embeddings):
            vector_store.store(anchor_text, req.text, embedding)

    return AnchorResult(anchors=anchors)