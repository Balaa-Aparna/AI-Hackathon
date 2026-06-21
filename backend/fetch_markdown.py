from __future__ import annotations

import os
import re
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

# Browserbase Fetch endpoint. With format="markdown" Browserbase converts the
# fetched page into markdown and returns it in the response `content` field.
# Docs: POST /v1/fetch with the x-bb-api-key header.
FETCH_URL = "https://api.browserbase.com/v1/fetch"

# Cheap "did we actually get content?" guard. JS-heavy pages often return a 200
# from Fetch but with an (almost) empty body, because Fetch never runs the
# JavaScript that would render the real content. If the markdown is shorter than
# this, we fall back to a full headless-browser session (see _render_with_browser)
# that runs the JavaScript before extracting. Tune this if it rejects genuinely
# short pages.
MIN_MARKDOWN_CHARS = 30

# How long (ms) to let a page settle in the headless fallback before extracting.
BROWSER_NAV_TIMEOUT_MS = 60_000
BROWSER_IDLE_TIMEOUT_MS = 15_000

router = APIRouter()


class FetchMarkdownRequest(BaseModel):
    url: str
    # Route through Browserbase's proxy network (helps with sites that 403).
    proxies: bool = False
    # When the fast Fetch path returns near-empty content (JS-rendered page),
    # fall back to a full headless browser session that runs the JavaScript.
    # Set false to keep the old behaviour (fail fast with a 422 instead).
    use_browser_fallback: bool = True


def _get_api_key() -> str:
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="BROWSERBASE_API_KEY is not set on the server.",
        )
    return api_key


def _render_with_browser(url: str) -> str:
    """Render `url` in a Browserbase headless session and return markdown.

    Unlike the Fetch API, this drives a real cloud Chromium (via Playwright over
    CDP), so client-side JavaScript runs and the resulting DOM holds the real
    content. We then convert the rendered HTML to markdown locally.

    Raises HTTPException with a clear message if the session can't be set up.
    """
    api_key = _get_api_key()
    project_id = os.environ.get("BROWSERBASE_PROJECT_ID")
    if not project_id:
        raise HTTPException(
            status_code=503,
            detail=(
                "Headless fallback needs BROWSERBASE_PROJECT_ID set on the server "
                "(Browserbase dashboard -> Settings -> Project ID)."
            ),
        )

    # Imported lazily so the module still loads if these optional deps are
    # missing; surface a clear install hint instead of an ImportError at startup.
    try:
        from browserbase import Browserbase
        from markdownify import markdownify as html_to_markdown
        from playwright.sync_api import sync_playwright
        from playwright.sync_api import TimeoutError as PlaywrightTimeout
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Headless fallback needs extra deps: "
                "pip install playwright browserbase markdownify "
                f"(import failed: {exc})."
            ),
        )

    bb = Browserbase(api_key=api_key)
    session = bb.sessions.create(project_id=project_id)
    try:
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(session.connect_url)
            try:
                context = browser.contexts[0]
                page = context.pages[0] if context.pages else context.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=BROWSER_NAV_TIMEOUT_MS)
                # Best-effort: wait for network to settle so late XHR content lands.
                try:
                    page.wait_for_load_state("networkidle", timeout=BROWSER_IDLE_TIMEOUT_MS)
                except PlaywrightTimeout:
                    pass
                html = page.content()
            finally:
                browser.close()
    except HTTPException:
        raise
    except Exception as exc:  # Playwright/Browserbase connection or nav failure.
        raise HTTPException(status_code=502, detail=f"Headless render failed: {exc}")

    # Drop non-content nodes, then convert the rendered body to markdown.
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "template", "iframe"]):
        tag.decompose()
    root = soup.body or soup
    return html_to_markdown(str(root), heading_style="ATX").strip()


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
    stripped = markdown.strip() if isinstance(markdown, str) else ""

    if len(stripped) < MIN_MARKDOWN_CHARS:
        # 200 from Browserbase but effectively empty -> almost always a page that
        # needs JavaScript to render. Fall back to a full headless session that
        # runs the JS before extracting (unless the caller opted out).
        if not req.use_browser_fallback:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Fetched page had little or no readable content ({len(stripped)} chars). "
                    "It likely requires JavaScript to render; retry with use_browser_fallback."
                ),
            )

        stripped = _render_with_browser(url)
        if len(stripped) < MIN_MARKDOWN_CHARS:
            # Even a real browser found nothing -> genuinely empty/blocked page.
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Page had little or no readable content even after a browser render "
                    f"({len(stripped)} chars)."
                ),
            )

    filename = _filename_for(url)
    return Response(
        content=stripped,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
