import uuid
import pytest
from app.chat.plaintext_guard import PlaintextStorageForbidden
from app.chat.service import save_message
from app.models.room import Room
from app.models.user import User


def test_room_transport_defaults_to_hub():
    room = Room(name="旧房间")
    assert room.transport == "hub"
    assert room.xmtp_group_id is None
    payload = room.to_dict()
    assert payload["transport"] == "hub"
    assert payload["xmtp_group_id"] is None
    assert "wallet" not in payload
    assert "key" not in payload


@pytest.mark.asyncio
async def test_xmtp_room_rejects_message_body(db):
    user = User(
        id=str(uuid.uuid4()),
        username="owner",
        display_name="Owner",
        user_type="human",
    )
    room = Room(
        id=str(uuid.uuid4()),
        name="加密房间",
        transport="xmtp",
        xmtp_group_id="group-dev-1",
        created_by=user.id,
    )
    db.add(user)
    db.add(room)
    await db.commit()

    with pytest.raises(PlaintextStorageForbidden):
        await save_message(
            db=db,
            room_id=room.id,
            sender_id=user.id,
            content="这句正文不能进 Hub",
        )


@pytest.mark.asyncio
async def test_ws_persist_skips_xmtp_body(db):
    from app.chat.ws_handler import persist_incoming_message

    user_id = str(uuid.uuid4())
    room = Room(
        id=str(uuid.uuid4()),
        name="加密房间",
        transport="xmtp",
        xmtp_group_id="group-dev-2",
    )
    db.add(User(id=user_id, username="owner2", display_name="Owner2", user_type="human"))
    db.add(room)
    await db.commit()

    result = await persist_incoming_message(
        room_id=room.id,
        sender_id=user_id,
        sender_type="human",
        sender_name="Owner2",
        content="不能从 WebSocket 落库",
        msg_type="text",
        parent_id=None,
    )
    assert result is None
