"""Rate limiter for auth endpoints with Redis-backed sliding window and in-memory fallback."""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any
from fastapi import HTTPException, Request

from app.config import get_settings

MAX_ATTEMPTS = 5
WINDOW_SECONDS = 300  # 5 minutes
BLOCK_SECONDS = 600   # 10 minutes lockout
_REDIS_DISABLE_COOLOFF_SECONDS = 60.0

_attempts: dict[str, list[float]] = defaultdict(list)
_blocked_until: dict[str, float] = {}

_redis_client: Any = None
_redis_disabled_until: float = 0.0


def _get_redis():
    global _redis_client, _redis_disabled_until
    now = time.time()
    if now < _redis_disabled_until:
        return None
    if _redis_client is None:
        try:
            import redis
            settings = get_settings()
            _redis_client = redis.Redis.from_url(
                settings.redis_url,
                socket_timeout=0.2,
                socket_connect_timeout=0.2,
                decode_responses=True,
            )
            # Lightweight ping to test reachability
            _redis_client.ping()
        except Exception:
            _redis_disabled_until = now + _REDIS_DISABLE_COOLOFF_SECONDS
            _redis_client = None
            return None
    return _redis_client


def _disable_redis() -> None:
    global _redis_disabled_until, _redis_client
    _redis_disabled_until = time.time() + _REDIS_DISABLE_COOLOFF_SECONDS
    _redis_client = None


def _client_ip(request: Request) -> str:
    client_host = request.client.host if request.client else "unknown"
    settings = get_settings()
    trusted = getattr(settings, "trusted_proxies", ["127.0.0.1", "::1"])
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded and client_host in trusted:
        return forwarded.split(",")[0].strip()
    return client_host


def check_rate_limit(request: Request, endpoint: str) -> None:
    """Raise 429 if this IP has exceeded the attempt limit."""
    ip = _client_ip(request)
    key = f"{endpoint}:{ip}"
    now = time.time()

    r = _get_redis()
    if r is not None:
        try:
            lockout_key = f"mapr:ratelimit:lockout:{endpoint}:{ip}"
            if r.get(lockout_key):
                raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")

            zset_key = f"mapr:ratelimit:attempts:{endpoint}:{ip}"
            cutoff = now - WINDOW_SECONDS
            pipe = r.pipeline()
            pipe.zremrangebyscore(zset_key, 0, cutoff)
            pipe.zcard(zset_key)
            _, count = pipe.execute()
            if count >= MAX_ATTEMPTS:
                r.setex(lockout_key, BLOCK_SECONDS, "1")
                raise HTTPException(status_code=429, detail="Too many failed attempts. Locked for 10 minutes.")
            return
        except HTTPException:
            raise
        except Exception:
            _disable_redis()

    # Fallback to in-memory limiter
    blocked_until = _blocked_until.get(key, 0)
    if now < blocked_until:
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")

    cutoff = now - WINDOW_SECONDS
    _attempts[key] = [t for t in _attempts.get(key, []) if t > cutoff]

    if len(_attempts[key]) >= MAX_ATTEMPTS:
        _blocked_until[key] = now + BLOCK_SECONDS
        raise HTTPException(status_code=429, detail="Too many failed attempts. Locked for 10 minutes.")


def record_attempt(request: Request, endpoint: str) -> None:
    ip = _client_ip(request)
    key = f"{endpoint}:{ip}"
    now = time.time()

    r = _get_redis()
    if r is not None:
        try:
            zset_key = f"mapr:ratelimit:attempts:{endpoint}:{ip}"
            pipe = r.pipeline()
            pipe.zadd(zset_key, {str(now): now})
            pipe.expire(zset_key, WINDOW_SECONDS + BLOCK_SECONDS)
            pipe.execute()
        except Exception:
            _disable_redis()

    _attempts[key].append(now)


def clear_attempts(request: Request, endpoint: str) -> None:
    """Clear attempts on successful auth."""
    ip = _client_ip(request)
    key = f"{endpoint}:{ip}"

    r = _get_redis()
    if r is not None:
        try:
            lockout_key = f"mapr:ratelimit:lockout:{endpoint}:{ip}"
            zset_key = f"mapr:ratelimit:attempts:{endpoint}:{ip}"
            r.delete(lockout_key, zset_key)
        except Exception:
            _disable_redis()

    _attempts.pop(key, None)
    _blocked_until.pop(key, None)
