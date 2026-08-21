"""Test room task REST API."""

import pytest
from httpx import AsyncClient

from app.a2a import task_manager as tm


@pytest.mark.asyncio
async def test_room_tasks_are_listed(client: AsyncClient, auth_headers: dict[str, str], db):
    room_resp = await client.post("/api/v1/rooms", json={"name": "Task Room"}, headers=auth_headers)
    room_id = room_resp.json()["room"]["id"]

    result = await tm.submit_task(
        query="Do something",
        target_agent="Codex",
        source_agent="hub",
        room_id=room_id,
        route_remote=False,
    )
    task_id = result["id"]

    resp = await client.get(f"/api/v1/rooms/{room_id}/tasks", headers=auth_headers)
    assert resp.status_code == 200
    tasks = resp.json()["tasks"]
    assert [task["id"] for task in tasks] == [task_id]

    resp = await client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["task"]["room_id"] == room_id
