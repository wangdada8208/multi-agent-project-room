"""Rate limiter for auth endpoints.

Redis-backed sliding-window limiter with an atomic check-and-reserve Lua
script, a bounded in-process fallback, and a circuit breaker that degrades to
that fallback when Redis is unavailable.

The public helpers (:func:`check_rate_limit`, :func:`record_attempt`,
:func:`clear_attempts`) are plain functions that return an awaitable when --
and only when -- their caller awaits them.  FastAPI route handlers therefore
get non-blocking ``redis.asyncio`` I/O, while existing synchronous unit tests
keep calling the same helpers unchanged.
"""

from __future__ import annotations

import asyncio
import bisect
import dis
import inspect
import ipaddress
import logging
import os
import sys
import time
import urllib.parse
import uuid
from collections import OrderedDict
from typing import Any

from fastapi import HTTPException, Request

from app.config import get_settings

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 5
WINDOW_SECONDS = 300  # 5 minutes
BLOCK_SECONDS = 600   # 10 minutes lockout
_REDIS_DISABLE_COOLOFF_SECONDS = 60.0
_REDIS_TIMEOUT_SECONDS = 0.2

# In-process fallback state is bounded so a flood of distinct IPs/accounts can
# never grow the limiter without limit inside a long-lived worker.
MAX_FALLBACK_KEYS = 10000

_KEY_PREFIX = "mapr:ratelimit:"

# Private ranges that ship as the development default.  They are a convenience
# for local/docker development, not a security boundary, so production must opt
# in explicitly through MAPR_TRUSTED_PROXIES before they are honoured.
_DEFAULT_PRIVATE_NETWORKS = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
_TRUSTED_PROXIES_ENV = "MAPR_TRUSTED_PROXIES"

# Circuit breaker states.
_STATE_CLOSED = "closed"
_STATE_OPEN = "open"
_STATE_HALF_OPEN = "half-open"

LUA_CHECK_AND_RESERVE = """
-- Atomic check-and-reserve across one or more (lockout, attempts) key pairs.
--
-- KEYS: lockout_1, attempts_1 [, lockout_2, attempts_2 ...]
-- ARGV: now, window, max_attempts, block_seconds, member
--
-- Returns 0 when the request is allowed (and reserved), 1 when a key is
-- already locked out, and 2 when a key just crossed the threshold (and is now
-- locked out).
--
-- Evaluating the lockout test, the sliding-window trim, the threshold test and
-- the reservation inside one script removes the check-then-record race: two
-- concurrent requests can no longer both observe a below-threshold count.
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max_attempts = tonumber(ARGV[3])
local block_seconds = tonumber(ARGV[4])
local member = ARGV[5]

local pairs_count = #KEYS / 2

for i = 1, pairs_count do
    if redis.call('GET', KEYS[(i - 1) * 2 + 1]) then
        return 1
    end
end

local cutoff = now - window

for i = 1, pairs_count do
    local attempts_key = KEYS[(i - 1) * 2 + 2]
    redis.call('ZREMRANGEBYSCORE', attempts_key, '-inf', cutoff)
    if redis.call('ZCARD', attempts_key) >= max_attempts then
        redis.call('SETEX', KEYS[(i - 1) * 2 + 1], block_seconds, '1')
        return 2
    end
end

for i = 1, pairs_count do
    local attempts_key = KEYS[(i - 1) * 2 + 2]
    redis.call('ZADD', attempts_key, now, member)
    redis.call('EXPIRE', attempts_key, window + block_seconds)
end

return 0
"""

LUA_RELEASE_RESERVATION = """
-- Remove one previously reserved attempt from every given attempts key.
--
-- KEYS: attempts_1 [, attempts_2 ...]
-- ARGV: member
--
-- Used when a login succeeds: the successful attempt should not consume the
-- caller's budget, but the release must still be atomic with respect to
-- concurrent requests on the same key.
local member = ARGV[1]
for i = 1, #KEYS do
    redis.call('ZREM', KEYS[i], member)
end
return 0
"""


# ---------------------------------------------------------------------------
# Bounded in-process fallback state
# ---------------------------------------------------------------------------


