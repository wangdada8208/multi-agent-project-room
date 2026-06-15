"""Test room API and message service."""

import pytest
import uuid
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.room import Room
from app.models.user import User
from app.chat.service import save_message, list_messages


@pytest.mark.asyncio
async def test_create_and_list_rooms(client: AsyncClient):
    """Create a room then list it."""
    resp = await client.get("/api/v1/rooms")
    assert resp.status_code == 200
    assert len(resp.json()["rooms"]) == 0

    resp = await client.post(
        "/api/v1/rooms",
        json={"name": "Test Room", "description": "A test room"},
    )
    assert resp.status_code == 200
    room = resp.json()["room"]
    assert room["name"] == "Test Room"
    room_id = room["id"]

    resp = await client.get("/api/v1/rooms")
    assert len(resp.json()["rooms"]) == 1

    resp = await client.get(f"/api/v1/rooms/{room_id}")
    assert resp.status_code == 200
    assert resp.json()["room"]["name"] == "Test Room"


@pytest.mark.asyncio
async def test_room_not_found(client: AsyncClient):
    """Getting a non-existent room returns 404."""
    resp = await client.get("/api/v1/rooms/non-existent")
    assert resp.status_code == 404


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
