from __future__ import annotations

import hashlib
import json

import numpy as np

from redis_client import get_redis

_PREFIX = "vstore:anchor:"
_INDEX = "vstore:index"


def _cosine(a: list[float], b: list[float]) -> float:
    va = np.array(a, dtype=np.float32)
    vb = np.array(b, dtype=np.float32)
    norm = np.linalg.norm(va) * np.linalg.norm(vb)
    return float(np.dot(va, vb) / norm) if norm > 0 else 0.0


def store(anchor_text: str, source_chunk: str, embedding: list[float]) -> None:
    """Persist an anchor alongside its source chunk text and embedding vector."""
    r = get_redis()
    h = hashlib.sha256(anchor_text.encode()).hexdigest()[:16]
    key = f"{_PREFIX}{h}"
    r.set(key, json.dumps({
        "text": anchor_text,
        "chunk": source_chunk,
        "embedding": embedding,
    }))
    r.sadd(_INDEX, key)


def search(query_embedding: list[float], top_k: int = 5) -> list[dict]:
    """Return top_k anchors ranked by cosine similarity to query_embedding."""
    r = get_redis()
    keys = list(r.smembers(_INDEX) or [])
    if not keys:
        return []

    results = []
    for key in keys:
        raw = r.get(key)
        if not raw:
            continue
        item = json.loads(raw)
        score = _cosine(query_embedding, item["embedding"])
        results.append({"anchor": item["text"], "chunk": item["chunk"], "score": score})

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:top_k]
