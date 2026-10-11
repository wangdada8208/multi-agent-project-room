"""Regression test: Authorization verification for room messages, search, and tasks."""

import pytest
import uuid
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.service import save_message
from app.a2a import task_manager as tm
from app.models.room import Room


async def _register_user(client: AsyncClient, username: str) -> dict[str, str]:
    """Helper to register a user and return authorization headers."""
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": "Password123!",
            "display_name": f"User {username}",
        },
    )
    assert resp.status_code == 200, resp.text
    token = resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_messages_authz_negative_and_positive(client: AsyncClient, db: AsyncSession):
    # Setup two synthetic users A (owner) and B (outsider)
    headers_a = await _register_user(client, "alice_msg")
    headers_b = await _register_user(client, "bob_msg")

    # Alice creates a room
    room_resp = await client.post(
        "/api/v1/rooms",
        json={"name": "Alice Secret Room"},
        headers=headers_a,
    )
    assert room_resp.status_code == 200, room_resp.text
    room_id = room_resp.json()["room"]["id"]

    # Allow hub transport for message testing
    room = await db.get(Room, room_id)
    room.transport = "hub"
    await db.commit()

    # Post a message directly into Alice's room
    await save_message(
        db=db,
        room_id=room_id,
        sender_id="alice_user_id",
        sender_type="human",
        content="Confidential discussion",
        msg_type="text",
    )

    # 1. Negative test: Non-member Bob cannot list messages in Alice's room (must be 403)
    resp_b = await client.get(f"/api/v1/rooms/{room_id}/messages", headers=headers_b)
    assert resp_b.status_code == 403, f"Expected 403 for non-member, got {resp_b.status_code}"

    # 2. Negative test: Accessing non-existent room must return 404 and NOT auto-create room
    fake_room_id = str(uuid.uuid4())
    resp_404 = await client.get(f"/api/v1/rooms/{fake_room_id}/messages", headers=headers_a)
    assert resp_404.status_code == 404, f"Expected 404 for non-existent room, got {resp_404.status_code}"

    # Verify fake_room_id was not created in DB
    room_check = await client.get(f"/api/v1/rooms/{fake_room_id}", headers=headers_a)
    assert room_check.status_code == 404

    # 3. Positive test: Owner Alice can list messages
    resp_a = await client.get(f"/api/v1/rooms/{room_id}/messages", headers=headers_a)
    assert resp_a.status_code == 200
    data = resp_a.json()
    assert len(data["messages"]) == 1
    assert data["messages"][0]["content"] == "Confidential discussion"

    # 4. Positive test: Viewer can list messages
    headers_viewer = await _register_user(client, "charlie_viewer_msg")
    # Alice invites Charlie as viewer
    invite_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invite",
        json={"username": "charlie_viewer_msg", "role": "viewer"},
        headers=headers_a,
    )
    assert invite_resp.status_code == 200

    resp_viewer = await client.get(f"/api/v1/rooms/{room_id}/messages", headers=headers_viewer)
    assert resp_viewer.status_code == 200
    assert len(resp_viewer.json()["messages"]) == 1


@pytest.mark.asyncio
async def test_search_messages_authz_negative_and_positive(client: AsyncClient, db: AsyncSession):
    headers_a = await _register_user(client, "alice_search")
    headers_b = await _register_user(client, "bob_search")

    room_resp = await client.post(
        "/api/v1/rooms",
        json={"name": "Alice Search Room"},
        headers=headers_a,
    )
    assert room_resp.status_code == 200
    room_id = room_resp.json()["room"]["id"]

    # Set transport to hub for text search testing
    room = await db.get(Room, room_id)
    room.transport = "hub"
    await db.commit()

    await save_message(
        db=db,
        room_id=room_id,
        sender_id="alice_user_id",
        sender_type="human",
        content="Secret keyword 42",
        msg_type="text",
    )

    # 1. Negative test: Non-member Bob cannot search messages in Alice's room (must be 403)
    resp_b = await client.get(f"/api/v1/rooms/{room_id}/messages/search?q=Secret", headers=headers_b)
    assert resp_b.status_code == 403, f"Expected 403 for non-member, got {resp_b.status_code}"

    # 2. Negative test: Searching in non-existent room returns 404
    fake_room_id = str(uuid.uuid4())
    resp_404 = await client.get(f"/api/v1/rooms/{fake_room_id}/messages/search?q=Secret", headers=headers_a)
    assert resp_404.status_code == 404, f"Expected 404 for non-existent room, got {resp_404.status_code}"

    # 3. Positive test: Owner Alice can search messages
    resp_a = await client.get(f"/api/v1/rooms/{room_id}/messages/search?q=Secret", headers=headers_a)
    assert resp_a.status_code == 200
    assert len(resp_a.json()["results"]) == 1

    # 4. XMTP room: Non-member gets 403 before body_not_on_hub check
    xmtp_resp = await client.post(
        "/api/v1/rooms",
        json={"name": "Alice XMTP Room"},
        headers=headers_a,
    )
    assert xmtp_resp.status_code == 200
    xmtp_room_id = xmtp_resp.json()["room"]["id"]

    resp_xmtp_b = await client.get(f"/api/v1/rooms/{xmtp_room_id}/messages/search?q=test", headers=headers_b)
    assert resp_xmtp_b.status_code == 403, f"Expected 403 for non-member on XMTP room, got {resp_xmtp_b.status_code}"

    resp_xmtp_a = await client.get(f"/api/v1/rooms/{xmtp_room_id}/messages/search?q=test", headers=headers_a)
    assert resp_xmtp_a.status_code == 200
    assert resp_xmtp_a.json()["reason"] == "body_not_on_hub"


