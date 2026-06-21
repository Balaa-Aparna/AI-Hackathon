from __future__ import annotations

import os
from anthropic import Anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import embeddings as emb
import vector_store

router = APIRouter()
MODEL = "claude-sonnet-4-6"
_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not set")
        _client = Anthropic(api_key=api_key)
    return _client


class GeneratePostRequest(BaseModel):
    goal: str
    opinion: str
    mode: str = "auto"  # "auto" | "theme" | "tension" | "outlier"


class GeneratePostResponse(BaseModel):
    post: str
    mode_used: str
    anchors_used: list[str]


_TOOL = {
    "name": "write_post",
    "description": "Write a social-media-ready post grounded in the provided anchor sentences.",
    "input_schema": {
        "type": "object",
        "properties": {
            "post": {
                "type": "string",
                "description": (
                    "The social media post. LinkedIn style: 3–5 punchy paragraphs, "
                    "hook first, insight next, close with a question or call to action. "
                    "150–300 words. Echo the actual anchor language."
                ),
            },
            "mode_used": {
                "type": "string",
                "enum": ["theme", "tension", "outlier"],
                "description": "Which anchor pattern shaped the post.",
            },
            "anchors_used": {
                "type": "array",
                "items": {"type": "string"},
                "description": "The anchor sentences that directly appear in or inspired the post.",
            },
        },
        "required": ["post", "mode_used", "anchors_used"],
    },
}

_MODE_INSTRUCTIONS = {
    "theme": (
        "THEME mode: find the 3–5 anchors that share the strongest common thread "
        "and synthesize them into one cohesive insight."
    ),
    "tension": (
        "TENSION mode: identify two anchors (or groups) that pull in opposite directions "
        "and frame the post around that productive conflict — present both sides honestly."
    ),
    "outlier": (
        "OUTLIER mode: find the one anchor that is most surprising or contrarian relative "
        "to the others, lead with it as the hook, then ground it with 1–2 supporting anchors."
    ),
    "auto": (
        "AUTO mode: read all the anchors and choose whichever pattern — THEME, TENSION, or "
        "OUTLIER — produces the most compelling post given the user's goal and genuine opinion."
    ),
}


@router.post("/api/generate-post", response_model=GeneratePostResponse)
def generate_post(req: GeneratePostRequest):
    if not req.goal.strip():
        raise HTTPException(status_code=400, detail="goal is required")
    if not req.opinion.strip():
        raise HTTPException(status_code=400, detail="opinion is required")

    query = f"{req.goal.strip()} {req.opinion.strip()}"
    query_emb = emb.embed([query])
    if query_emb is None:
        raise HTTPException(status_code=503, detail="Embedding model unavailable.")

    results = vector_store.search(query_emb[0], top_k=10)
    if not results:
        raise HTTPException(
            status_code=422,
            detail="No anchors indexed yet — extract anchors from sources in Step 3 first.",
        )

    anchors_block = "\n".join(f"- {r['anchor']}" for r in results)
    mode_instruction = _MODE_INSTRUCTIONS.get(req.mode, _MODE_INSTRUCTIONS["auto"])

    user_content = (
        f"Goal: {req.goal}\n"
        f"Genuine opinion: {req.opinion}\n\n"
        f"Anchor sentences (verbatim from real, credible sources):\n{anchors_block}\n\n"
        f"Instructions: {mode_instruction}"
    )

    client = _get_client()
    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=(
                "You are a social media writer who turns research into compelling posts. "
                "Ground every claim in the provided anchor sentences — do not add facts, "
                "statistics, or assertions beyond what the anchors contain. "
                "The anchors are verbatim extracts from real sources, so the information is reliable."
            ),
            messages=[{"role": "user", "content": user_content}],
            tools=[_TOOL],
            tool_choice={"type": "tool", "name": "write_post"},
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Claude request failed: {exc}")

    for block in response.content:
        if block.type == "tool_use" and block.name == "write_post":
            inp = block.input
            return GeneratePostResponse(
                post=inp["post"],
                mode_used=inp["mode_used"],
                anchors_used=inp.get("anchors_used", []),
            )

    raise HTTPException(status_code=502, detail="No post returned by model.")
