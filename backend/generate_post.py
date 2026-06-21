from __future__ import annotations

import os
from typing import Optional

from anthropic import Anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

MODEL = "claude-haiku-4-5"

POST_SYSTEM_PROMPT = """\
You are a sharp social media writer. Write a single X post (~100 words) that synthesizes the user's research.

Rules:
- Use the anchors as the conceptual spine — don't list them, weave them in
- Reflect the user's stated goal and genuine opinion
- Write in first person, clear and direct
- No hashtags unless genuinely necessary
- No quotation marks wrapping the whole post
- Return only the post text, nothing else
"""

ARTICLE_SYSTEM_PROMPT = """\
You are an expert educational writer. Write a long-form, well-structured educational \
article (~600-900 words) in Markdown that teaches the topic, grounded in the user's research.

Rules:
- Use clear Markdown: one title (#), section headings (##), and short paragraphs
- Use the anchors as the conceptual backbone of the article
- Reflect the user's stated goal and genuine opinion where it fits naturally
- Support claims with inline citations written as Markdown links to the provided sources,
  e.g. ...as studies show ([source](https://example.com)).
- Only ever cite from the provided sources — never invent or guess URLs
- End with a "## Sources" section listing every provided source as a Markdown link
- Return only the Markdown article, nothing else
"""

# Token budget per output format (articles need far more room than a ~100-word post).
MAX_TOKENS = {"post": 300, "article": 2200}

router = APIRouter()
_client: Optional[Anthropic] = None


class Source(BaseModel):
    title: str = ""
    url: str


class GeneratePostRequest(BaseModel):
    query: str
    anchors: list[str]
    achieve: str
    opinion: str
    # "post" -> short X post (default); "article" -> long educational article
    # with inline citation links to `sources`.
    format: str = "post"
    sources: list[Source] = []


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

    fmt = req.format if req.format in ("post", "article") else "post"
    anchors_text = "\n".join(f"- {a}" for a in req.anchors if a.strip()) or "(none)"

    user_content = (
        f"Research topic: {req.query}\n\n"
        f"Key anchors:\n{anchors_text}\n\n"
        f"What I want to achieve: {req.achieve or '(not specified)'}\n\n"
        f"My genuine take: {req.opinion or '(not specified)'}"
    )

    if fmt == "article":
        sources_text = (
            "\n".join(f"- {s.title or s.url}: {s.url}" for s in req.sources if s.url)
            or "(no sources provided — write the article without citations)"
        )
        user_content += f"\n\nSources to cite (use these exact URLs):\n{sources_text}"

    system_prompt = ARTICLE_SYSTEM_PROMPT if fmt == "article" else POST_SYSTEM_PROMPT

    try:
        response = _get_client().messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS[fmt],
            system=system_prompt,
            messages=[{"role": "user", "content": user_content}],
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Claude request failed: {exc}")

    post = "".join(b.text for b in response.content if b.type == "text").strip()
    if not post:
        raise HTTPException(status_code=502, detail="No post returned by model.")

    return GeneratePostResponse(post=post)
