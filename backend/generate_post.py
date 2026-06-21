from __future__ import annotations

import os
from typing import Optional

from anthropic import Anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

MODEL = "claude-haiku-4-5"

SYSTEM_PROMPT = """\
You are a sharp social media writer. Write a single X post (~100 words) that synthesizes the user's research.

Rules:
- Use the anchors as the conceptual spine — don't list them, weave them in
- Reflect the user's stated goal and genuine opinion
- Write in first person, clear and direct
- No hashtags unless genuinely necessary
- No quotation marks wrapping the whole post
- Return only the post text, nothing else
"""

router = APIRouter()
_client: Optional[Anthropic] = None


class GeneratePostRequest(BaseModel):
    query: str
    anchors: list[str]
    achieve: str
    opinion: str


class GeneratePostResponse(BaseModel):
    post: str


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY is not set.")
        _client = Anthropic(api_key=api_key)
    return _client


@router.post("/api/generate-post", response_model=GeneratePostResponse)
def generate_post(req: GeneratePostRequest) -> GeneratePostResponse:
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="query is required")

    anchors_text = "\n".join(f"- {a}" for a in req.anchors if a.strip()) or "(none)"

    user_content = (
        f"Research topic: {req.query}\n\n"
        f"Key anchors:\n{anchors_text}\n\n"
        f"What I want to achieve: {req.achieve or '(not specified)'}\n\n"
        f"My genuine take: {req.opinion or '(not specified)'}"
    )

    try:
        response = _get_client().messages.create(
            model=MODEL,
            max_tokens=300,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Claude request failed: {exc}")

    post = "".join(b.text for b in response.content if b.type == "text").strip()
    if not post:
        raise HTTPException(status_code=502, detail="No post returned by model.")

    return GeneratePostResponse(post=post)
