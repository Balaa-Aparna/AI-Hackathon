from __future__ import annotations

import os
import re
from urllib.parse import urlparse

import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

import memory

# Browserbase Fetch endpoint. With format="markdown" Browserbase converts the
# fetched page into markdown and returns it in the response `content` field.
# Docs: POST /v1/fetch with the x-bb-api-key header.
FETCH_URL = "https://api.browserbase.com/v1/fetch"

# Cheap "did we actually get content?" guard. JS-heavy pages often return a 200
# from Fetch but with an (almost) empty body, because Fetch never runs the
# JavaScript that would render the real content. If the markdown is shorter than
# this, we treat it as a failed extraction and tell the caller to use a browser
# session instead. Tune this if it rejects genuinely short pages.
MIN_MARKDOWN_CHARS = 30

router = APIRouter()


class FetchMarkdownRequest(BaseModel):
    url: str
    # Route through Browserbase's proxy network (helps with sites that 403).
    proxies: bool = False


def _get_api_key() -> str:
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="BROWSERBASE_API_KEY is not set on the server.",
        )
    return api_key


def _filename_for(url: str) -> str:
    """Build a safe '<host>-<path>.md' filename from the source URL."""
    parsed = urlparse(url)
    stem = f"{parsed.netloc}{parsed.path}".strip("/") or "page"
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-")
    return f"{stem[:100] or 'page'}.md"


@router.post("/api/fetch-markdown")
def fetch_markdown(req: FetchMarkdownRequest) -> Response:
    url = req.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    # Return cached markdown if this URL was fetched recently (saves Browserbase credits).
    cached = memory.get_cached_url(url)
    if cached:
        filename = _filename_for(url)
        return Response(
            content=cached,
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    try:
        resp = requests.post(
            FETCH_URL,
            headers={
                "Content-Type": "application/json",
                "x-bb-api-key": _get_api_key(),
            },
            json={
                "url": url,
                "format": "markdown",
                "allowRedirects": True,
                "proxies": req.proxies,
            },
            timeout=75,  # Browserbase allows the target up to 60s to respond.
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Browserbase fetch failed: {exc}")

    if not resp.ok:
        # Surface Browserbase's structured error message when present
        # (e.g. 502 content too large, 504 timeout, 502 SSL error).
        try:
            detail = resp.json().get("message") or resp.text
        except ValueError:
            detail = resp.text
        raise HTTPException(status_code=502, detail=f"Browserbase fetch failed: {detail}")

    markdown = resp.json().get("content")
    if not isinstance(markdown, str):
        raise HTTPException(status_code=422, detail="No markdown content returned for that URL.")

    stripped = markdown.strip()
    if len(stripped) < MIN_MARKDOWN_CHARS:
        # 200 from Browserbase but effectively empty -> almost always a page that
        # needs JavaScript to render. Surface a clear, catchable error.
        raise HTTPException(
            status_code=422,
            detail=(
                f"Fetched page had little or no readable content ({len(stripped)} chars). "
                "It likely requires JavaScript to render; try a full browser session."
            ),
        )

    memory.cache_url(url, markdown)

    filename = _filename_for(url)
    return Response(
        content=markdown,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
