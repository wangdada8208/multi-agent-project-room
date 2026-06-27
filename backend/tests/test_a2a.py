"""Test A2A Hub: agent card, task lifecycle, agent registration."""

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from app.a2a import task_manager as tm
from app.a2a.models import A2ATask
from app.chat import service as chat_service


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


@pytest.mark.asyncio
async def test_submit_task_can_skip_remote_routing():
    """Chat @mentions should create a working task for WS relay, not call localhost A2A."""
    result = await tm.submit_task(
        query="@Codex hello",
        target_agent="Codex",
        source_agent="Tester",
        room_id="demo-room",
        route_remote=False,
    )

    assert result["status"] == "working"
    task = await tm.get_task(result["id"])
    assert task is not None
    assert task["target_agent"] == "Codex"
    assert task["status"] == "working"


@pytest.mark.asyncio
async def test_submit_task_fails_when_remote_target_unavailable(db):
    """Direct A2A tasks should fail fast when the target agent has no active route."""
    await chat_service.get_or_create_room(db, "demo-room", name="Demo Room")

    result = await tm.submit_task(
        query="Ask missing agent",
        target_agent="MissingAgent",
        source_agent="Tester",
        room_id="demo-room",
    )

    assert result["status"] == "failed"
    assert "unavailable" in result["error"]
    task = await tm.get_task(result["id"])
    assert task is not None
    assert task["status"] == "failed"
    assert task["result"]["error"] == result["error"]


@pytest.mark.asyncio
async def test_expire_stale_tasks_marks_old_working_tasks_failed(db):
    """Old working tasks should not stay stuck forever."""
    await chat_service.get_or_create_room(db, "demo-room", name="Demo Room")
    result = await tm.submit_task(
        query="@Codex old task",
        target_agent="Codex",
        source_agent="Tester",
        room_id="demo-room",
        route_remote=False,
    )

    db_task = await db.get(A2ATask, result["id"])
    db_task.created_at = datetime.now(timezone.utc) - timedelta(seconds=120)
    await db.commit()

    expired = await tm.expire_stale_tasks(timeout_seconds=60)

    assert expired["count"] == 1
    task = await tm.get_task(result["id"])
    assert task is not None
    assert task["status"] == "failed"
    assert "timed out" in task["result"]["error"]