@pytest.mark.asyncio
async def test_tasks_authz_negative_and_positive(client: AsyncClient, db: AsyncSession):
    headers_a = await _register_user(client, "alice_task")
    headers_b = await _register_user(client, "bob_task")

    room_resp = await client.post(
        "/api/v1/rooms",
        json={"name": "Alice Task Room"},
        headers=headers_a,
    )
    assert room_resp.status_code == 200
    room_id = room_resp.json()["room"]["id"]

    # Submit task associated with Alice's room
    task_res = await tm.submit_task(
        query="Confidential planning",
        target_agent="Codex",
        source_agent="hub",
        room_id=room_id,
        route_remote=False,
    )
    task_id = task_res["id"]

    # 1. Negative test: Non-member Bob cannot list tasks in Alice's room (must be 403)
    resp_b_list = await client.get(f"/api/v1/rooms/{room_id}/tasks", headers=headers_b)
    assert resp_b_list.status_code == 403, f"Expected 403 for non-member listing room tasks, got {resp_b_list.status_code}"

    # 2. Negative test: Non-member Bob cannot get details of task in Alice's room (must be 403)
    resp_b_get = await client.get(f"/api/v1/tasks/{task_id}", headers=headers_b)
    assert resp_b_get.status_code == 403, f"Expected 403 for non-member getting task, got {resp_b_get.status_code}"

    # 3. Negative test: Non-existent room tasks list returns 404
    fake_room_id = str(uuid.uuid4())
    resp_404_list = await client.get(f"/api/v1/rooms/{fake_room_id}/tasks", headers=headers_a)
    assert resp_404_list.status_code == 404

    # 4. Negative test: Non-existent task returns 404
    fake_task_id = str(uuid.uuid4())
    resp_404_task = await client.get(f"/api/v1/tasks/{fake_task_id}", headers=headers_a)
    assert resp_404_task.status_code == 404

    # 5. Negative test: Task without room_id is rejected by default (403)
    orphan_task = await tm.submit_task(
        query="Orphan task without room",
        target_agent="Codex",
        source_agent="hub",
        room_id=None,
        route_remote=False,
    )
    orphan_id = orphan_task["id"]
    resp_orphan = await client.get(f"/api/v1/tasks/{orphan_id}", headers=headers_a)
    assert resp_orphan.status_code == 403, f"Expected 403 for orphan task, got {resp_orphan.status_code}"

    # 6. Positive test: Owner Alice can list tasks and get task detail
    resp_a_list = await client.get(f"/api/v1/rooms/{room_id}/tasks", headers=headers_a)
    assert resp_a_list.status_code == 200
    assert len(resp_a_list.json()["tasks"]) == 1
    assert resp_a_list.json()["tasks"][0]["id"] == task_id

    resp_a_get = await client.get(f"/api/v1/tasks/{task_id}", headers=headers_a)
    assert resp_a_get.status_code == 200
    assert resp_a_get.json()["task"]["id"] == task_id

    # 7. Positive test: Viewer can list tasks and get task detail
    headers_viewer = await _register_user(client, "charlie_viewer_task")
    await client.post(
        f"/api/v1/rooms/{room_id}/invite",
        json={"username": "charlie_viewer_task", "role": "viewer"},
        headers=headers_a,
    )
    resp_viewer_list = await client.get(f"/api/v1/rooms/{room_id}/tasks", headers=headers_viewer)
    assert resp_viewer_list.status_code == 200
    resp_viewer_get = await client.get(f"/api/v1/tasks/{task_id}", headers=headers_viewer)
    assert resp_viewer_get.status_code == 200
