# AnchorPoint

**AI that keeps your point of view at the center.**

AnchorPoint turns any question into an original, fully-cited post or article — grounded in real web sources, written in your voice, with zero hallucination. Instead of letting an AI think *for* you, it finds credible sources, surfaces the load-bearing ideas (**anchors**), and uses them — plus your own take — to write something credible and yours.

---

## The Problem

AI hands people finished answers, and in the process the user's own perspective disappears — along with any guarantee the facts are real. Generic LLM output hallucinates sources, invents citations, and all sounds the same. AnchorPoint exists to fix that: real research, real citations, your voice.

---

## The Flow

A guided, 6-step journey from a question to a shareable, cited post:

1. **Question** — Ask what you're researching (type or by voice).
2. **Sources** — AnchorPoint searches the web and returns credible links, each with a hover preview (thumbnail, title, source, date).
3. **Explore & Anchor** — Each source is converted to clean Markdown and chunked. The key ideas are surfaced as **anchors** — the structural ideas the text is built on — which you can review and edit.
4. **Review** — Every anchor you marked, collected in one place.
5. **Reflect** — Share your genuine take, so the output carries *your* perspective.
6. **Post** — Claude writes a short post or a long, **fully-cited article** from your anchors + your take. Every claim links back to a real source.

---

## Why It's Grounded (Not Hallucinated)

Claude only ever writes from content that Browserbase **physically fetched** from the live web. It can't invent facts or URLs — the article cites exactly the sources we retrieved. The anchors keep the user's judgment in the loop, and the reflection keeps it in their voice.

---

## Architecture

```
Question
   │
   ▼
[Browserbase Search API] ───────────► credible source links + metadata
   │
   ▼  (per source)
[Browserbase Fetch API: raw]  ──► verify the page has real readable content
[Browserbase Fetch API: markdown] ─► convert the page to clean Markdown
   │        │
   │        └─ empty / JS-heavy? ──► [Browserbase Headless Browser]
   │                                  Playwright over CDP → run JS → render → Markdown
   ▼
Chunk the Markdown
   │
   ▼
[Claude] ──► extract anchors (forced tool-use → structured JSON)
   │
   ▼  (+ user's anchors + user's take)
[Claude] ──► generate a short post OR a long cited article
```

This mirrors **Browserbase's own recommended pattern: Search → Fetch → Browser** — fast, cheap path for the common case, escalating to a full browser only when a page needs JavaScript.

---

## Tech Stack

### Browserbase — the research engine
- **Search API** (`POST /v1/search`) — turns the question into real, current source links + metadata (title, url, image, favicon, author, published date). Lightweight: returns links only, never downloads pages.
- **Fetch API** (`POST /v1/fetch`) —
  - `format=raw` to **verify** each candidate has real, readable text (filters out empty JavaScript shells).
  - `format=markdown` to **convert** a page straight to clean Markdown for reading and chunking.
- **Headless Browser session** — when Fetch returns near-empty content (a JS-rendered page), the app creates a Browserbase session and drives a real cloud Chromium with **Playwright over CDP** (`connect_over_cdp`), runs the page's JavaScript, and converts the rendered HTML to Markdown. No source is lost to client-side rendering.
- **`browse` CLI** — used during development to drive and test the live app end-to-end.

### Claude (Anthropic) — the intelligence
- Model: **`claude-haiku-4-5`** via the Anthropic Python SDK.
- **Anchor extraction** — a strict system prompt defines what an "anchor" is; output is forced through **tool-use** (`tool_choice` on an `extract_anchors` tool) so Claude returns clean, schema-validated JSON instead of free-form prose.
- **Post / article generation** — two runtime-selected system prompts: a ~100-word post, or a ~600–900-word Markdown article with **inline citation links** to the provided sources plus a Sources section.

### Frontend — React / Vite
- React (Vite dev server, port 5173) — the 6-step editorial UI with View-Transitions cross-fades.
- `marked` for Markdown rendering (custom renderers: drop images, open citation links in new tabs, highlight anchored quotes).
- **Browser-native voice** (Web Speech API) — dictation (speech-to-text) on the question and anchor fields, and read-aloud (text-to-speech) on source chunks and the final post. No external service, no API keys.
- Hover **link previews** for sources (thumbnail + title + host + date).

### Backend — FastAPI (Python)
Routes (all under `/api`):
- `POST /api/related-links` — Browserbase search + server-rendered verification.
- `POST /api/fetch-markdown` — Browserbase fetch → Markdown, with headless-browser fallback.
- `POST /api/anchors` — Claude anchor extraction.
- `POST /api/generate-post` — Claude post/article generation (`format: "post" | "article"`).
- `GET /api/health`, plus a small document-upload skeleton.
- CORS enabled for the Vite dev server. State is in-memory (no database).

### Built with Claude Code
The entire project was developed and tested end-to-end using **Claude Code** — including using Claude's browser tooling to drive the live app and catch real bugs before the demo.

---

## How to Run

**Backend** (terminal 1):
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate   # first time
pip install -r requirements.txt                      # first time
uvicorn main:app --port 8000 --reload
```

**Frontend** (terminal 2):
```bash
cd frontend
npm install        # first time
npm run dev
```

Open **http://localhost:5173** (Vite proxies `/api/*` to the backend on port 8000).

**Environment** — `backend/.env` needs:
```
ANTHROPIC_API_KEY=...
BROWSERBASE_API_KEY=...
BROWSERBASE_PROJECT_ID=...      # required for the headless-browser fallback
```

---

## Why AnchorPoint vs. Existing Tools

- **vs. a plain LLM** — an LLM gives you what it *remembers or guesses* (stale, hallucinated, fake citations). Browserbase gives us what's *actually on the live web, right now* — real content we can cite and verify. Claude is the brain; Browserbase is the eyes and hands.
- **vs. Perplexity** — Perplexity answers *for* you. AnchorPoint distills real research into an original, credited piece that keeps *your* perspective front and center.
- **vs. NotebookLM** — NotebookLM explains your documents. AnchorPoint finds the sources, surfaces the ideas that matter, and writes from your anchors.

**One line:** AnchorPoint turns a single question into a credible, fully-cited article in minutes — real sources, your voice, zero hallucination.
