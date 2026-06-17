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
