"""Tests for email OTP registration/login and Google GIS ID token login."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from httpx import AsyncClient
import jwt
from jwt.algorithms import RSAAlgorithm
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import routes as auth_routes
from app.auth.email_otp import TEST_EMAIL_OUTBOX, verify_and_consume_email_otp
from app.config import Settings
from app.core.security import hash_password
from app.models.oauth_account import UserOAuthAccount
from app.models.user import User


def _settings(**overrides) -> Settings:
    defaults = dict(
        environment="test",
        auth_secret_key="test-secret-key-with-plenty-of-entropy-123456",
        email_provider="console",
        email_from_address="noreply@wangdada8208.xyz",
        email_from_name="MAPR Test",
        email_otp_ttl_seconds=600,
        email_otp_cooldown_seconds=60,
        google_client_id="test-google-client-id.apps.googleusercontent.com",
        google_jwks_url="https://auth-relay.wangdada8208.xyz/google-certs",
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _generate_rsa_jwk(kid: str = "kid-1"):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_jwk = json.loads(RSAAlgorithm.to_jwk(private_key.public_key()))
    public_jwk["kid"] = kid
    public_jwk["alg"] = "RS256"
    public_jwk["use"] = "sig"
    return private_key, public_jwk


def _sign_google_token(
    private_key,
    *,
    kid: str = "kid-1",
    alg: str = "RS256",
    sub: str = "google-sub-001",
    email: str = "Alice@Example.com",
    email_verified: bool = True,
    aud: str = "test-google-client-id.apps.googleusercontent.com",
    iss: str = "https://accounts.google.com",
    exp_offset_seconds: int = 300,
    name: str = "Alice Google",
    picture: str = "https://lh3.googleusercontent.com/a/alice",
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "email": email,
        "email_verified": email_verified,
        "aud": aud,
        "iss": iss,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=exp_offset_seconds)).timestamp()),
        "name": name,
        "picture": picture,
    }
    headers = {"kid": kid} if kid else {}
    return jwt.encode(payload, private_key, algorithm=alg, headers=headers)


def test_production_rejects_console_email_provider():
    with pytest.raises(ValueError, match="console"):
        Settings(
            environment="production",
            auth_secret_key="a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
            email_provider="console",
        )


@pytest.mark.asyncio
async def test_auth_providers_endpoint(client: AsyncClient, monkeypatch):
    cfg = _settings(email_provider="", google_client_id="")
    monkeypatch.setattr(auth_routes, "get_settings", lambda: cfg)
    resp = await client.get("/api/v1/auth/providers")
    assert resp.status_code == 200
    assert resp.json() == {
        "email_enabled": False,
        "google_enabled": False,
        "google_client_id": "",
    }

    cfg2 = _settings()
    monkeypatch.setattr(auth_routes, "get_settings", lambda: cfg2)
    resp2 = await client.get("/api/v1/auth/providers")
    assert resp2.status_code == 200
    assert resp2.json() == {
        "email_enabled": True,
        "google_enabled": True,
        "google_client_id": "test-google-client-id.apps.googleusercontent.com",
    }


@pytest.mark.asyncio
async def test_email_otp_five_wrong_attempts_invalidate_code(
    client: AsyncClient, monkeypatch
):
    cfg = _settings()
    monkeypatch.setattr(auth_routes, "get_settings", lambda: cfg)

    send_resp = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "Alice.Dev@Example.COM", "purpose": "register"},
    )
    assert send_resp.status_code == 200
    assert len(TEST_EMAIL_OUTBOX) == 1
    valid_code = TEST_EMAIL_OUTBOX[0]["code"]

    wrong_code = "000000" if valid_code != "000000" else "999999"
    for attempt in range(5):
        r = await client.post(
            "/api/v1/auth/email/register",
            json={
                "email": "alice.dev@example.com",
                "code": wrong_code,
                "password": "StrongPassword123",
            },
        )
        assert r.status_code == 400
        if attempt == 4:
            assert "过多" in r.json()["detail"]

    # Even the previously valid code is now invalidated in OTP storage.
    with pytest.raises(HTTPException) as exc_info:
        await verify_and_consume_email_otp("alice.dev@example.com", valid_code, "register", cfg)
    assert exc_info.value.status_code == 400
    assert "过期或不存在" in exc_info.value.detail


@pytest.mark.asyncio
async def test_email_registration_cooldown_and_login(
    client: AsyncClient, db: AsyncSession, monkeypatch
):
    cfg = _settings()
    monkeypatch.setattr(auth_routes, "get_settings", lambda: cfg)

    # 1. Invalid email rejected
    bad_email = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "not-an-email", "purpose": "register"},
    )
    assert bad_email.status_code == 422

    # 2. Send registration code
    send_resp = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "Alice.Dev@Example.COM", "purpose": "register"},
    )
    assert send_resp.status_code == 200
    assert send_resp.json()["sent"] is True
    assert len(TEST_EMAIL_OUTBOX) == 1
    code = TEST_EMAIL_OUTBOX[0]["code"]
    assert len(code) == 6 and code.isdigit()

    # 3. Immediate resend hits 429 cooldown
    cooldown_resp = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "alice.dev@example.com", "purpose": "register"},
    )
    assert cooldown_resp.status_code == 429

    # 4. Complete registration with valid code
    reg_resp = await client.post(
        "/api/v1/auth/email/register",
        json={
            "email": "alice.dev@example.com",
            "code": code,
            "password": "StrongPassword123",
            "display_name": "Alice Dev",
        },
    )
    assert reg_resp.status_code == 200
    body = reg_resp.json()
    assert body["user"]["username"] == "alice.dev"
    assert body["user"]["email"] == "alice.dev@example.com"
    assert body["user"]["email_verified"] is True
    assert body["user"]["user_type"] == "human"
    assert "password_hash" not in body["user"]

    # Code is single-use: replaying it fails
    replay = await client.post(
        "/api/v1/auth/email/register",
        json={
            "email": "alice.dev@example.com",
            "code": code,
            "password": "StrongPassword123",
        },
    )
    assert replay.status_code == 400

    # Duplicate email send-code returns 409 without sending
    dup_send = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "ALICE.DEV@example.com", "purpose": "register"},
    )
    assert dup_send.status_code == 409

    # 6. Email + password login (case-insensitive)
    login_ok = await client.post(
        "/api/v1/auth/login",
        json={"username": "ALICE.DEV@example.com", "password": "StrongPassword123"},
    )
    assert login_ok.status_code == 200
    assert login_ok.json()["user"]["id"] == body["user"]["id"]

    # Wrong password returns 401
    login_bad = await client.post(
        "/api/v1/auth/login",
        json={"username": "alice.dev@example.com", "password": "WrongPassword123"},
    )
    assert login_bad.status_code == 401

    # 7. Auto-derived username collision appends random suffix
    other_send = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "alice.dev@otherdomain.com", "purpose": "register"},
    )
    assert other_send.status_code == 200
    other_code = TEST_EMAIL_OUTBOX[-1]["code"]
    other_reg = await client.post(
        "/api/v1/auth/email/register",
        json={
            "email": "alice.dev@otherdomain.com",
            "code": other_code,
            "password": "StrongPassword123",
        },
    )
    assert other_reg.status_code == 200
    other_username = other_reg.json()["user"]["username"]
    assert other_username.startswith("alice.dev_")
    assert other_username != "alice.dev"


@pytest.mark.asyncio
async def test_email_login_passwordless_and_no_enumeration(
    client: AsyncClient, db: AsyncSession, monkeypatch
):
    cfg = _settings()
    monkeypatch.setattr(auth_routes, "get_settings", lambda: cfg)

    # Passwordless Google-created user
    now = datetime.now(timezone.utc)
    user = User(
        username="google_only",
        display_name="Google Only",
        user_type="human",
        email="gonly@example.com",
        normalized_email="gonly@example.com",
        email_verified_at=now,
        password_hash=None,
    )
    db.add(user)
    await db.commit()

    # Password login on passwordless user cleanly returns 401
    pw_try = await client.post(
        "/api/v1/auth/login",
        json={"username": "gonly@example.com", "password": "any-password-123"},
    )
    assert pw_try.status_code == 401

    # Unknown email login code returns 200 sent=True without actually queuing an email
    unknown_send = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "nobody@example.com", "purpose": "login"},
    )
    assert unknown_send.status_code == 200
    assert unknown_send.json()["sent"] is True
    assert len(TEST_EMAIL_OUTBOX) == 0

    # Real user receives OTP and signs in passwordlessly
    known_send = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "gonly@example.com", "purpose": "login"},
    )
    assert known_send.status_code == 200
    assert len(TEST_EMAIL_OUTBOX) == 1
    login_code = TEST_EMAIL_OUTBOX[0]["code"]

    login_resp = await client.post(
        "/api/v1/auth/email/login",
        json={"email": "gonly@example.com", "code": login_code},
    )
    assert login_resp.status_code == 200
    assert login_resp.json()["user"]["id"] == user.id


@pytest.mark.asyncio
async def test_email_delivery_providers_and_failure_rollback(
    client: AsyncClient, monkeypatch
):
    captured: list[dict] = []

    class FakeResponse:
        def __init__(self, status_code: int):
            self.status_code = status_code

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers=None, json=None):
            captured.append({"url": url, "headers": headers, "json": json})
            if "fail" in url:
                return FakeResponse(502)
            return FakeResponse(200)

    monkeypatch.setattr("app.auth.email_otp.httpx.AsyncClient", FakeAsyncClient)

    # 1. Cloudflare Worker success
    cf_cfg = _settings(
        email_provider="cloudflare_worker",
        email_worker_url="https://auth-relay.wangdada8208.xyz/send-email",
        email_worker_secret="worker-secret-xyz",
    )
    monkeypatch.setattr(auth_routes, "get_settings", lambda: cf_cfg)
    resp = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "worker-user@example.com", "purpose": "register"},
    )
    assert resp.status_code == 200
    assert captured[-1]["url"] == "https://auth-relay.wangdada8208.xyz/send-email"
    assert captured[-1]["headers"]["Authorization"] == "Bearer worker-secret-xyz"
    assert captured[-1]["json"]["to"] == "worker-user@example.com"
    assert captured[-1]["json"]["from_email"] == "noreply@wangdada8208.xyz"

    # 2. Resend success
    resend_cfg = _settings(
        email_provider="resend",
        email_api_url="https://api.resend.com/emails",
        email_api_key="re_test_key_123",
    )
    monkeypatch.setattr(auth_routes, "get_settings", lambda: resend_cfg)
    resp2 = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "resend-user@example.com", "purpose": "register"},
    )
    assert resp2.status_code == 200
    assert captured[-1]["url"] == "https://api.resend.com/emails"
    assert captured[-1]["headers"]["Authorization"] == "Bearer re_test_key_123"
    assert captured[-1]["json"]["to"] == ["resend-user@example.com"]

    # 3. Failed delivery rolls back cooldown so user can retry immediately
    fail_cfg = _settings(
        email_provider="cloudflare_worker",
        email_worker_url="https://fail.example.com/send-email",
        email_worker_secret="worker-secret-xyz",
    )
    monkeypatch.setattr(auth_routes, "get_settings", lambda: fail_cfg)
    fail_resp = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "retry-user@example.com", "purpose": "register"},
    )
    assert fail_resp.status_code == 502

    # Immediately switch back to working provider: must NOT hit 429 cooldown
    monkeypatch.setattr(auth_routes, "get_settings", lambda: cf_cfg)
    retry_resp = await client.post(
        "/api/v1/auth/email/send-code",
        json={"email": "retry-user@example.com", "purpose": "register"},
    )
    assert retry_resp.status_code == 200


@pytest.mark.asyncio
async def test_google_login_lifecycle_and_security_guards(
    client: AsyncClient, db: AsyncSession, monkeypatch
):
    cfg = _settings()
    monkeypatch.setattr(auth_routes, "get_settings", lambda: cfg)

    priv1, jwk1 = _generate_rsa_jwk("kid-1")
    jwks_calls = 0

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url):
            nonlocal jwks_calls
            jwks_calls += 1
            return SimpleNamespace(
                status_code=200,
                json=lambda: {"keys": [jwk1]},
            )

    monkeypatch.setattr("app.auth.google_oauth.httpx.AsyncClient", FakeAsyncClient)

    # 1. First Google login auto-creates human user + OAuth link
    token1 = _sign_google_token(priv1, sub="sub-alice-1", email="Alice.G@Example.com", name="Alice G")
    r1 = await client.post("/api/v1/auth/google", json={"credential": token1})
    assert r1.status_code == 200
    u1 = r1.json()["user"]
    assert u1["username"] == "alice.g"
    assert u1["email"] == "Alice.G@Example.com"
    assert u1["email_verified"] is True
    assert u1["avatar_url"] == "https://lh3.googleusercontent.com/a/alice"
    assert jwks_calls == 1

    # 2. Second Google login reuses cached JWKS (jwks_calls stays 1) and existing user
    token2 = _sign_google_token(priv1, sub="sub-alice-1", email="alice.g@example.com", iss="accounts.google.com")
    r2 = await client.post("/api/v1/auth/google", json={"credential": token2})
    assert r2.status_code == 200
    assert r2.json()["user"]["id"] == u1["id"]
    assert jwks_calls == 1

    # 3. Verified local human user auto-links on first Google sign-in
    verified_user = User(
        username="bob_verified",
        display_name="Bob Verified",
        user_type="human",
        email="bob@example.com",
        normalized_email="bob@example.com",
        email_verified_at=datetime.now(timezone.utc),
        password_hash=hash_password("BobSecret123"),
    )
    db.add(verified_user)
    await db.commit()

    bob_token = _sign_google_token(priv1, sub="sub-bob-1", email="bob@example.com", name="Bob G")
    r_bob = await client.post("/api/v1/auth/google", json={"credential": bob_token})
    assert r_bob.status_code == 200
    assert r_bob.json()["user"]["id"] == verified_user.id

    links = (
        await db.execute(
            select(UserOAuthAccount).where(UserOAuthAccount.user_id == verified_user.id)
        )
    ).scalars().all()
    assert len(links) == 1
    assert links[0].provider_subject == "sub-bob-1"

    # 4. Unverified local user must NOT be silently taken over
    unverified_user = User(
        username="carol_unverified",
        display_name="Carol",
        user_type="human",
        email="carol@example.com",
        normalized_email="carol@example.com",
        email_verified_at=None,
        password_hash=hash_password("CarolSecret123"),
    )
    db.add(unverified_user)
    await db.commit()

    carol_token = _sign_google_token(priv1, sub="sub-carol-1", email="carol@example.com")
    r_carol = await client.post("/api/v1/auth/google", json={"credential": carol_token})
    assert r_carol.status_code == 409

    # 5. Agent user with matching email cannot be hijacked via Google login
    agent_user = User(
        username="agent_with_mail",
        display_name="Agent Mail",
        user_type="agent",
        email="agent@example.com",
        normalized_email="agent@example.com",
        email_verified_at=datetime.now(timezone.utc),
        password_hash=hash_password("AgentSecret123"),
    )
    db.add(agent_user)
    await db.commit()

    agent_token = _sign_google_token(priv1, sub="sub-agent-1", email="agent@example.com")
    r_agent = await client.post("/api/v1/auth/google", json={"credential": agent_token})
    assert r_agent.status_code == 409


@pytest.mark.parametrize(
    "case_name",
    ["wrong_aud", "wrong_iss", "unverified_email", "expired", "alg_hs256"],
)
@pytest.mark.asyncio
async def test_google_login_rejects_invalid_tokens(
    client: AsyncClient, monkeypatch, case_name: str
):
    cfg = _settings()
    monkeypatch.setattr(auth_routes, "get_settings", lambda: cfg)

    priv1, jwk1 = _generate_rsa_jwk("kid-1")

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url):
            return SimpleNamespace(status_code=200, json=lambda: {"keys": [jwk1]})

    monkeypatch.setattr("app.auth.google_oauth.httpx.AsyncClient", FakeAsyncClient)

    if case_name == "wrong_aud":
        bad_tok = _sign_google_token(priv1, aud="wrong-client-id")
    elif case_name == "wrong_iss":
        bad_tok = _sign_google_token(priv1, iss="https://evil.example.com")
    elif case_name == "unverified_email":
        bad_tok = _sign_google_token(priv1, email_verified=False)
    elif case_name == "expired":
        bad_tok = _sign_google_token(priv1, exp_offset_seconds=-120)
    else:
        bad_tok = jwt.encode(
            {
                "sub": "x",
                "aud": cfg.google_client_id,
                "iss": "https://accounts.google.com",
                "exp": 9999999999,
            },
            "shared-secret-at-least-32-bytes-long!!",
            algorithm="HS256",
            headers={"kid": "kid-1"},
        )

    bad_resp = await client.post("/api/v1/auth/google", json={"credential": bad_tok})
    assert bad_resp.status_code == 401, f"case {case_name} got {bad_resp.status_code}: {bad_resp.text}"
