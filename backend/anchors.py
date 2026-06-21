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

Anchors must be ≤ 15 words.

---

## RULES

1. Do not force anchors that are not present
2. Do not return category-level labels
3. Anchors must survive a "removal test"
4. Prefer structural forces over topics

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


def extract_anchors(text: str, topic: str = "") -> list[str]:
    client = _get_client()

    document = text[:MAX_TEXT_CHARS]

    user_content = (
        f"Topic focus: {topic.strip() or '(infer from document)'}\n\n"
        f"Document:\n{document}"
    )

    try:
        response = client.messages.parse(
            model=MODEL,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
            output_format=AnchorResult,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Claude request failed: {exc}")

    if response.stop_reason == "refusal":
        raise HTTPException(status_code=502, detail="Claude refused the request.")

    result = getattr(response, "parsed", None)
    if result is None:
        raise HTTPException(status_code=502, detail="No parsed output returned.")

    return _clean(result.anchors)


@router.post("/api/anchors", response_model=AnchorResult)
def anchors_endpoint(req: AnchorRequest) -> AnchorResult:
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    return AnchorResult(anchors=extract_anchors(req.text, req.topic))