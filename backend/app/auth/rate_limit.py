"""Rate limiter for auth endpoints with Redis-backed sliding window and in-memory fallback."""

from __future__ import annotations

import ipaddress
import time
from collections import defaultdict
from typing import Any
from fastapi import HTTPException, Request

from app.config import get_settings

MAX_ATTEMPTS = 5
WINDOW_SECONDS = 300  # 5 minutes
BLOCK_SECONDS = 600   # 10 minutes lockout
_REDIS_DISABLE_COOLOFF_SECONDS = 60.0

LUA_CHECK_RATE_LIMIT = """
local lockout_key = KEYS[1]
local attempts_key = KEYS[2]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max_attempts = tonumber(ARGV[3])
local block_seconds = tonumber(ARGV[4])

local is_locked = redis.call('GET', lockout_key)
if is_locked then
    return 1
end

local cutoff = now - window
redis.call('ZREMRANGEBYSCORE', attempts_key, '-inf', cutoff)
local count = redis.call('ZCARD', attempts_key)
if count >= max_attempts then
    redis.call('SETEX', lockout_key, block_seconds, '1')
    return 2
end
return 0
"""

LUA_RECORD_ATTEMPT = """
local attempts_key = KEYS[1]
local lockout_key = KEYS[2]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max_attempts = tonumber(ARGV[3])
local block_seconds = tonumber(ARGV[4])

redis.call('ZADD', attempts_key, now, tostring(now))
redis.call('EXPIRE', attempts_key, window + block_seconds)

local cutoff = now - window
redis.call('ZREMRANGEBYSCORE', attempts_key, '-inf', cutoff)
local count = redis.call('ZCARD', attempts_key)
if count >= max_attempts then
    redis.call('SETEX', lockout_key, block_seconds, '1')
    return 1
end
return 0
"""

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


def _is_trusted_proxy(client_host: str) -> bool:
    settings = get_settings()
    trusted = getattr(
        settings,
        "trusted_proxies",
        ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    )
    if client_host in trusted:
        return True
    try:
        host_ip = ipaddress.ip_address(client_host)
    except ValueError:
        return False
    for proxy in trusted:
        try:
            if "/" in proxy:
                if host_ip in ipaddress.ip_network(proxy, strict=False):
                    return True
            elif host_ip == ipaddress.ip_address(proxy):
                return True
        except ValueError:
            continue
    return False


def _client_ip(request: Request) -> str:
    client_host = request.client.host if request.client else "unknown"
    if not _is_trusted_proxy(client_host):
        return client_host
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        if parts:
            return parts[0]
    return client_host


def check_rate_limit(request: Request, endpoint: str, identifier: str | None = None) -> None:
    """Raise 429 if this IP or account has exceeded the attempt limit."""
    ip = _client_ip(request)
    now = time.time()

    keys_to_check = [f"{endpoint}:ip:{ip}"]
    if identifier:
        keys_to_check.append(f"{endpoint}:acc:{identifier.strip().casefold()}")

    r = _get_redis()
    if r is not None:
        try:
            for k in keys_to_check:
                lockout_key = f"mapr:ratelimit:lockout:{k}"
                attempts_key = f"mapr:ratelimit:attempts:{k}"
                res = r.eval(
                    LUA_CHECK_RATE_LIMIT,
                    2,
                    lockout_key,
                    attempts_key,
                    str(now),
                    str(WINDOW_SECONDS),
                    str(MAX_ATTEMPTS),
                    str(BLOCK_SECONDS),
                )
                if res == 1:
                    raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")
                elif res == 2:
                    raise HTTPException(status_code=429, detail="Too many failed attempts. Locked for 10 minutes.")
            return
        except HTTPException:
            raise
        except Exception:
            _disable_redis()

    # Fallback to in-memory limiter
    for k in keys_to_check:
        blocked_until = _blocked_until.get(k, 0)
        if now < blocked_until:
            raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")

        cutoff = now - WINDOW_SECONDS
        _attempts[k] = [t for t in _attempts.get(k, []) if t > cutoff]

        if len(_attempts[k]) >= MAX_ATTEMPTS:
            _blocked_until[k] = now + BLOCK_SECONDS
            raise HTTPException(status_code=429, detail="Too many failed attempts. Locked for 10 minutes.")


def record_attempt(request: Request, endpoint: str, identifier: str | None = None) -> None:
    ip = _client_ip(request)
    now = time.time()

    keys_to_record = [f"{endpoint}:ip:{ip}"]
    if identifier:
        keys_to_record.append(f"{endpoint}:acc:{identifier.strip().casefold()}")

    r = _get_redis()
    if r is not None:
        try:
            for k in keys_to_record:
                lockout_key = f"mapr:ratelimit:lockout:{k}"
                attempts_key = f"mapr:ratelimit:attempts:{k}"
                r.eval(
                    LUA_RECORD_ATTEMPT,
                    2,
                    attempts_key,
                    lockout_key,
                    str(now),
                    str(WINDOW_SECONDS),
                    str(MAX_ATTEMPTS),
                    str(BLOCK_SECONDS),
                )
        except Exception:
            _disable_redis()

    for k in keys_to_record:
        _attempts[k].append(now)


def clear_attempts(request: Request, endpoint: str, identifier: str | None = None) -> None:
    """Clear attempts on successful auth.

    When identifier is present, clear ONLY the account key to prevent an attacker
    from wiping their IP failure records by logging into a valid account.
    """
    if identifier:
        keys_to_clear = [f"{endpoint}:acc:{identifier.strip().casefold()}"]
    else:
        ip = _client_ip(request)
        keys_to_clear = [f"{endpoint}:ip:{ip}"]

    r = _get_redis()
    if r is not None:
        try:
            for k in keys_to_clear:
                lockout_key = f"mapr:ratelimit:lockout:{k}"
                attempts_key = f"mapr:ratelimit:attempts:{k}"
                r.delete(lockout_key, attempts_key)
        except Exception:
            _disable_redis()

    for k in keys_to_clear:
        _attempts.pop(k, None)
        _blocked_until.pop(k, None)
