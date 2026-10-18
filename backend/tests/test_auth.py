"""Test lightweight authentication."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_register_login_and_me(client: AsyncClient):
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "alice",
            "password": "secret123",
            "display_name": "Alice",
        },
    )
    assert resp.status_code == 200
    token = resp.json()["access_token"]
    user = resp.json()["user"]
    assert user["username"] == "alice"
    assert "password_hash" not in user

    resp = await client.post(
        "/api/v1/auth/login",
        json={"username": "alice", "password": "secret123"},
    )
    assert resp.status_code == 200

    resp = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["user"]["username"] == "alice"


@pytest.mark.asyncio
@pytest.mark.parametrize("length", [40, 64])
async def test_username_that_casefolds_past_the_column_width_is_rejected(
    client: AsyncClient, length: int
):
    """A name whose casefolded key exceeds String(64) must be a 4xx, never a 500.

    ``\\w`` matches ``ß``, and casefolding lengthens it to ``ss``, so a 64-character
    input normalises to a 128-character key. The INSERT used to raise a data
    truncation error and the endpoint answered 500 Internal Server Error. The
    request is now rejected during validation, before any database write.
    """
    username = "ß" * length
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": "secret123",
            "display_name": "Eszett",
        },
    )
    assert resp.status_code == 422, resp.text
    assert resp.status_code < 500


@pytest.mark.asyncio
async def test_username_at_the_casefold_limit_is_still_accepted(client: AsyncClient):
    """32 × ß normalises to exactly 64 characters, which still fits: no over-rejection."""
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "username": "ß" * 32,
            "password": "secret123",
            "display_name": "Eszett Limit",
        },
    )
    assert resp.status_code == 200, resp.text