def _is_test_environment() -> bool:
    if os.environ.get("MAPR_TESTING") or os.environ.get("MAPR_TEST_REDIS_URL") or os.environ.get("MAPR_TEST_DATABASE_URL"):
        return True
    if os.environ.get("PYTEST_CURRENT_TEST") is not None:
        return True
    if "pytest" in sys.modules:
        return True
    return False


def _get_effective_redis_url() -> str:
    test_url = os.environ.get("MAPR_TEST_REDIS_URL")
    if test_url:
        return test_url
    base_url = get_settings().redis_url
    if _is_test_environment() and not os.environ.get("MAPR_REDIS_URL"):
        test_db = os.environ.get("MAPR_TEST_REDIS_DB", "15")
        parsed = urllib.parse.urlsplit(base_url)
        return urllib.parse.urlunsplit(
            (parsed.scheme, parsed.netloc, f"/{test_db}", parsed.query, parsed.fragment)
        )
    return base_url


def _flush_redis_state() -> None:
    """Drop test-scoped Redis-backed limiter keys.

    Does NOT get called from ``_attempts.clear()`` to prevent accidental
    wiping of shared or production Redis state.
    """
    client = _get_redis_sync()
    if client is None:
        return
    try:
        # Refuse to flush in production unless explicitly forced
        if not _is_test_environment() and not os.environ.get("MAPR_ALLOW_REDIS_FLUSH"):
            return
        prefix = _KEY_PREFIX
        keys = []
        for key in client.scan_iter(match=f"{prefix}*", count=500):
            k_str = key.decode("utf-8", "replace") if isinstance(key, bytes) else str(key)
            if k_str.startswith(prefix):
                keys.append(key)
        if keys:
            client.delete(*keys)
    except Exception:
        _trip_breaker()


class _BoundedLRUDict(OrderedDict):
    """Insertion-ordered mapping that evicts the least recently used key."""

    def __init__(self, max_keys: int = MAX_FALLBACK_KEYS) -> None:
        super().__init__()
        self._max_keys = max(1, int(max_keys))

    def __setitem__(self, key: Any, value: Any) -> None:
        super().__setitem__(key, value)
        self.move_to_end(key)
        self._evict()

    def __getitem__(self, key: Any) -> Any:
        value = super().__getitem__(key)
        self.move_to_end(key)
        return value

    def _evict(self) -> None:
        while len(self) > self._max_keys:
            self.popitem(last=False)

    def clear(self) -> None:
        super().clear()


class BoundedFallbackAttempts(_BoundedLRUDict):
    """Sliding-window timestamps per key, bounded by ``MAX_FALLBACK_KEYS``."""

    def __missing__(self, key: Any) -> list[float]:
        value: list[float] = []
        self[key] = value
        return value


class BoundedBlockedUntil(_BoundedLRUDict):
    """Lockout deadline per key, bounded by ``MAX_FALLBACK_KEYS``."""


_attempts: BoundedFallbackAttempts = BoundedFallbackAttempts()
_blocked_until: BoundedBlockedUntil = BoundedBlockedUntil()


# ---------------------------------------------------------------------------
# Redis clients and circuit breaker
# ---------------------------------------------------------------------------

_redis_sync_client: Any = None
_redis_async_client: Any = None
_redis_async_loop: Any = None
_redis_state: str = _STATE_CLOSED
_redis_opened_at: float = 0.0
_production_proxy_warning_emitted = False


def _set_redis_state(state: str, reason: str = "") -> None:
    global _redis_state
    if state != _redis_state:
        logger.warning("rate limiter Redis circuit breaker: %s -> %s %s", _redis_state, state, reason)
    _redis_state = state


def _trip_breaker() -> None:
    """Open the breaker and drop both clients so the next attempt re-probes."""
    global _redis_sync_client, _redis_async_client, _redis_async_loop, _redis_opened_at
    _redis_sync_client = None
    _redis_async_client = None
    _redis_async_loop = None
    _redis_opened_at = time.time()
    _set_redis_state(_STATE_OPEN, "(Redis unavailable, using in-process fallback)")


