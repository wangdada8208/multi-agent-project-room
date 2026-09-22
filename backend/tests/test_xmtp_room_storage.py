import uuid
import pytest
from app.chat.plaintext_guard import PlaintextStorageForbidden
from app.chat.service import get_or_create_room, save_message
from app.models.room import Room
from app.models.user import User


def test_room_transport_defaults_to_xmtp():
    room = Room(name="新房间")
    assert room.transport == "xmtp"
    assert room.xmtp_group_id is None
    payload = room.to_dict()
    assert payload["transport"] == "xmtp"
    assert payload["xmtp_group_id"] is None
    assert "wallet" not in payload
    assert "key" not in payload


@pytest.mark.asyncio
async def test_get_or_create_user_room_is_xmtp(db):
    room = await get_or_create_room(db, "visible-room", name="可见房间")
    assert room.transport == "xmtp"


@pytest.mark.asyncio
async def test_get_or_create_agent_channel_stays_hub(db):
    room = await get_or_create_room(db, "_agent_codex", name="通道")
    assert room.transport == "hub"
    assert room.is_active is False


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


@pytest.mark.asyncio
async def test_bind_xmtp_group_rejects_content_field(client, auth_headers):
    created = await client.post(
        "/api/v1/rooms",
        headers=auth_headers,
        json={"name": "待绑定", "description": ""},
    )
    assert created.status_code == 200
    room_id = created.json()["room"]["id"]

    rejected = await client.post(
        f"/api/v1/rooms/{room_id}/xmtp-binding",
        headers=auth_headers,
        json={
            "xmtp_group_id": "group-dev-3",
            "content": "这句不该出现在请求契约里",
        },
    )
    assert rejected.status_code == 422

    bound = await client.post(
        f"/api/v1/rooms/{room_id}/xmtp-binding",
        headers=auth_headers,
        json={"xmtp_group_id": "group-dev-3"},
    )
    assert bound.status_code == 200
    body = bound.json()
    assert body["transport"] == "xmtp"
    assert body["xmtp_group_id"] == "group-dev-3"
    assert "content" not in body


@pytest.mark.asyncio
async def test_search_xmtp_room_has_no_body(client, auth_headers, db):
    created = await client.post(
        "/api/v1/rooms",
        headers=auth_headers,
        json={"name": "新加密房间", "description": ""},
    )
    room_id = created.json()["room"]["id"]
    await client.post(
        f"/api/v1/rooms/{room_id}/xmtp-binding",
        headers=auth_headers,
        json={"xmtp_group_id": "group-dev-8"},
    )
    found = await client.get(
        f"/api/v1/rooms/{room_id}/messages/search",
        headers=auth_headers,
        params={"q": "任意正文"},
    )
    assert found.status_code == 200
    body = found.json()
    assert body["results"] == []
    assert body["reason"] == "body_not_on_hub"


@pytest.mark.asyncio
async def test_unknown_room_does_not_store_plaintext(db):
    from app.chat.ws_handler import persist_incoming_message
    from app.models.room import Room

    user_id = str(uuid.uuid4())
    room_id = str(uuid.uuid4())
    db.add(User(id=user_id, username="stranger", display_name="Stranger", user_type="human"))
    await db.commit()

    result = await persist_incoming_message(
        room_id=room_id,
        sender_id=user_id,
        sender_type="human",
        sender_name="Stranger",
        content="不能因临时建房而落库",
        msg_type="text",
        parent_id=None,
    )
    assert result is None
    room = await db.get(Room, room_id)
    assert room is not None
    assert room.transport == "xmtp"


@pytest.mark.asyncio
async def test_create_room_rejects_unknown_transport(client, auth_headers):
    rejected = await client.post(
        "/api/v1/rooms",
        headers=auth_headers,
        json={"name": "坏通道", "description": "", "transport": "plaintext"},
    )
    assert rejected.status_code == 422


@pytest.mark.asyncio
async def test_create_room_rejects_hub_transport(client, auth_headers):
    rejected = await client.post(
        "/api/v1/rooms",
        headers=auth_headers,
        json={"name": "旧房间", "description": "", "transport": "hub"},
    )
    assert rejected.status_code == 422

