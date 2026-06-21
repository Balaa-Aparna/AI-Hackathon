from __future__ import annotations

import os
from typing import Optional

from anthropic import Anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

MODEL = "claude-opus-4-8"
MAX_ANCHORS = 10
MAX_TEXT_CHARS = 50_000


SYSTEM_PROMPT = """
## ROLE

You are an anchor extractor. Given a piece of text, you identify the anchor(s) — the irreducible organizing forces the text is built around.

---

## WHAT AN ANCHOR IS

An anchor is the structural center the content orbits. It is not the topic or title.

- It is a **force**, not a subject label
- It explains why the text holds together
- Removing it collapses coherence
- an anchor is not a heading, anchors are the sentences that drive the heading, without it , without which the author cannot explain his view
Anchors must be ≤ 15 words.

---

## RULES

1. Do not force anchors that are not present
2. Do not return category-level labels
3. Anchors must survive a "removal test"
4. Prefer structural forces over topics
5. anchors are never the heading
---

## OUTPUT

Return 5–10 anchors as short phrases.
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
    "description": "Return the anchors extracted from the document.",
    "input_schema": {
        "type": "object",
        "properties": {
            "anchors": {
                "type": "array",
                "items": {"type": "string"},
                "description": "5-10 anchor phrases extracted from the document",
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

    return AnchorResult(anchors=extract_anchors(req.text, req.topic))