async def _trip_breaker_async(client: Any) -> None:
    closer = getattr(client, "aclose", None) or getattr(client, "close", None)
    if closer is not None:
        try:
            await closer()
        except Exception:
            pass
    _trip_breaker()


def _breaker_allows_attempt(now: float) -> bool:
    """False while the breaker is open; flips to half-open once cooled down."""
    if _redis_state == _STATE_OPEN:
        if now - _redis_opened_at < _REDIS_DISABLE_COOLOFF_SECONDS:
            return False
        _set_redis_state(_STATE_HALF_OPEN, "(probing Redis)")
    return True


def _get_redis_sync() -> Any:
    global _redis_sync_client
    if not _breaker_allows_attempt(time.time()):
        return None
    if _redis_sync_client is None:
        try:
            import redis

            client = redis.Redis.from_url(
                _get_effective_redis_url(),
                socket_timeout=_REDIS_TIMEOUT_SECONDS,
                socket_connect_timeout=_REDIS_TIMEOUT_SECONDS,
                decode_responses=True,
            )
            client.ping()
        except Exception:
            _trip_breaker()
            return None
        _redis_sync_client = client
        _set_redis_state(_STATE_CLOSED, "(Redis reachable)")
    return _redis_sync_client


async def _get_redis_async() -> Any:
    global _redis_async_client, _redis_async_loop
    if not _breaker_allows_attempt(time.time()):
        return None
    loop = asyncio.get_running_loop()
    if _redis_async_client is not None and _redis_async_loop is not loop:
        # Connection pools are bound to the loop that created them.  A fresh
        # loop (each test may run in its own) must get a fresh client.
        _redis_async_client = None
        _redis_async_loop = None
    if _redis_async_client is None:
        try:
            import redis.asyncio as redis_asyncio

            client = redis_asyncio.Redis.from_url(
                _get_effective_redis_url(),
                socket_timeout=_REDIS_TIMEOUT_SECONDS,
                socket_connect_timeout=_REDIS_TIMEOUT_SECONDS,
                decode_responses=True,
            )
            await client.ping()
        except Exception:
            _trip_breaker()
            return None
        _redis_async_client = client
        _redis_async_loop = loop
        _set_redis_state(_STATE_CLOSED, "(Redis reachable)")
    return _redis_async_client


# ---------------------------------------------------------------------------
# Trusted proxies and client IP resolution
# ---------------------------------------------------------------------------


def _is_production() -> bool:
    env = (get_settings().environment or "").strip().lower()
    return env not in ("development", "test", "testing", "dev")


def _effective_trusted_proxies() -> list[str]:
    """Trusted proxy list, with the development private-range default removed.

    The shipped default trusts every private subnet, which is fine for local
    development but would let any host on the internal network spoof
    ``X-Forwarded-For``.  In production the private ranges are dropped unless
    the operator opts in explicitly through ``MAPR_TRUSTED_PROXIES``.
    """
    global _production_proxy_warning_emitted
    configured = list(getattr(get_settings(), "trusted_proxies", []) or [])
    if not _is_production():
        return configured
    if os.environ.get(_TRUSTED_PROXIES_ENV):
        return configured
    if not _production_proxy_warning_emitted:
        _production_proxy_warning_emitted = True
        logger.warning(
            "MAPR_TRUSTED_PROXIES is not set; only loopback is trusted for "
            "X-Forwarded-For. Set it to the reverse proxy subnet or client IP "
            "resolution will collapse to the proxy address."
        )
    return [proxy for proxy in configured if proxy not in _DEFAULT_PRIVATE_NETWORKS]


def _is_trusted_proxy(client_host: str) -> bool:
    trusted = _effective_trusted_proxies()
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
    """Resolve the client address, walking ``X-Forwarded-For`` right to left.

    Only a directly connected trusted proxy may contribute the header, and the
    rightmost untrusted hop wins -- that is the address the last trusted proxy
    actually observed.  Reading the leftmost entry instead would let any client
    prepend a forged address of its choosing.
    """
    client_host = request.client.host if request.client else "unknown"
    forwarded = request.headers.get("X-Forwarded-For")
    if not forwarded or not _is_trusted_proxy(client_host):
        return client_host
    hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
    if not hops:
        return client_host
    for hop in reversed(hops):
        if not _is_trusted_proxy(hop):
            return hop
    # Every hop is a trusted proxy; the leftmost entry is the origin.
    return hops[0]


