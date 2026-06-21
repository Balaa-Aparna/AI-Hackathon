from __future__ import annotations

import concurrent.futures
import os

import requests
from bs4 import BeautifulSoup
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# Browserbase Search API endpoint.
# Docs: POST /v1/search with the x-bb-api-key header.
SEARCH_URL = "https://api.browserbase.com/v1/search"

# Browserbase Fetch endpoint, used to verify a link is server-rendered.
FETCH_URL = "https://api.browserbase.com/v1/fetch"

# Number of related links we return to the frontend (requirement: 4).
NUM_RESULTS = 4

# When verifying, ask Search for more candidates so that — after dropping the
# JS-only ones — we can still return NUM_RESULTS good links.
CANDIDATE_RESULTS = 10

# A page counts as "server-rendered" if its raw HTML already contains at least
# this much visible text (i.e. the content is there without running JavaScript).
# JS-only SPA shells fall well below this. Tune for your sources.
MIN_RENDERED_TEXT_CHARS = 500

# Keep verification snappy and within Browserbase's Fetch rate limit (5 RPS on
# the Developer plan): short per-link timeout, small parallel pool.
VERIFY_TIMEOUT = 12
MAX_VERIFY_WORKERS = 4

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
    # Filter out JS-only pages so users only see links that actually render
    # without a browser (and that /api/fetch-markdown can convert). Set false
    # to skip verification and return raw search results faster.
    verify_renderable: bool = True


class LinkResult(BaseModel):
    title: str
    url: str
    # Lightweight preview metadata from the search result (used for the
    # on-hover link preview in the UI). All optional — may be empty strings.
    image: str = ""
    favicon: str = ""
    published: str = ""


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


def _is_server_rendered(url: str, api_key: str) -> bool:
    """True if the page's raw HTML already holds real text (no JS needed).

    Does a cheap raw Fetch (no markdown conversion, no proxy) and checks how
    much visible text the unrendered HTML contains. JS-only pages return an
    almost-empty shell and fail this check. Any error -> treat as not renderable
    so we simply skip the link rather than break the whole response.
    """
    try:
        resp = requests.post(
            FETCH_URL,
            headers={"Content-Type": "application/json", "x-bb-api-key": api_key},
            json={"url": url, "format": "raw", "allowRedirects": True},
            timeout=VERIFY_TIMEOUT,
        )
        if not resp.ok:
            return False
        body = resp.json()
    except (requests.RequestException, ValueError):
        return False

    # Only HTML pages can be "server-rendered" in the sense we care about;
    # skip PDFs/binaries (encoding == "base64") that fetch-markdown can't convert.
    if not str(body.get("contentType", "")).startswith("text/html"):
        return False

    content = body.get("content")
    if not isinstance(content, str):
        return False

    soup = BeautifulSoup(content, "html.parser")
    for tag in soup(["script", "style", "noscript", "template"]):
        tag.decompose()
    text = soup.get_text(" ", strip=True)
    return len(text) >= MIN_RENDERED_TEXT_CHARS


@router.post("/api/related-links", response_model=RelatedLinksResult)
def related_links(req: RelatedLinksRequest) -> RelatedLinksResult:
    query = (req.query.strip() or PLACEHOLDER_QUERY)[:MAX_QUERY_CHARS]
    api_key = _get_api_key()

    # Ask for extra candidates when verifying, since some get filtered out.
    num_requested = CANDIDATE_RESULTS if req.verify_renderable else NUM_RESULTS

    try:
        resp = requests.post(
            SEARCH_URL,
            headers={"Content-Type": "application/json", "x-bb-api-key": api_key},
            json={"query": query, "numResults": num_requested},
            timeout=20,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Browserbase search failed: {exc}")

    candidates = [
        LinkResult(
            title=r.get("title") or r["url"],
            url=r["url"],
            image=r.get("image") or "",
            favicon=r.get("favicon") or "",
            published=r.get("publishedDate") or "",
        )
        for r in resp.json().get("results", [])
        if r.get("url")
    ]

    if not req.verify_renderable:
        return RelatedLinksResult(query=query, results=candidates[:NUM_RESULTS])

    # Verify candidates in parallel (I/O-bound), then keep the first NUM_RESULTS
    # that are server-rendered, preserving the original search ranking.
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_VERIFY_WORKERS) as pool:
        ok_flags = pool.map(lambda c: _is_server_rendered(c.url, api_key), candidates)

    results = [c for c, ok in zip(candidates, ok_flags) if ok][:NUM_RESULTS]
    return RelatedLinksResult(query=query, results=results)
