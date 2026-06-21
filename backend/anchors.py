from __future__ import annotations

import os
from typing import Optional

from anthropic import Anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

MODEL = "claude-haiku-4-5"
MAX_ANCHORS_FLOOR = 2
MAX_ANCHORS_CEIL = 8
MAX_TEXT_CHARS = 50_000


def _anchor_limit(text: str) -> int:
    words = len(text.split())
    return max(MAX_ANCHORS_FLOOR, min(MAX_ANCHORS_CEIL, words // 200))


SYSTEM_PROMPT = """
## ROLE

You are an anchor extractor. Given a chunk of text with a heading, you identify the anchors — the irreducible organizing forces that drive the content under that heading.

---

## WHAT AN ANCHOR IS

An anchor is the structural claim or argument the content cannot exist without. It is not the topic, title, or a summary.

- It is a **force**, not a subject label
- It explains why this specific section holds together under its heading
- Removing it collapses the coherence of this chunk
- An anchor is never the heading itself — it is the sentence or claim that drives the heading; without it the author cannot justify or explain the heading
- An anchor must be traceable to an actual claim, argument, or assertion present in this chunk — not inferred, not generalized, not borrowed from outside this section

Anchors must be ≤ 10 words.

---

## LOYALTY RULE

**Anchors are entirely loyal to their heading.**

The heading of this chunk is the scope boundary. Every anchor you return must live inside that boundary — it must be a force that drives the content of THIS heading, not the broader article, not the topic, not something implied from elsewhere.

Ask yourself: "Would this anchor still make sense if I only had this heading's section and nothing else?" If not, discard it.

---

## GOAL FOCUS (when provided)

If a writing goal is given, prefer anchors that are directly relevant to achieving that goal. When two claims are equally valid anchors structurally, choose the one that better serves the stated purpose. Still apply all rules — never fabricate or generalize beyond what's in the text.

---

## RULES

1. **Only extract anchors that are present in the text.** Do not invent, generalize, or infer from context outside this chunk.
2. Do not return category-level labels or topic summaries
3. Anchors must survive a "removal test": if you removed this claim, the section under this heading collapses
4. Prefer the actual structural argument over a re-phrased topic
5. Anchors are never the heading itself
6. **Do not pad.** Never fabricate anchors to reach the maximum. Return only genuine ones.
7. Return at least 2 anchors and no more than the maximum specified for this chunk — fewer is better if the section is focused

---

## OUTPUT

For each anchor return an object with two fields:
- **phrase**: the anchor (≤ 10 words), grounded in the actual text and loyal to this chunk's heading
- **quote**: the shortest verbatim span from this chunk that the anchor is grounded in (≤ 30 words). Copy it exactly as it appears in the provided text, including any markdown syntax characters.

The exact maximum number of anchors is specified per chunk in the user message.
"""


router = APIRouter()
_client: Optional[Anthropic] = None


class AnchorRequest(BaseModel):
    text: str
    achieve: str = ""


class AnchorItem(BaseModel):
    phrase: str
    quote: str = ""


class AnchorResult(BaseModel):
    anchors: list[AnchorItem]


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


def _clean(anchors: list[dict], max_n: int) -> list[dict]:
    seen = set()
    out = []
    for a in anchors:
        phrase = a.get("phrase", "").strip()
        quote = a.get("quote", "").strip()
        k = phrase.lower()
        if phrase and k not in seen:
            seen.add(k)
            out.append({"phrase": phrase, "quote": quote})
    return out[:max_n]


_TOOL = {
    "name": "extract_anchors",
    "description": "Return the anchors extracted from this chunk — each grounded in the actual text and loyal to the chunk's heading. The maximum count is specified in the user message.",
    "input_schema": {
        "type": "object",
        "properties": {
            "anchors": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "phrase": {
                            "type": "string",
                            "description": "Anchor phrase (≤ 10 words), grounded in the actual text",
                        },
                        "quote": {
                            "type": "string",
                            "description": "Shortest verbatim span from this chunk the anchor is grounded in (≤ 30 words, copied exactly as it appears)",
                        },
                    },
                    "required": ["phrase", "quote"],
                },
                "description": "Anchors extracted from this chunk, each with a phrase and its source quote",
            }
        },
        "required": ["anchors"],
    },
}


def extract_anchors(text: str, achieve: str = "") -> list[dict]:
    client = _get_client()

    document = text[:MAX_TEXT_CHARS]
    max_n = _anchor_limit(document)

    goal_line = f"Writing goal: {achieve.strip()}\n" if achieve.strip() else ""
    user_content = (
        f"Chunk size: ~{len(document.split())} words — return at most {max_n} anchors.\n"
        f"{goal_line}"
        f"\nChunk:\n{document}"
    )

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=512,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
            tools=[_TOOL],
            tool_choice={"type": "tool", "name": "extract_anchors"},
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Claude request failed: {exc}")

    for block in response.content:
        if block.type == "tool_use" and block.name == "extract_anchors":
            return _clean(block.input.get("anchors", []), max_n)

    raise HTTPException(status_code=502, detail="No anchors returned by model.")


@router.post("/api/anchors", response_model=AnchorResult)
def anchors_endpoint(req: AnchorRequest) -> AnchorResult:
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    return AnchorResult(anchors=[AnchorItem(**a) for a in extract_anchors(req.text, req.achieve)])