# ---------------------------------------------------------------------------
# Await detection (dual async/sync dispatch)
# ---------------------------------------------------------------------------

_CODE_INSTRUCTIONS_CACHE: dict[Any, list[tuple[int, str]]] = {}
_CODE_INSTRUCTIONS_CACHE_LIMIT = 512


def _caller_is_awaiting() -> bool:
    """True when the caller of a public helper awaits the returned value.

    The public helpers call this directly, so the frame that matters is two
    levels up (this function -> public helper -> caller).  When the caller
    awaits, the bytecode immediately after the call is ``GET_AWAITABLE`` or
    ``SEND``; otherwise the call was made synchronously.
    """
    frame = inspect.currentframe()
    try:
        if frame is None or frame.f_back is None or frame.f_back.f_back is None:
            return False
        caller = frame.f_back.f_back
        code = caller.f_code
        instructions = _CODE_INSTRUCTIONS_CACHE.get(code)
        if instructions is None:
            instructions = [
                (instruction.offset, instruction.opname)
                for instruction in dis.get_instructions(code)
                if not instruction.opname.startswith("CACHE")
            ]
            if len(_CODE_INSTRUCTIONS_CACHE) >= _CODE_INSTRUCTIONS_CACHE_LIMIT:
                _CODE_INSTRUCTIONS_CACHE.clear()
            _CODE_INSTRUCTIONS_CACHE[code] = instructions
        # Sorts after any real opname, so bisect lands on the first instruction
        # strictly after the call site.
        index = bisect.bisect_right(instructions, (caller.f_lasti, "￿"))
        if index >= len(instructions):
            return False
        return instructions[index][1] in ("GET_AWAITABLE", "SEND")
    except Exception:
        return False
    finally:
        del frame


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _rate_limit_keys(endpoint: str, ip: str, identifier: str | None) -> list[str]:
    keys = [f"{endpoint}:ip:{ip}"]
    if identifier:
        keys.append(f"{endpoint}:acc:{identifier.strip().casefold()}")
    return keys


def _redis_key_args(keys: list[str]) -> list[str]:
    """Flatten keys into the (lockout, attempts) pairs the Lua script expects."""
    args: list[str] = []
    for key in keys:
        args.append(f"{_KEY_PREFIX}lockout:{key}")
        args.append(f"{_KEY_PREFIX}attempts:{key}")
    return args


def _unique_member(now: float) -> str:
    """Build a ZSET member that stays unique under identical timestamps.

    Two requests can land in the same ``time.time()`` tick, and identical
    members would overwrite each other in the sorted set -- silently
    undercounting the window.  Monotonic nanoseconds plus random entropy keep
    every reservation distinct.
    """
    return f"{now}:{time.monotonic_ns()}:{uuid.uuid4().hex[:12]}"


def _raise_for_result(result: Any) -> None:
    if result == 1:
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")
    if result == 2:
        raise HTTPException(status_code=429, detail="Too many failed attempts. Locked for 10 minutes.")


def _fallback_check_and_reserve(keys: list[str], now: float, member: str) -> None:
    for key in keys:
        if now < _blocked_until.get(key, 0.0):
            raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")

    cutoff = now - WINDOW_SECONDS
    for key in keys:
        entries = _attempts.get(key)
        if entries:
            _attempts[key] = [stamp for stamp in entries if stamp > cutoff]

    for key in keys:
        if len(_attempts.get(key, [])) >= MAX_ATTEMPTS:
            _blocked_until[key] = now + BLOCK_SECONDS
            raise HTTPException(
                status_code=429,
                detail="Too many failed attempts. Locked for 10 minutes.",
            )

    for key in keys:
        _attempts[key].append(now)


def _fallback_record(keys: list[str], now: float) -> None:
    for key in keys:
        _attempts[key].append(now)


