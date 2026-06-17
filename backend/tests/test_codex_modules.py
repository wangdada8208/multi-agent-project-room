"""Tests for Codex-owned Agent, Knowledge, and Repository modules."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_agent_register_and_list(client: AsyncClient):
    resp = await client.post(
        "/api/v1/agents/register",
        json={
            "name": "Codex",
            "url": "local://codex",
            "capabilities": ["frontend", "knowledge"],
        },
    )
    assert resp.status_code == 200
    agent = resp.json()["agent"]
    assert agent["name"] == "Codex"
    assert agent["status"] == "online"

    resp = await client.get("/api/v1/agents")
    assert resp.status_code == 200
    assert len(resp.json()["agents"]) == 1


@pytest.mark.asyncio
async def test_knowledge_create_list_search(client: AsyncClient, auth_headers: dict[str, str]):
    room_resp = await client.post(
        "/api/v1/rooms",
        json={"name": "Knowledge Room", "description": "docs"},
        headers=auth_headers,
    )
    room_id = room_resp.json()["room"]["id"]

    resp = await client.post(
        f"/api/v1/rooms/{room_id}/docs",
        json={"title": "PLAN Notes", "content": "Agent 面板和 Knowledge 搜索"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["doc"]["title"] == "PLAN Notes"

    resp = await client.get(f"/api/v1/rooms/{room_id}/docs", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["docs"][0]["title"] == "PLAN Notes"

    resp = await client.get(f"/api/v1/rooms/{room_id}/docs/search?q=Knowledge", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["results"][0]["title"] == "PLAN Notes"


@pytest.mark.asyncio
async def test_repository_status(client: AsyncClient, auth_headers: dict[str, str]):
    resp = await client.get("/api/v1/rooms/demo/git/status", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "branch" in data
    assert "changes" in data
    assert "last_commit" in data
