"""Test basic health endpoint and gateway."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_endpoint(client: AsyncClient):
    """GET /health should return 200 with service info."""
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "service" in data


@pytest.mark.asyncio
async def test_a2a_agent_card(client: AsyncClient):
    """GET /.well-known/agent-card.json should return Hub card."""
    resp = await client.get("/.well-known/agent-card.json")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "Multi-Agent Room Hub"
    assert len(data["skills"]) > 0
