"""Regression test: WebSocket authorization, room membership, and anti-impersonation."""

import pytest
import uuid
from starlette.websockets import WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.a2a.models import A2ATask
from app.chat.models import Message
from app.chat.service import save_message
from app.core.security import create_access_token, hash_password
from app.chat.ws_handler import handle_chat
from app.a2a import task_manager as tm


class FakeWebSocket:
    """Mock WebSocket with finite message sequence to prevent hanging loops."""
    def __init__(self, incoming=None):
        self.incoming = list(incoming or [])
        self.sent_messages = []
        self.closed_code = None
        self.closed_reason = None
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def close(self, code=1000, reason=""):
        self.closed_code = code
        self.closed_reason = reason
        raise WebSocketDisconnect(code=code, reason=reason)

    async def send_json(self, data):
        self.sent_messages.append(data)

    async def receive_json(self):
        if not self.incoming:
            # Finite input finished -> cleanly disconnect loop
            raise WebSocketDisconnect(code=1000)
        return self.incoming.pop(0)


async def _create_test_user(db: AsyncSession, username: str, user_type: str = "human", display_name: str | None = None) -> tuple[User, str]:
    user = User(
        id=str(uuid.uuid4()),
        username=username,
        display_name=display_name or f"User {username}",
        password_hash=hash_password("Pass123!"),
        user_type=user_type,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    token = create_access_token(user.id, user_type=user.user_type)
    return user, token


@pytest.mark.asyncio
async def test_ws_bad_token_rejected():
    ws = FakeWebSocket()
    with pytest.raises(WebSocketDisconnect):
        await handle_chat(ws, "any-room", token="bad-token")
    assert ws.closed_code == 4001


@pytest.mark.asyncio
async def test_ws_nonmember_rejected(db: AsyncSession):
    alice, token_alice = await _create_test_user(db, "alice_ws", user_type="human")
    bob, token_bob = await _create_test_user(db, "bob_ws", user_type="human")

    room = Room(name="Alice Room", transport="hub", created_by=alice.id)
    db.add(room)
    await db.flush()
    db.add(RoomPermission(room_id=room.id, user_id=alice.id, role="owner"))
    await db.commit()

    # Bob (non-member) tries to connect to Alice's room
    ws_bob = FakeWebSocket()
    with pytest.raises(WebSocketDisconnect):
        await handle_chat(ws_bob, room.id, token=token_bob)
    assert ws_bob.closed_code == 4003


@pytest.mark.asyncio
async def test_ws_nonexistent_room_rejected(db: AsyncSession):
    alice, token_alice = await _create_test_user(db, "alice_ws_none", user_type="human")
    fake_room_id = str(uuid.uuid4())

    ws = FakeWebSocket()
    with pytest.raises(WebSocketDisconnect):
        await handle_chat(ws, fake_room_id, token=token_alice)
    assert ws.closed_code == 4003

    check_room = await db.get(Room, fake_room_id)
    assert check_room is None


@pytest.mark.asyncio
async def test_ws_viewer_cannot_send_messages(db: AsyncSession):
    owner, token_owner = await _create_test_user(db, "owner_ws_view")
    viewer, token_viewer = await _create_test_user(db, "viewer_ws_view")

    room = Room(name="Collab Room", transport="hub", created_by=owner.id)
    db.add(room)
    await db.flush()
    db.add(RoomPermission(room_id=room.id, user_id=owner.id, role="owner"))
    db.add(RoomPermission(room_id=room.id, user_id=viewer.id, role="viewer"))
    await db.commit()

    ws = FakeWebSocket(incoming=[
        {"type": "message", "content": "Viewer posting attempt"}
    ])
    await handle_chat(ws, room.id, token=token_viewer)

    # ws.sent_messages contains presence_snapshot, then error response
    err_msgs = [m for m in ws.sent_messages if m.get("type") == "error"]
    assert len(err_msgs) == 1
    assert err_msgs[0].get("code") == "read_only"

    # Verify no message persisted
    stmt = select(Message).where(Message.room_id == room.id)
    res = await db.execute(stmt)
    assert len(res.scalars().all()) == 0


@pytest.mark.asyncio
async def test_ws_cross_room_and_agent_spoof_prevented(db: AsyncSession):
    alice, token_alice = await _create_test_user(db, "alice_spoof", display_name="Alice Real")
    bob, token_bob = await _create_test_user(db, "bob_spoof")

    room_a = Room(name="Room A", transport="hub", created_by=alice.id)
    room_b = Room(name="Room B", transport="hub", created_by=bob.id)
    db.add_all([room_a, room_b])
    await db.flush()
    db.add(RoomPermission(room_id=room_a.id, user_id=alice.id, role="owner"))
    db.add(RoomPermission(room_id=room_b.id, user_id=bob.id, role="owner"))
    await db.commit()

    # 1. Negative: cross-room injection rejected
    ws1 = FakeWebSocket(incoming=[
        {"type": "message", "content": "Attack", "target_room": room_b.id}
    ])
    await handle_chat(ws1, room_a.id, token=token_alice)
    err1 = [m for m in ws1.sent_messages if m.get("type") == "error"]
    assert len(err1) == 1
    assert err1[0].get("code") == "cross_room_denied"

    # 2. Negative: chat room cannot complete task
    ws2 = FakeWebSocket(incoming=[
        {"type": "message", "content": "Hijack task", "task_id": str(uuid.uuid4())}
    ])
    await handle_chat(ws2, room_a.id, token=token_alice)
    err2 = [m for m in ws2.sent_messages if m.get("type") == "error"]
    assert len(err2) == 1
    assert err2[0].get("code") == "task_not_authorized"

    # 3. Impersonation prevention: sender_type='agent', forged id
    ws3 = FakeWebSocket(incoming=[
        {
            "type": "message",
            "content": "Legit message",
            "sender_type": "agent",
            "sender_name": "Codex",
            "sender_id": "forged_id",
        }
    ])
    await handle_chat(ws3, room_a.id, token=token_alice)
    # Check persisted message attributes
    stmt = select(Message).where(Message.room_id == room_a.id)
    res = await db.execute(stmt)
    saved = res.scalars().first()
    assert saved is not None
    assert saved.sender_id == alice.id
    assert saved.sender_type == "human"
    assert saved.sender_name == "Alice Real"


@pytest.mark.asyncio
async def test_ws_agent_channel_and_task_matching(db: AsyncSession):
    owner, token_owner = await _create_test_user(db, "owner_agent_test", display_name="Owner")
    agent_user, token_agent = await _create_test_user(db, "codex_bot", user_type="agent", display_name="Codex Bot")
    outsider, token_outsider = await _create_test_user(db, "outsider_agent_test")

    room = Room(name="Project Room", transport="hub", created_by=owner.id)
    db.add(room)
    await db.flush()
    db.add(RoomPermission(room_id=room.id, user_id=owner.id, role="owner"))
    await db.commit()

    agent_channel = "_agent_codex_bot"

    # 1. Non-agent cannot connect to agent channel
    ws_out = FakeWebSocket()
    with pytest.raises(WebSocketDisconnect):
        await handle_chat(ws_out, agent_channel, token=token_outsider)
    assert ws_out.closed_code == 4003

    # 2. Legitimate agent connects and sends without task_id -> rejected
    ws_agent1 = FakeWebSocket(incoming=[
        {"type": "message", "content": "No task", "target_room": room.id}
    ])
    await handle_chat(ws_agent1, agent_channel, token=token_agent)
    err1 = [m for m in ws_agent1.sent_messages if m.get("type") == "error"]
    assert len(err1) == 1
    assert err1[0].get("code") == "task_required"

    # 3. Legitimate agent reply with valid task
    source_msg = await save_message(
        db=db,
        room_id=room.id,
        sender_id=owner.id,
        sender_type="human",
        content="@codex_bot run analysis",
        msg_type="text",
    )
    task_dict = await tm.submit_task(
        query="run analysis",
        target_agent="codex_bot",
        source_agent="hub",
        room_id=room.id,
        source_message_id=source_msg.id,
        route_remote=False,
    )
    task_id = task_dict["id"]

    ws_agent2 = FakeWebSocket(incoming=[
        {
            "type": "message",
            "content": "Analysis completed",
            "task_id": task_id,
            "target_room": room.id,
            "msg_type": "report",
        }
    ])
    await handle_chat(ws_agent2, agent_channel, token=token_agent)

    completed_task = await tm.get_task(task_id)
    assert completed_task["status"] == "completed"
    assert completed_task["result"][0]["content"] == "Analysis completed"
