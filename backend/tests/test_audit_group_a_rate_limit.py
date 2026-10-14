"""Group A audit remediation: authentication rate limiting and reverse proxy safety.

Covers the four required verification areas:

1. Real-Redis concurrency stress (burst arrivals on identical timestamps).
2. Circuit-breaker degradation to the in-process fallback and recovery.
3. ``X-Forwarded-For`` spoofing resistance and production proxy trust.
4. Volumetric rate limiting on every registration attempt.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from httpx import AsyncClient

from app.auth import rate_limit
from app.auth.rate_limit import (
    BLOCK_SECONDS,
    LUA_CHECK_AND_RESERVE,
    LUA_RELEASE_RESERVATION,
    MAX_ATTEMPTS,
    MAX_FALLBACK_KEYS,
    WINDOW_SECONDS,
    BoundedBlockedUntil,
    BoundedFallbackAttempts,
    _client_ip,
    _effective_trusted_proxies,
    _is_trusted_proxy,
    _unique_member,
    check_rate_limit,
    clear_attempts,
    record_attempt,
)
from app.config import get_settings


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


def _request(host: str, forwarded: str | None = None) -> MagicMock:
    request = MagicMock()
    request.client.host = host
    request.headers.get.return_value = forwarded
    return request


def _redis_is_available() -> bool:
    client = rate_limit._get_redis_sync()
    return client is not None


requires_redis = pytest.mark.skipif(
    not _redis_is_available(),
    reason="real Redis is required for this concurrency test",
)


@pytest.fixture(autouse=True)
def reset_limiter():
    """Give every test a clean limiter, in-process and in Redis."""
    rate_limit._redis_state = rate_limit._STATE_CLOSED
    rate_limit._redis_opened_at = 0.0
    rate_limit._redis_sync_client = None
    rate_limit._redis_async_client = None
    rate_limit._redis_async_loop = None
    rate_limit._attempts.clear()
    rate_limit._blocked_until.clear()
    yield
    rate_limit._attempts.clear()
    rate_limit._blocked_until.clear()


# ===========================================================================
# 1. Real Redis concurrency: identical-timestamp burst
# ===========================================================================


@pytest.mark.asyncio
@requires_redis
async def test_concurrent_burst_is_counted_exactly_once_per_request():
    """N simultaneous reservations must produce exactly N distinct members.

    Before the fix the limiter checked the count and then recorded the attempt
    in two separate round trips, and identical ZSET members collapsed into one
    entry.  Both effects let a burst slip past the threshold.  Here the burst
    arrives with one frozen timestamp, so only the atomic script plus unique
    members can keep the accounting honest.
    """
    client = rate_limit._get_redis_sync()
    key = "burst:ip:203.0.113.7"
    attempts_key = f"mapr:ratelimit:attempts:{key}"
    lockout_key = f"mapr:ratelimit:lockout:{key}"
    client.delete(attempts_key, lockout_key)

    frozen = time.time()
    members = [_unique_member(frozen) for _ in range(50)]
    assert len(set(members)) == 50, "members must stay unique at one timestamp"

    burst = 200
    script = client.register_script(LUA_CHECK_AND_RESERVE)
    results = []
    for _ in range(burst):
        results.append(
            script(
                keys=[lockout_key, attempts_key],
                args=[
                    str(frozen),
                    str(WINDOW_SECONDS),
                    str(MAX_ATTEMPTS),
                    str(BLOCK_SECONDS),
                    _unique_member(frozen),
                ],
                client=client,
            )
        )

    assert results.count(0) == MAX_ATTEMPTS, "exactly the threshold may be admitted"
    assert all(result in (0, 1, 2) for result in results)
    assert client.zcard(attempts_key) == MAX_ATTEMPTS, "no reservation may be lost or double counted"
    assert client.exists(lockout_key) == 1

    client.delete(attempts_key, lockout_key)


@pytest.mark.asyncio
@requires_redis
async def test_concurrent_api_burst_rejects_beyond_threshold(client: AsyncClient):
    """Concurrent HTTP logins cannot jointly exceed the threshold."""
    username = "burstuser"
    await client.post(
        "/api/v1/auth/register",
        json={"username": username, "password": "secret123", "display_name": "Burst"},
    )
    # Registration reserved one attempt for this IP; reset so the burst starts clean.
    rate_limit._attempts.clear()
    rate_limit._blocked_until.clear()
    redis = rate_limit._get_redis_sync()
    for key in redis.scan_iter(match="mapr:ratelimit:*"):
        redis.delete(key)

    responses = await asyncio.gather(*[
        client.post("/api/v1/auth/login", json={"username": username, "password": "wrong-password"})
        for _ in range(40)
    ])
    codes = [response.status_code for response in responses]
    assert codes.count(401) <= MAX_ATTEMPTS, f"too many attempts admitted: {codes}"
    assert 429 in codes, f"burst never tripped the limiter: {codes}"


@pytest.mark.asyncio
@requires_redis
async def test_successful_login_keeps_ip_attack_record(client: AsyncClient):
    """A valid login must not erase the IP-level attack record.

    The account key is cleared (the user proved ownership) but the IP key keeps
    the failures, so an attacker with any valid account cannot whitewash the
    trail left by their guessing.
    """
    victim = "victimuser"
    attacker = "attackeruser"
    await client.post(
        "/api/v1/auth/register",
        json={"username": victim, "password": "secret123", "display_name": "Victim"},
    )
    await client.post(
        "/api/v1/auth/register",
        json={"username": attacker, "password": "secret123", "display_name": "Attacker"},
    )
    redis = rate_limit._get_redis_sync()
    for key in redis.scan_iter(match="mapr:ratelimit:*"):
        redis.delete(key)
    rate_limit._attempts.clear()
    rate_limit._blocked_until.clear()

    # Four failed guesses against the victim, from the shared test client IP.
    for _ in range(MAX_ATTEMPTS - 1):
        response = await client.post(
            "/api/v1/auth/login", json={"username": victim, "password": "nope"}
        )
        assert response.status_code == 401

    # Attacker now logs into their OWN valid account successfully.
    ok = await client.post(
        "/api/v1/auth/login", json={"username": attacker, "password": "secret123"}
    )
    assert ok.status_code == 200

    # The IP still carries the four failures: one more failed guess locks out.
    last = await client.post("/api/v1/auth/login", json={"username": victim, "password": "nope"})
    assert last.status_code == 401
    blocked = await client.post("/api/v1/auth/login", json={"username": victim, "password": "nope"})
    assert blocked.status_code == 429, "successful login wrongly cleared the IP attack record"


@pytest.mark.asyncio
@requires_redis
async def test_successful_login_does_not_consume_ip_budget(client: AsyncClient):
    """A correct password releases its own reservation, not the whole window."""
    username = "budgetuser"
    await client.post(
        "/api/v1/auth/register",
        json={"username": username, "password": "secret123", "display_name": "Budget"},
    )
    redis = rate_limit._get_redis_sync()
    for key in redis.scan_iter(match="mapr:ratelimit:*"):
        redis.delete(key)
    rate_limit._attempts.clear()
    rate_limit._blocked_until.clear()

    for _ in range(MAX_ATTEMPTS):
        response = await client.post(
            "/api/v1/auth/login", json={"username": username, "password": "secret123"}
        )
        assert response.status_code == 200, "a valid login must never be limited by its own success"


# ===========================================================================
# 2. Circuit breaker: degradation and recovery
# ===========================================================================


def test_circuit_breaker_degrades_to_fallback(monkeypatch):
    """Redis failures must degrade to the in-process limiter, not raise."""
    failing = MagicMock()
    failing.eval.side_effect = ConnectionError("synthetic Redis outage")
    monkeypatch.setattr(rate_limit, "_get_redis_sync", lambda: failing)

    request = _request("198.51.100.10")
    # Each reservation is atomic, so the 5th succeeds and the 6th is refused.
    for _ in range(MAX_ATTEMPTS):
        check_rate_limit(request, "login", identifier="victim")

    assert rate_limit._redis_state == rate_limit._STATE_OPEN
    assert len(rate_limit._attempts["login:ip:198.51.100.10"]) == MAX_ATTEMPTS

    with pytest.raises(HTTPException) as exc:
        check_rate_limit(request, "login", identifier="victim")
    assert exc.value.status_code == 429


def test_circuit_breaker_reopens_after_cooldown(monkeypatch):
    """Once the cool-off elapses the breaker half-opens and probes Redis."""
    rate_limit._trip_breaker()
    assert rate_limit._redis_state == rate_limit._STATE_OPEN
    assert rate_limit._get_redis_sync() is None, "must not probe while open"

    # Simulate the cool-off elapsing.
    rate_limit._redis_opened_at = time.time() - rate_limit._REDIS_DISABLE_COOLOFF_SECONDS - 1
    assert rate_limit._breaker_allows_attempt(time.time()) is True
    assert rate_limit._redis_state == rate_limit._STATE_HALF_OPEN

    probe = MagicMock()
    probe.ping.return_value = True
    import redis as redis_module

    monkeypatch.setattr(redis_module.Redis, "from_url", lambda *a, **k: probe)

    recovered = rate_limit._get_redis_sync()
    assert recovered is probe
    assert rate_limit._redis_state == rate_limit._STATE_CLOSED


def test_fallback_counter_is_bounded():
    """The fallback map must evict instead of growing without limit."""
    attempts = BoundedFallbackAttempts(max_keys=16)
    blocked = BoundedBlockedUntil(max_keys=16)
    for index in range(100):
        attempts[f"key-{index}"] = [float(index)]
        blocked[f"key-{index}"] = float(index)

    assert len(attempts) == 16, "fallback attempts must stay bounded"
    assert len(blocked) == 16, "fallback lockouts must stay bounded"
    assert "key-99" in attempts, "the most recent key must survive eviction"
    assert "key-0" not in attempts, "the least recently used key must be evicted"

    # The default bound is the documented constant.
    assert BoundedFallbackAttempts()._max_keys == MAX_FALLBACK_KEYS


def test_fallback_eviction_does_not_raise_on_lookup():
    """An evicted key simply restarts its window rather than erroring."""
    attempts = BoundedFallbackAttempts(max_keys=2)
    attempts["a"] = [1.0]
    attempts["b"] = [2.0]
    attempts["c"] = [3.0]
    assert len(attempts) == 2
    # Missing keys must materialise empty windows, not KeyError.
    assert list(attempts["missing"]) == []


# ===========================================================================
# 3. Trusted proxy and X-Forwarded-For spoofing
# ===========================================================================


def test_forwarded_for_is_read_right_to_left():
    """The rightmost untrusted hop wins; a prepended forgery is ignored."""
    request = _request("172.18.0.2", "1.2.3.4, 203.0.113.9, 172.18.0.2")
    # The client prepended "1.2.3.4"; the proxy chain really observed .9.
    assert _client_ip(request) == "203.0.113.9"


def test_forwarded_for_ignored_from_untrusted_peer():
    """An untrusted direct peer cannot influence its own resolved address."""
    request = _request("198.51.100.22", "10.0.0.5")
    assert _client_ip(request) == "198.51.100.22"


def test_all_trusted_hops_fall_back_to_leftmost():
    request = _request("172.18.0.2", "203.0.113.9, 172.18.0.3")
    assert _client_ip(request) == "203.0.113.9"


def test_malformed_forwarded_for_is_ignored():
    request = _request("172.18.0.2", " , , ")
    assert _client_ip(request) == "172.18.0.2"


def test_production_drops_default_private_networks(monkeypatch):
    """Production must not trust whole private subnets by default."""
    monkeypatch.delenv("MAPR_TRUSTED_PROXIES", raising=False)
    monkeypatch.setattr(
        rate_limit,
        "get_settings",
        lambda: SimpleNamespace(
            environment="production",
            trusted_proxies=["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
        ),
    )
    rate_limit._production_proxy_warning_emitted = False

    effective = _effective_trusted_proxies()
    assert "10.0.0.0/8" not in effective
    assert "172.16.0.0/12" not in effective
    assert "192.168.0.0/16" not in effective
    assert "127.0.0.1" in effective
    assert _is_trusted_proxy("10.5.2.1") is False


def test_production_honours_explicit_trusted_proxies(monkeypatch):
    """An operator that names its proxy subnet keeps it trusted."""
    monkeypatch.setenv("MAPR_TRUSTED_PROXIES", "172.16.0.0/12")
    monkeypatch.setattr(
        rate_limit,
        "get_settings",
        lambda: SimpleNamespace(
            environment="production",
            trusted_proxies=["127.0.0.1", "172.16.0.0/12"],
        ),
    )
    assert _is_trusted_proxy("172.18.0.4") is True


def test_development_keeps_private_network_default(monkeypatch):
    """Local development still works out of the box behind docker."""
    monkeypatch.delenv("MAPR_TRUSTED_PROXIES", raising=False)
    monkeypatch.setattr(
        rate_limit,
        "get_settings",
        lambda: SimpleNamespace(
            environment="development",
            trusted_proxies=["127.0.0.1", "10.0.0.0/8"],
        ),
    )
    assert _is_trusted_proxy("10.5.2.1") is True


@pytest.mark.asyncio
async def test_spoofed_header_cannot_dodge_the_ip_limit(client: AsyncClient):
    """Rotating a forged X-Forwarded-For must not buy fresh attempts."""
    redis = rate_limit._get_redis_sync()
    for key in redis.scan_iter(match="mapr:ratelimit:*"):
        redis.delete(key)
    rate_limit._attempts.clear()
    rate_limit._blocked_until.clear()

    codes = []
    for index in range(MAX_ATTEMPTS + 3):
        response = await client.post(
            "/api/v1/auth/login",
            json={"username": "ghost", "password": "nope"},
            headers={"X-Forwarded-For": f"1.2.3.{index}"},
        )
        codes.append(response.status_code)

    assert 429 in codes, f"forged X-Forwarded-For defeated the IP limit: {codes}"


# ===========================================================================
# 4. Volumetric registration limiting
# ===========================================================================


@pytest.mark.asyncio
async def test_every_registration_attempt_counts(client: AsyncClient):
    """Successful registrations are rate limited too, not only failures."""
    codes = []
    for index in range(MAX_ATTEMPTS + 2):
        response = await client.post(
            "/api/v1/auth/register",
            json={
                "username": f"bulkuser{index}",
                "password": "secret123",
                "display_name": f"Bulk {index}",
            },
        )
        codes.append(response.status_code)

    assert codes[:MAX_ATTEMPTS] == [200] * MAX_ATTEMPTS, codes
    assert codes[MAX_ATTEMPTS] == 429, f"successful registrations escaped the limit: {codes}"


@pytest.mark.asyncio
async def test_failed_registration_still_counts(client: AsyncClient):
    """Denied agent enrollment attempts keep consuming the budget."""
    for _ in range(MAX_ATTEMPTS):
        response = await client.post(
            "/api/v1/auth/register",
            json={
                "username": "agent_bot",
                "password": "secret123",
                "display_name": "Agent",
                "user_type": "agent",
            },
            headers={"X-Agent-Enrollment-Key": "wrong-secret"},
        )
        assert response.status_code == 403

    blocked = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "agent_bot",
            "password": "secret123",
            "display_name": "Agent",
            "user_type": "agent",
        },
    )
    assert blocked.status_code == 429


@pytest.mark.asyncio
async def test_registration_attempt_is_not_erased_by_success(client: AsyncClient):
    """The reservation survives a 200, so bulk account creation stays capped."""
    first = await client.post(
        "/api/v1/auth/register",
        json={"username": "survivor", "password": "secret123", "display_name": "Survivor"},
    )
    assert first.status_code == 200

    redis = rate_limit._get_redis_sync()
    ip_key = next(
        key for key in redis.scan_iter(match="mapr:ratelimit:attempts:register:ip:*")
    )
    assert redis.zcard(ip_key) == 1, "a successful registration must still leave its reservation"


# ===========================================================================
# 5. Await detection and async/sync parity
# ===========================================================================


def test_sync_callers_do_not_leak_coroutines():
    """A synchronous caller must get the sync path, never a dropped coroutine."""
    request = _request("203.0.113.77")

    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("error", RuntimeWarning)
        check_rate_limit(request, "login", identifier="sync-caller")
        record_attempt(request, "login", identifier="sync-caller")
        clear_attempts(request, "login", identifier="sync-caller")


@pytest.mark.asyncio
async def test_awaited_calls_use_the_async_path():
    """An awaiting caller gets a reservation handle it can release."""
    request = _request("203.0.113.78")
    reservation = await check_rate_limit(request, "login", identifier="releaser")
    assert reservation is not None
    await reservation.release()


def test_script_constants_are_wellformed():
    assert "ZCARD" in LUA_CHECK_AND_RESERVE
    assert "ZADD" in LUA_CHECK_AND_RESERVE
    assert "SETEX" in LUA_CHECK_AND_RESERVE
    assert "ZREM" in LUA_RELEASE_RESERVATION
