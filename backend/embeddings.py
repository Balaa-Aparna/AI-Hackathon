from __future__ import annotations

from sentence_transformers import SentenceTransformer

_model: SentenceTransformer | None = None


def _get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


def embed(texts: list[str]) -> list[list[float]] | None:
    if not texts:
        return None
    model = _get_model()
    return model.encode(texts).tolist()
