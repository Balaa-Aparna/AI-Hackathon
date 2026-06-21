from __future__ import annotations

import hashlib
import json
import uuid
from typing import Optional

from redis_client import get_redis

_DOC_TTL = 60 * 60 * 24 * 30   # 30 days
_URL_TTL = 60 * 60 * 24 * 3    # 3 days
_ANCHOR_TTL = 60 * 60 * 24 * 7  # 7 days


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# ── documents ──────────────────────────────────────────────────────────────────

def store_document(
    name: str,
    text: str,
    path: str = "",
    source_url: str = "",
    content_type: str = "text/plain",
) -> str:
    r = get_redis()
    doc_id = uuid.uuid4().hex[:8]
    r.set(
        f"doc:{doc_id}",
        json.dumps({
            "id": doc_id,
            "name": name,
            "text": text,
            "path": path,
            "source_url": source_url,
            "content_type": content_type,
        }),
        ex=_DOC_TTL,
    )
    r.sadd("docs:index", doc_id)
    return doc_id


def get_document(doc_id: str) -> Optional[dict]:
    r = get_redis()
    raw = r.get(f"doc:{doc_id}")
    return json.loads(raw) if raw else None


def list_documents() -> list[dict]:
    r = get_redis()
    ids = list(r.smembers("docs:index") or [])
    docs = []
    for doc_id in ids:
        raw = r.get(f"doc:{doc_id}")
        if raw:
            doc = json.loads(raw)
            docs.append({"id": doc["id"], "name": doc["name"]})
    return docs


# ── anchor cache ───────────────────────────────────────────────────────────────

def cache_anchors(text: str, anchors: list[str]) -> None:
    r = get_redis()
    r.set(f"anchors:{_hash(text)}", json.dumps(anchors), ex=_ANCHOR_TTL)


def get_cached_anchors(text: str) -> Optional[list[str]]:
    r = get_redis()
    raw = r.get(f"anchors:{_hash(text)}")
    return json.loads(raw) if raw else None


# ── URL fetch cache ────────────────────────────────────────────────────────────

def cache_url(url: str, content: str) -> None:
    r = get_redis()
    r.set(f"url:{_hash(url)}", content, ex=_URL_TTL)


def get_cached_url(url: str) -> Optional[str]:
    r = get_redis()
    return r.get(f"url:{_hash(url)}")