def _fallback_release(keys: list[str], now: float) -> None:
    """Drop the most recent reservation for each key.

    The in-process fallback stores bare timestamps rather than unique members,
    so the reservation to undo is the one just made -- the newest entry.
    """
    for key in keys:
        entries = _attempts.get(key)
        if not entries:
            continue
        for index in range(len(entries) - 1, -1, -1):
            if entries[index] == now:
                del entries[index]
                break
        if not entries:
            _attempts.pop(key, None)


def _fallback_clear(keys: list[str]) -> None:
    for key in keys:
        _attempts.pop(key, None)
        _blocked_until.pop(key, None)


class _Reservation:
    """Handle for the attempt reserved by :func:`check_rate_limit`.

    A caller that decides the attempt was legitimate (a valid login) can undo
    exactly that one reservation, leaving any earlier failures -- and therefore
    the attack record -- intact.
    """

    __slots__ = ("keys", "now", "member", "in_redis")

    def __init__(self, keys: list[str], now: float, member: str, in_redis: bool) -> None:
        self.keys = keys
        self.now = now
        self.member = member
        self.in_redis = in_redis

    def _redis_attempts_keys(self) -> list[str]:
        return [f"{_KEY_PREFIX}attempts:{key}" for key in self.keys]

    def release_sync(self) -> None:
        if self.in_redis:
            client = _get_redis_sync()
            if client is not None:
                try:
                    client.eval(
                        LUA_RELEASE_RESERVATION,
                        len(self.keys),
                        *self._redis_attempts_keys(),
                        self.member,
                    )
                except Exception:
                    _trip_breaker()
                else:
                    return
        _fallback_release(self.keys, self.now)

    async def release(self) -> None:
        if self.in_redis:
            client = await _get_redis_async()
            if client is not None:
                try:
                    await client.eval(
                        LUA_RELEASE_RESERVATION,
                        len(self.keys),
                        *self._redis_attempts_keys(),
                        self.member,
                    )
                except Exception:
                    await _trip_breaker_async(client)
                else:
                    return
        _fallback_release(self.keys, self.now)


# ---------------------------------------------------------------------------
# check_rate_limit
# ---------------------------------------------------------------------------


def _check_rate_limit_sync(
    request: Request, endpoint: str, identifier: str | None
) -> "_Reservation":
    ip = _client_ip(request)
    keys = _rate_limit_keys(endpoint, ip, identifier)
    now = time.time()
    member = _unique_member(now)

    client = _get_redis_sync()
    if client is not None:
        try:
            result = client.eval(
                LUA_CHECK_AND_RESERVE,
                len(keys) * 2,
                *_redis_key_args(keys),
                str(now),
                str(WINDOW_SECONDS),
                str(MAX_ATTEMPTS),
                str(BLOCK_SECONDS),
                member,
            )
        except HTTPException:
            raise
        except Exception:
            _trip_breaker()
        else:
            _raise_for_result(result)
            return _Reservation(keys, now, member, True)

    _fallback_check_and_reserve(keys, now, member)
    return _Reservation(keys, now, member, False)


async def _check_rate_limit_async(
    request: Request, endpoint: str, identifier: str | None
) -> "_Reservation":
    ip = _client_ip(request)
    keys = _rate_limit_keys(endpoint, ip, identifier)
    now = time.time()
    member = _unique_member(now)

    client = await _get_redis_async()
    if client is not None:
        try:
            result = await client.eval(
                LUA_CHECK_AND_RESERVE,
                len(keys) * 2,
                *_redis_key_args(keys),
                str(now),
                str(WINDOW_SECONDS),
                str(MAX_ATTEMPTS),
                str(BLOCK_SECONDS),
                member,
            )
        except HTTPException:
            raise
        except Exception:
            await _trip_breaker_async(client)
        else:
            _raise_for_result(result)
            return _Reservation(keys, now, member, True)

    _fallback_check_and_reserve(keys, now, member)
    return _Reservation(keys, now, member, False)


