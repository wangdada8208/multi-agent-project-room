"""Simple in-memory rate limiter for auth endpoints.

Production should use Redis-backed rate limiting for multi-instance deployments.
"""

from __future__ import annotations

import time
from collections import defaultdict
from fastapi import HTTPException, Request

MAX_ATTEMPTS = 5
WINDOW_SECONDS = 300  # 5 minutes
BLOCK_SECONDS = 600   # 10 minutes lockout

_attempts: dict[str, list[float]] = defaultdict(list)
_blocked_until: dict[str, float] = {}


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_rate_limit(request: Request, endpoint: str) -> None:
    """Raise 429 if this IP has exceeded the attempt limit."""
    key = f"{endpoint}:{_client_ip(request)}"
    now = time.time()

    # Check block
    blocked_until = _blocked_until.get(key, 0)
    if now < blocked_until:
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")

    # Clean old entries
    cutoff = now - WINDOW_SECONDS
    _attempts[key] = [t for t in _attempts.get(key, []) if t > cutoff]

    # Check count
    if len(_attempts[key]) >= MAX_ATTEMPTS:
        _blocked_until[key] = now + BLOCK_SECONDS
        raise HTTPException(status_code=429, detail="Too many failed attempts. Locked for 10 minutes.")


def record_attempt(request: Request, endpoint: str) -> None:
    key = f"{endpoint}:{_client_ip(request)}"
    _attempts[key].append(time.time())


def clear_attempts(request: Request, endpoint: str) -> None:
    """Clear attempts on successful auth."""
    key = f"{endpoint}:{_client_ip(request)}"
    _attempts.pop(key, None)
    _blocked_until.pop(key, None)
