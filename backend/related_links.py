from __future__ import annotations

import os

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# Browserbase Search API endpoint.
# Docs: POST /v1/search with the x-bb-api-key header.
SEARCH_URL = "https://api.browserbase.com/v1/search"

# Number of related links we return to the frontend (requirement: 4).
NUM_RESULTS = 4

# Browserbase rejects queries outside 1-200 characters, so cap before sending.
MAX_QUERY_CHARS = 200

# ---------------------------------------------------------------------------
# PLACEHOLDER (see backend/PLACEHOLDERS.txt -> #1)
# Fallback query used when the frontend sends an empty `query`. Replace this
# once we decide how the real search query is built (document topic, extracted
# anchors, an explicit user search box, etc.).
# ---------------------------------------------------------------------------
PLACEHOLDER_QUERY = "REPLACE_ME: default related-links search query"

router = APIRouter()


class RelatedLinksRequest(BaseModel):
    # PLACEHOLDER (see PLACEHOLDERS.txt -> #1): the query the frontend sends.
    # Currently optional; falls back to PLACEHOLDER_QUERY when blank.
    query: str = ""


class LinkResult(BaseModel):
    title: str
    url: str


class RelatedLinksResult(BaseModel):
    query: str
    results: list[LinkResult]


def _get_api_key() -> str:
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="BROWSERBASE_API_KEY is not set on the server.",
        )
    return api_key


@router.post("/api/related-links", response_model=RelatedLinksResult)
def related_links(req: RelatedLinksRequest) -> RelatedLinksResult:
    query = (req.query.strip() or PLACEHOLDER_QUERY)[:MAX_QUERY_CHARS]

    try:
        resp = requests.post(
            SEARCH_URL,
            headers={
                "Content-Type": "application/json",
                "x-bb-api-key": _get_api_key(),
            },
            json={"query": query, "numResults": NUM_RESULTS},
            timeout=20,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Browserbase search failed: {exc}")

    data = resp.json()
    results = [
        LinkResult(title=r.get("title") or r["url"], url=r["url"])
        for r in data.get("results", [])
        if r.get("url")
    ][:NUM_RESULTS]

    return RelatedLinksResult(query=query, results=results)