def check_rate_limit(
    request: Request,
    endpoint: str,
    identifier: str | None = None,
) -> Any:
    """Atomically check the limit and reserve one attempt.

    Raises ``HTTPException(429)`` when this IP or account is over the limit.
    On success the attempt is already counted, so callers must not record it
    again; a caller that later decides the attempt was a success (a valid
    login) can undo the reservation through the returned handle.

    Returns an awaitable when the caller awaits it (FastAPI route handlers, so
    the Redis I/O never blocks the event loop) and the handle directly
    otherwise, so existing synchronous callers keep working.
    """
    if _caller_is_awaiting():
        return _check_rate_limit_async(request, endpoint, identifier)
    return _check_rate_limit_sync(request, endpoint, identifier)


# ---------------------------------------------------------------------------
# record_attempt
# ---------------------------------------------------------------------------


def _record_attempt_sync(request: Request, endpoint: str, identifier: str | None) -> None:
    ip = _client_ip(request)
    keys = _rate_limit_keys(endpoint, ip, identifier)
    now = time.time()

    client = _get_redis_sync()
    if client is not None:
        try:
            client.eval(
                LUA_CHECK_AND_RESERVE,
                len(keys) * 2,
                *_redis_key_args(keys),
                str(now),
                str(WINDOW_SECONDS),
                str(MAX_ATTEMPTS),
                str(BLOCK_SECONDS),
                _unique_member(now),
            )
        except Exception:
            _trip_breaker()

    # The in-process mirror is always updated, even when Redis served the write,
    # so the fallback stays coherent if Redis disappears mid-window.
    _fallback_record(keys, now)


async def _record_attempt_async(request: Request, endpoint: str, identifier: str | None) -> None:
    ip = _client_ip(request)
    keys = _rate_limit_keys(endpoint, ip, identifier)
    now = time.time()

    client = await _get_redis_async()
    if client is not None:
        try:
            await client.eval(
                LUA_CHECK_AND_RESERVE,
                len(keys) * 2,
                *_redis_key_args(keys),
                str(now),
                str(WINDOW_SECONDS),
                str(MAX_ATTEMPTS),
                str(BLOCK_SECONDS),
                _unique_member(now),
            )
        except Exception:
            await _trip_breaker_async(client)

    # The in-process mirror is always updated, even when Redis served the write,
    # so the fallback stays coherent if Redis disappears mid-window.
    _fallback_record(keys, now)


def record_attempt(request: Request, endpoint: str, identifier: str | None = None) -> Any:
    """Count one attempt and lock the key out once the threshold is reached."""
    if _caller_is_awaiting():
        return _record_attempt_async(request, endpoint, identifier)
    return _record_attempt_sync(request, endpoint, identifier)


# ---------------------------------------------------------------------------
# clear_attempts
# ---------------------------------------------------------------------------


def _clear_attempts_sync(request: Request, endpoint: str, identifier: str | None) -> None:
    if identifier:
        keys = [f"{endpoint}:acc:{identifier.strip().casefold()}"]
    else:
        keys = [f"{endpoint}:ip:{_client_ip(request)}"]

    client = _get_redis_sync()
    if client is not None:
        try:
            for key in keys:
                client.delete(
                    f"{_KEY_PREFIX}lockout:{key}",
                    f"{_KEY_PREFIX}attempts:{key}",
                )
        except Exception:
            _trip_breaker()

    _fallback_clear(keys)


async def _clear_attempts_async(request: Request, endpoint: str, identifier: str | None) -> None:
    if identifier:
        keys = [f"{endpoint}:acc:{identifier.strip().casefold()}"]
    else:
        keys = [f"{endpoint}:ip:{_client_ip(request)}"]

    client = await _get_redis_async()
    if client is not None:
        try:
            for key in keys:
                await client.delete(
                    f"{_KEY_PREFIX}lockout:{key}",
                    f"{_KEY_PREFIX}attempts:{key}",
                )
        except Exception:
            await _trip_breaker_async(client)

    _fallback_clear(keys)


def clear_attempts(request: Request, endpoint: str, identifier: str | None = None) -> Any:
    """Clear the failure record for a successful authentication.

    With an identifier only the *account* key is cleared, never the IP key: an
    attacker who owns any valid account must not be able to wipe the IP-level
    attack record by logging in successfully.
    """
    if _caller_is_awaiting():
        return _clear_attempts_async(request, endpoint, identifier)
    return _clear_attempts_sync(request, endpoint, identifier)
