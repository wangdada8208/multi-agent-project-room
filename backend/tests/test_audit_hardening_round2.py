"""Automated regression verification for Round 2 audit hardening."""

from __future__ import annotations

import asyncio
import ipaddress
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.service import find_username_matches
from app.auth.rate_limit import (
    MAX_ATTEMPTS,
    WINDOW_SECONDS,
    _attempts,
    _blocked_until,
    _client_ip,
    _is_trusted_proxy,
    check_rate_limit,
    clear_attempts,
    record_attempt,
)
from app.config import Settings
from app.core.security import create_access_token, decode_access_token, get_current_user
from app.models.user import User
from app.a2a.http_protocol import decode_http_token


from tests.conftest import override_get_db


# =====================================================================
# 1. Production Secret Validation & Environment Enforcement (Issues 1 & 8)
# =====================================================================

def test_production_secret_validation_rejects_insecure_defaults():
    # Production with default dev secrets must fail
    with pytest.raises(ValueError, match="MAPR_AUTH_SECRET_KEY"):
        Settings(
            environment="production",
            auth_secret_key="dev-change-me",
        )

    # Production with short secrets must fail
    with pytest.raises(ValueError, match=">=32 chars"):
        Settings(
            environment="production",
            auth_secret_key="short",
        )

    # Production with secure secrets must pass
    valid_key = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
    settings_secure = Settings(
        environment="production",
        auth_secret_key=valid_key,
    )
    assert settings_secure.auth_secret_key == valid_key

    # Development allows dev secrets
    settings_dev = Settings(
        environment="development",
        auth_secret_key="dev-change-me",
    )
    assert settings_dev.auth_secret_key == "dev-change-me"


# =====================================================================
# 2. Strict JWT typ Claim Validation (Issue 2)
# =====================================================================

def test_jwt_typ_claim_validation():
    import base64
    import hashlib
    import hmac
    import json
    from app.config import get_settings
    settings = get_settings()

    # Valid token has typ: human / agent
    token = create_access_token("user-123", "human")
    claims = decode_access_token(token)
    assert claims["sub"] == "user-123"
    assert claims.get("typ") == "human"

    # Token decoded by decode_http_token
    token_claims = decode_http_token(token)
    assert token_claims["sub"] == "user-123"
    assert token_claims.get("typ") == "human"

    # Missing typ claim should be rejected
    def _b64(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).decode().rstrip("=")

    missing_typ_payload = {
        "sub": "user-123",
        "exp": int(time.time()) + 3600,
    }
    body = _b64(json.dumps(missing_typ_payload, separators=(",", ":")).encode())
    sig = hmac.new(settings.auth_secret_key.encode(), body.encode(), hashlib.sha256)
    missing_typ_token = f"{body}.{_b64(sig.digest())}"

    with pytest.raises(HTTPException) as exc:
        decode_access_token(missing_typ_token)
    assert exc.value.status_code == 401


# =====================================================================
# 3. Inactive Account Enforcement (Issues 10 & 13)
# =====================================================================

@pytest.mark.asyncio
async def test_inactive_account_rejection(client: AsyncClient, db: AsyncSession):
    # Register a new user
    username = "inactiveuser"
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": "password123",
            "display_name": "Inactive User",
        },
    )
    assert resp.status_code == 200
    token = resp.json()["access_token"]
    user_id = resp.json()["user"]["id"]

    # Deactivate the user directly in database
    user = await db.get(User, user_id)
    assert user is not None
    assert user.is_active is True
    user.is_active = False
    await db.commit()

    # Login attempt must be rejected with 401 "Inactive account"
    login_resp = await client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": "password123"},
    )
    assert login_resp.status_code == 401
    assert "Inactive account" in login_resp.json()["detail"]

    # Authenticated endpoint with existing token must reject inactive user
    me_resp = await client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me_resp.status_code == 401
    assert "Inactive account" in me_resp.json()["detail"]


# =====================================================================
# 4. Atomic Rate Limiter: Dual-Key, IP Isolation, and Proxy CIDR (Issues 3, 9, 11, 12)
# =====================================================================

def test_trusted_proxy_cidr_parsing():
    assert _is_trusted_proxy("127.0.0.1") is True
    assert _is_trusted_proxy("::1") is True
    assert _is_trusted_proxy("10.5.2.1") is True
    assert _is_trusted_proxy("172.18.0.4") is True
    assert _is_trusted_proxy("192.168.1.100") is True
    assert _is_trusted_proxy("203.0.113.195") is False
    assert _is_trusted_proxy("invalid-ip") is False


