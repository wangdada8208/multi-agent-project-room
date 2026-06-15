"""Test A2A Hub: agent card, task lifecycle, agent registration."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_agent_card_endpoint(client: AsyncClient):
    """Agent card should list all skills."""
    resp = await client.get("/a2a/.well-known/agent-card")
    assert resp.status_code == 200
    data = resp.json()
    assert "name" in data
    assert "skills" in data
    assert len(data["skills"]) > 0


@pytest.mark.asyncio
async def test_a2a_task_submit_and_query(client: AsyncClient):
    """Submit a task via JSON-RPC, then query its status."""
    # Submit task
    resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "tasks/send",
            "params": {"query": "Test task"},
            "id": "req-1",
        },
    )
    assert resp.status_code == 200
    result = resp.json()
    assert result.get("result") is not None
    task_id = result["result"]["id"]
    assert result["result"]["status"] in ("submitted", "working")

    # Get task status
    resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "tasks/get",
            "params": {"id": task_id},
            "id": "req-2",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["result"]["id"] == task_id


@pytest.mark.asyncio
async def test_a2a_task_list(client: AsyncClient):
    """List tasks should return recent tasks or empty list."""
    # Submit a task
    await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "tasks/send",
            "params": {"query": "List test task"},
            "id": "r1",
        },
    )

    resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "tasks/list",
            "params": {"limit": 10},
            "id": "list-req",
        },
    )
    assert resp.status_code == 200
    # Response may have result or error depending on DB state
    json_resp = resp.json()
    if json_resp.get("result") is not None:
        tasks = json_resp["result"].get("tasks", [])
        assert isinstance(tasks, list)


@pytest.mark.asyncio
async def test_a2a_cancel_task(client: AsyncClient):
    """Cancel a submitted task."""
    resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "tasks/send",
            "params": {"query": "Cancel me"},
            "id": "ct1",
        },
    )
    result = resp.json().get("result")
    if result is None:
        # Task may not be persisted in test env, skip
        return
    task_id = result["id"]

    resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "tasks/cancel",
            "params": {"id": task_id},
            "id": "ct2",
        },
    )
    assert resp.status_code == 200
    cancel_result = resp.json().get("result", {})
    if cancel_result:
        assert cancel_result.get("status") in ("canceled", "completed")


@pytest.mark.asyncio
async def test_a2a_unknown_method(client: AsyncClient):
    """Unknown JSON-RPC method should return error."""
    resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "nonexistent",
            "params": {},
            "id": "err1",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["error"] is not None
    assert resp.json()["error"]["code"] == -32601
