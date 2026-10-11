"""Authorization regressions for the legacy dialogue JSON-RPC methods."""

from __future__ import annotations

import asyncio
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.a2a import server
from app.core.security import create_access_token
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.models.user import User


@pytest.fixture(autouse=True)
def clear_dialogue_state():
    server.DIALOGUES.clear()
    server.RUNNING_LOOPS.clear()
    yield
    server.DIALOGUES.clear()
    server.RUNNING_LOOPS.clear()


async def add_user(db, username: str) -> User:
    user = User(
        id=str(uuid.uuid4()), username=username, display_name=username,
        user_type="human",
    )
    db.add(user)
    await db.flush()
    return user


async def add_room(db, room_id: str, owner: User | None = None) -> Room:
    room = Room(
        id=room_id, name=room_id, created_by=owner.id if owner else None,
        transport="hub",
    )
    db.add(room)
    await db.flush()
    if owner:
        db.add(RoomPermission(room_id=room_id, user_id=owner.id, role="owner"))
        await db.flush()
    return room


def create_params(room_id: str) -> dict:
    return {
        "room_id": room_id,
        "initiator_agent": "Agent A",
        "participants": ["Agent B"],
    }


def dialogue(dialogue_id: str, room_id: str) -> dict:
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    return {
        "dialogue_id": dialogue_id,
        "room_id": room_id,
        "created_by_user_id": "creator",
        "initiator_agent": "Agent A",
        "participants": ["Agent A", "Agent B"],
        "status": "active",
        "current_turn": 0,
        "max_turns": 8,
        "created_at": now,
        "expires_at": now + timedelta(minutes=5),
        "ended_at": None,
        "reason": None,
    }


@pytest.mark.asyncio
async def test_create_does_not_claim_existing_orphan_room(db):
    outsider = await add_user(db, "outsider")
    await add_room(db, "orphan-room")
    await db.commit()

    with pytest.raises(HTTPException) as exc:
        await server.rpc_dialogues_create(create_params("orphan-room"), outsider)

    assert exc.value.status_code == 403
    assert not server.DIALOGUES
    result = await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == "orphan-room", RoomPermission.user_id == outsider.id,
    ))
    assert result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_create_requires_member_and_viewer_cannot_create(db):
    owner = await add_user(db, "owner")
    viewer = await add_user(db, "viewer")
    await add_room(db, "shared-room", owner)
    db.add(RoomPermission(room_id="shared-room", user_id=viewer.id, role="viewer"))
    await db.commit()

    with pytest.raises(HTTPException) as exc:
        await server.rpc_dialogues_create(create_params("shared-room"), viewer)

    assert exc.value.status_code == 403
    assert not server.DIALOGUES


@pytest.mark.asyncio
async def test_create_still_creates_new_room_with_owner_permission(db):
    owner = await add_user(db, "new-owner")
    await db.commit()

    result = await server.rpc_dialogues_create(create_params("new-room"), owner)

    assert result["room_id"] == "new-room"
    permission = await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == "new-room", RoomPermission.user_id == owner.id,
    ))
    assert permission.scalar_one().role == "owner"


@pytest.mark.asyncio
async def test_create_allows_existing_room_member(db):
    owner = await add_user(db, "member-room-owner")
    member = await add_user(db, "member-room-user")
    await add_room(db, "member-room", owner)
    db.add(RoomPermission(room_id="member-room", user_id=member.id, role="member"))
    await db.commit()

    result = await server.rpc_dialogues_create(create_params("member-room"), member)

    assert result["room_id"] == "member-room"


@pytest.mark.asyncio
async def test_send_does_not_claim_orphan_room_and_does_not_impersonate_real_user(db):
    owner = await add_user(db, "sender-owner")
    outsider = await add_user(db, "sender-outsider")
    await add_room(db, "dialogue-room")
    await db.commit()
    server.DIALOGUES["send-dialogue"] = dialogue("send-dialogue", "dialogue-room")
    params = {
        "dialogue_id": "send-dialogue", "content": "hello",
        "sender_id": outsider.id, "sender_name": "Agent A",
    }

    with pytest.raises(HTTPException) as exc:
        await server.rpc_dialogues_send(params, outsider)

    assert exc.value.status_code == 403
    permission = await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == "dialogue-room", RoomPermission.user_id == outsider.id,
    ))
    assert permission.scalar_one_or_none() is None

    db.add(RoomPermission(room_id="dialogue-room", user_id=owner.id, role="owner"))
    db.add(RoomPermission(room_id="dialogue-room", user_id=outsider.id, role="member"))
    await db.commit()
    params["sender_id"] = owner.id
    with pytest.raises(HTTPException) as impersonation:
        await server.rpc_dialogues_send(params, outsider)
    assert impersonation.value.status_code == 403