def test_client_ip_extraction_with_forwarded_for():
    # Trusted proxy should parse first X-Forwarded-For IP
    req_trusted = MagicMock()
    req_trusted.client.host = "172.18.0.2"  # inside 172.16.0.0/12
    req_trusted.headers.get.return_value = "203.0.113.50, 10.0.0.1"
    assert _client_ip(req_trusted) == "203.0.113.50"

    # Untrusted client IP should ignore X-Forwarded-For
    req_untrusted = MagicMock()
    req_untrusted.client.host = "198.51.100.22"
    req_untrusted.headers.get.return_value = "1.2.3.4"
    assert _client_ip(req_untrusted) == "198.51.100.22"


def test_rate_limiter_account_isolation_and_ip_preservation():
    _attempts.clear()
    _blocked_until.clear()

    req = MagicMock()
    req.client.host = "198.51.100.33"
    req.headers.get.return_value = None

    # Record 4 failed attempts against target "victim"
    for _ in range(4):
        record_attempt(req, "login", identifier="victim")

    ip_key = "login:ip:198.51.100.33"
    acc_victim_key = "login:acc:victim"
    acc_attacker_key = "login:acc:attacker"

    assert len(_attempts[ip_key]) == 4
    assert len(_attempts[acc_victim_key]) == 4

    # Attacker logs into their own valid account "attacker"
    clear_attempts(req, "login", identifier="attacker")

    # The IP key must STILL have 4 failed attempts!
    assert len(_attempts[ip_key]) == 4

    # Victim key still has 4 failed attempts
    assert len(_attempts[acc_victim_key]) == 4

    # One more failure from this IP should trigger rate limit lock (reaching 5)
    record_attempt(req, "login", identifier="victim")
    with pytest.raises(HTTPException) as exc:
        check_rate_limit(req, "login", identifier="other")
    assert exc.value.status_code == 429


@pytest.mark.asyncio
async def test_registration_failure_records_rate_limit(client: AsyncClient):
    _attempts.clear()
    _blocked_until.clear()

    # Attempt agent registration with invalid enrollment key
    for _ in range(MAX_ATTEMPTS):
        resp = await client.post(
            "/api/v1/auth/register",
            json={
                "username": "agent_bot",
                "password": "password123",
                "display_name": "Agent",
                "user_type": "agent",
            },
            headers={"X-Agent-Enrollment-Key": "wrong-secret"},
        )
        assert resp.status_code == 403

    # Next attempt should be blocked with 429
    blocked_resp = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "agent_bot",
            "password": "password123",
            "display_name": "Agent",
            "user_type": "agent",
        },
    )
    assert blocked_resp.status_code == 429


# =====================================================================
# 5. Unicode Casefold Username Resolution (Issue 14)
# =====================================================================

@pytest.mark.asyncio
async def test_find_username_matches_unicode_casefold(db: AsyncSession):
    # Create user with German sharp s "groß"
    user = User(
        username="groß",
        display_name="Gross User",
        password_hash="hash",
        user_type="human",
    )
    db.add(user)
    await db.commit()

    # 'GROSS'.casefold() == 'groß'.casefold() == 'gross'
    matches = await find_username_matches(db, "GROSS")
    assert len(matches) == 1
    assert matches[0].username == "groß"

    matches_exact = await find_username_matches(db, "groß")
    assert len(matches_exact) == 1
    assert matches_exact[0].username == "groß"


# =====================================================================
# 6. Readiness Probe Behavior (Issue 15)
# =====================================================================

@pytest.mark.asyncio
async def test_readiness_probe_healthy_and_unhealthy(client: AsyncClient):
    # Healthy readiness probe
    resp = await client.get("/ready")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ready"
    assert data["database"] == "connected"

    # Simulate DB timeout / failure
    mock_db = AsyncMock()
    mock_db.execute.side_effect = asyncio.TimeoutError()

    async def failing_get_db():
        yield mock_db

    from app.core.database import get_db
    from app.main import app
    app.dependency_overrides[get_db] = failing_get_db
    try:
        fail_resp = await client.get("/ready")
        assert fail_resp.status_code == 503
        fail_data = fail_resp.json()
        assert fail_data["status"] == "not ready"
        assert fail_data["database"] == "unavailable"
    finally:
        app.dependency_overrides[get_db] = override_get_db
