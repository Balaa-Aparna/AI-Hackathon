from __future__ import annotations

import os
import redis

_redis: redis.Redis | None = None


def get_redis() -> redis.Redis:
    global _redis
    if _redis is None:
        url = os.environ.get("REDIS_URL", "")
        if not url:
            raise RuntimeError(
                "REDIS_URL must be set in .env. "
                "Copy the Public Endpoint from your Redis Cloud database and format it as: "
                "redis://default:<password>@<host>:<port>"
            )
        _redis = redis.from_url(url, decode_responses=True)
    return _redis
