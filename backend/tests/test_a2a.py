"""Test A2A Hub v1.0: agent card, protocol routes, dialogue system, task lifecycle."""

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from app.a2a import task_manager as tm
from app.a2a.models import A2ATask
from app.chat import service as chat_service


@pytest.mark.asyncio
async def test_agent_card_endpoint(client: AsyncClient, auth_headers: dict):
    """Agent Card at /.well-known/agent-card.json (A2A v1.0 standard)."""
    resp = await client.get("/.well-known/agent-card.json")
    assert resp.status_code == 200
    data = resp.json()
    assert "name" in data
    assert "skills" in data
    assert len(data["skills"]) > 0
    # v1.0 fields
    assert "version" in data
    assert "capabilities" in data


@pytest.mark.asyncio
async def test_a2a_jsonrpc_endpoint_exists(client: AsyncClient, auth_headers: dict):
    """The A2A JSON-RPC endpoint should exist and accept POST."""
    resp = await client.post(
        "/a2a/rpc",
        content=b"invalid-body",
        headers={"Content-Type": "application/json"},
    )
    # Should not 404 — it may return 400/422 for bad body but route exists
    assert resp.status_code != 404


@pytest.mark.asyncio
async def test_dialogue_rpc_unknown_method(client: AsyncClient, auth_headers: dict):
    """Unknown dialogue method should return error."""
    resp = await client.post(
        "/a2a/dialogue-rpc",
        json={"jsonrpc": "2.0", "method": "nonexistent", "params": {}, "id": "err1"},
        headers=auth_headers,
    )
    assert resp.status_code == 404  # HTTPException from unknown method


@pytest.mark.asyncio
async def test_dialogue_create_and_send(client: AsyncClient, auth_headers: dict):
    """Create a dialogue and send messages through it."""
    # Create
    resp = await client.post(
        "/a2a/dialogue-rpc",
        headers=auth_headers,
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/create",
            "params": {
                "room_id": "test-dialogue-room",
                "initiator_agent": "Codex",
                "participants": ["Claude"],
                "duration_seconds": 30,
                "max_turns": 5,
            },
            "id": "dc1",
        },
    )
    assert resp.status_code == 200
    result = resp.json().get("result")
    assert result is not None
    assert result["status"] == "active"
    assert len(result["participants"]) >= 2
    dialogue_id = result["dialogue_id"]

    # Send
    resp = await client.post(
        "/a2a/dialogue-rpc",
        headers=auth_headers,
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/send",
            "params": {
                "dialogue_id": dialogue_id,
                "content": "Hello Claude!",
                "sender_id": "codex-id",
                "sender_name": "Codex",
            },
            "id": "ds1",
        },
    )
    assert resp.status_code == 200
    send_result = resp.json().get("result")
    assert send_result is not None
    assert send_result["status"] == "sent"
    assert send_result["target_agent"] == "Claude"


@pytest.mark.asyncio
async def test_dialogue_end(client: AsyncClient, auth_headers: dict):
    """End an active dialogue."""
    create_resp = await client.post(
        "/a2a/dialogue-rpc",
        headers=auth_headers,
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/create",
            "params": {
                "room_id": "test-end-room",
                "initiator_agent": "Codex",
                "participants": ["Claude"],
            },
            "id": "de0",
        },
    )
    dialogue_id = create_resp.json()["result"]["dialogue_id"]

    resp = await client.post(
        "/a2a/dialogue-rpc",
        headers=auth_headers,
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/end",
            "params": {"dialogue_id": dialogue_id},
            "id": "de1",
        },
    )
    assert resp.status_code == 200
    end_result = resp.json().get("result")
    assert end_result["status"] == "ended"


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
