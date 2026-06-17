"""Test room task REST API."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_room_tasks_are_listed(client: AsyncClient, auth_headers: dict[str, str]):
    room_resp = await client.post("/api/v1/rooms", json={"name": "Task Room"}, headers=auth_headers)
    room_id = room_resp.json()["room"]["id"]

    task_resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "tasks/send",
            "params": {"query": "Do something", "room_id": room_id, "target_agent": "Codex"},
            "id": "task-room",
        },
    )
    task_id = task_resp.json()["result"]["id"]

    resp = await client.get(f"/api/v1/rooms/{room_id}/tasks", headers=auth_headers)
    assert resp.status_code == 200
    tasks = resp.json()["tasks"]
    assert [task["id"] for task in tasks] == [task_id]

    resp = await client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["task"]["room_id"] == room_id