@pytest.mark.asyncio
async def test_send_rejects_viewer(db):
    owner = await add_user(db, "dialogue-owner")
    viewer = await add_user(db, "dialogue-viewer")
    await add_room(db, "send-room", owner)
    db.add(RoomPermission(room_id="send-room", user_id=viewer.id, role="viewer"))
    await db.commit()
    server.DIALOGUES["viewer-send"] = dialogue("viewer-send", "send-room")

    with pytest.raises(HTTPException) as exc:
        await server.rpc_dialogues_send({
            "dialogue_id": "viewer-send", "content": "hello",
            "sender_id": viewer.id, "sender_name": "Agent A",
        }, viewer)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_end_requires_member_permission_and_allows_room_member(db, monkeypatch):
    owner = await add_user(db, "end-owner")
    outsider = await add_user(db, "end-outsider")
    member = await add_user(db, "end-member")
    await add_room(db, "end-room", owner)
    db.add(RoomPermission(room_id="end-room", user_id=member.id, role="member"))
    await db.commit()
    server.DIALOGUES["end-dialogue"] = dialogue("end-dialogue", "end-room")
    original_create_task = asyncio.create_task

    def without_cleanup(coro, *args, **kwargs):
        if coro.cr_code.co_name == "_delayed_cleanup":
            coro.close()
            return None
        return original_create_task(coro, *args, **kwargs)

    monkeypatch.setattr(asyncio, "create_task", without_cleanup)

    with pytest.raises(HTTPException) as exc:
        await server.rpc_dialogues_end({"dialogue_id": "end-dialogue"}, outsider)
    assert exc.value.status_code == 403
    assert server.DIALOGUES["end-dialogue"]["status"] == "active"

    await server.rpc_dialogues_end({"dialogue_id": "end-dialogue"}, member)
    assert server.DIALOGUES["end-dialogue"]["status"] == "ended"


@pytest.mark.asyncio
async def test_run_requires_existing_room_member_before_creating_dialogue(db, monkeypatch):
    owner = await add_user(db, "run-owner")
    outsider = await add_user(db, "run-outsider")
    await add_room(db, "run-room", owner)
    await db.commit()
    spawned = []

    original_create_task = asyncio.create_task

    def fake_create_task(coro, *args, **kwargs):
        if coro.cr_code.co_name == "_run_dialogue_loop":
            spawned.append(coro)
            coro.close()
            return None
        return original_create_task(coro, *args, **kwargs)

    monkeypatch.setattr(asyncio, "create_task", fake_create_task)
    params = {"room_id": "run-room", "participants": ["Agent B"]}

    with pytest.raises(HTTPException) as exc:
        await server.rpc_dialogues_run(params, outsider)
    assert exc.value.status_code == 403
    assert not server.DIALOGUES
    assert spawned == []

    with pytest.raises(HTTPException) as missing:
        await server.rpc_dialogues_run({"room_id": "missing-run-room", "participants": ["Agent B"]}, owner)
    assert missing.value.status_code == 404
    assert await db.get(Room, "missing-run-room") is None

    result = await server.rpc_dialogues_run(params, owner)
    assert result["dialogue_id"] in server.DIALOGUES
    assert len(spawned) == 1


@pytest.mark.asyncio
async def test_status_requires_viewer_and_hides_missing_room_dialogue(db):
    owner = await add_user(db, "status-owner")
    viewer = await add_user(db, "status-viewer")
    outsider = await add_user(db, "status-outsider")
    await add_room(db, "status-room", owner)
    db.add(RoomPermission(room_id="status-room", user_id=viewer.id, role="viewer"))
    await db.commit()
    server.DIALOGUES["status-dialogue"] = dialogue("status-dialogue", "status-room")

    with pytest.raises(HTTPException) as exc:
        await server.rpc_dialogues_status({"dialogue_id": "status-dialogue"}, outsider)
    assert exc.value.status_code == 403
    assert (await server.rpc_dialogues_status(
        {"dialogue_id": "status-dialogue"}, viewer,
    ))["dialogue_id"] == "status-dialogue"

    server.DIALOGUES["deleted-room-dialogue"] = dialogue("deleted-room-dialogue", "deleted-room")
    with pytest.raises(HTTPException) as missing:
        await server.rpc_dialogues_status({"dialogue_id": "deleted-room-dialogue"}, owner)
    assert missing.value.status_code == 404


@pytest.mark.asyncio
async def test_dialogue_rpc_injects_authenticated_user_for_run(db, client, monkeypatch):
    owner = await add_user(db, "rpc-run-owner")
    await add_room(db, "rpc-run-room", owner)
    await db.commit()
    original_create_task = asyncio.create_task
    spawned = []

    def fake_create_task(coro, *args, **kwargs):
        if coro.cr_code.co_name == "_run_dialogue_loop":
            spawned.append(coro)
            coro.close()
            return None
        return original_create_task(coro, *args, **kwargs)

    monkeypatch.setattr(asyncio, "create_task", fake_create_task)
    response = await client.post(
        "/a2a/dialogue-rpc",
        headers={"Authorization": f"Bearer {create_access_token(owner.id, owner.user_type)}"},
        json={
            "jsonrpc": "2.0", "method": "dialogues/run",
            "params": {"room_id": "rpc-run-room", "participants": ["Agent B"]},
            "id": "test-run",
        },
    )

    assert response.status_code == 200
    assert response.json()["result"]["room_id"] == "rpc-run-room"
    assert len(spawned) == 1

