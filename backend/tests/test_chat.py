"""Test room API and message service."""

import pytest
import uuid
from datetime import datetime, timedelta, timezone
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.models import Message
from app.models.room import Room
from app.models.user import User
from app.chat.service import save_message, list_messages


@pytest.mark.asyncio
async def test_create_and_list_rooms(client: AsyncClient, auth_headers: dict[str, str]):
    """Create a room then list it."""
    resp = await client.get("/api/v1/rooms", headers=auth_headers)
    assert resp.status_code == 200
    assert len(resp.json()["rooms"]) == 0

    resp = await client.post(
        "/api/v1/rooms",
        json={"name": "Test Room", "description": "A test room"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    room = resp.json()["room"]
    assert room["name"] == "Test Room"
    room_id = room["id"]

    resp = await client.get("/api/v1/rooms", headers=auth_headers)
    assert len(resp.json()["rooms"]) == 1

    resp = await client.get(f"/api/v1/rooms/{room_id}", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["room"]["name"] == "Test Room"


@pytest.mark.asyncio
async def test_room_not_found(client: AsyncClient, auth_headers: dict[str, str]):
    """Getting a non-existent room returns 404."""
    resp = await client.get("/api/v1/rooms/non-existent", headers=auth_headers)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_rooms_require_auth(client: AsyncClient):
    resp = await client.get("/api/v1/rooms")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_message_service(db: AsyncSession):
    """Test chat service functions directly."""
    user = User(id=str(uuid.uuid4()), username="testuser", display_name="Test")
    room = Room(name="Service Test")
    db.add(user)
    db.add(room)
    await db.commit()

    msg = await save_message(
        db=db,
        room_id=room.id,
        sender_id=user.id,
        sender_type="human",
        content="Service layer test",
        msg_type="task",
    )
    assert msg.content == "Service layer test"
    assert msg.msg_type == "task"

    msgs = await list_messages(db=db, room_id=room.id)
    assert len(msgs) == 1
    assert msgs[0].id == msg.id


@pytest.mark.asyncio
async def test_message_types(db: AsyncSession):
    """All message types should be saveable."""
    import uuid
    user = User(id=str(uuid.uuid4()), username="msgtester", display_name="MsgTester")
    room = Room(name="Msg Types")
    db.add(user)
    db.add(room)
    await db.commit()

    for msg_type in ["text", "system", "task", "proposal", "report", "approval_request"]:
        msg = await save_message(
            db=db, room_id=room.id, sender_id=user.id,
            sender_type="human", content=f"Type: {msg_type}", msg_type=msg_type,
        )
        assert msg.msg_type == msg_type


@pytest.mark.asyncio
async def test_message_retention_removes_expired_messages(db: AsyncSession):
    """Messages older than the retention window are deleted and not returned."""
    user = User(id=str(uuid.uuid4()), username="retention", display_name="Retention")
    room = Room(name="Retention")
    db.add(user)
    db.add(room)
    await db.commit()

    old_msg = Message(
        room_id=room.id,
        sender_id=user.id,
        sender_type="human",
        content="expired",
        msg_type="text",
        created_at=datetime.now(timezone.utc) - timedelta(days=16),
    )
    fresh_msg = Message(
        room_id=room.id,
        sender_id=user.id,
        sender_type="human",
        content="fresh",
        msg_type="text",
        created_at=datetime.now(timezone.utc) - timedelta(days=1),
    )
    db.add_all([old_msg, fresh_msg])
    await db.commit()

    messages = await list_messages(db=db, room_id=room.id)
    assert [message.content for message in messages] == ["fresh"]

    result = await db.execute(select(Message).where(Message.id == old_msg.id))
    assert result.scalars().first() is None


@pytest.mark.asyncio
async def test_message_history_returns_latest_page_oldest_first(db: AsyncSession):
    """Refresh history should show the newest retained messages, oldest to newest."""
    user = User(id=str(uuid.uuid4()), username="latest", display_name="Latest")
    room = Room(name="Latest")
    db.add(user)
    db.add(room)
    await db.commit()

    now = datetime.now(timezone.utc)
    db.add_all(
        [
            Message(
                room_id=room.id,
                sender_id=user.id,
                sender_type="human",
                content=f"message-{index}",
                msg_type="text",
                created_at=now + timedelta(minutes=index),
            )
            for index in range(5)
        ]
    )
    await db.commit()

    messages = await list_messages(db=db, room_id=room.id, page=1, limit=3)
    assert [message.content for message in messages] == [
        "message-2",
        "message-3",
        "message-4",
    ]
