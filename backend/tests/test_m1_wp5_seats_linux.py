"""m1/WP5: seat pause/resume lifecycle, heartbeat seats_to_pause, rooms sync.

Only synthetic users, rooms and in-process requests; no XMTP transport.
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.core.security import create_access_token
from app.helper.models import AgentSeat
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.models.user import User

BASE = "/api/v1/helpers"
ROOMS = "/api/v1/rooms"
ADDR_SEAT = "0x" + "a" * 40
ADDR_OWNER = "0x" + "c" * 40


def headers(user):
    return {"Authorization": "Bearer " + create_access_token(user.id, user.user_type)}


def _helper_headers(paired):
    return {"Authorization": f"Bearer {paired['helper_token']}"}


@pytest_asyncio.fixture
async def room_owner(db):
    owner = User(username="p5owner", display_name="Owner", user_type="human")
    db.add(owner)
    await db.commit()
    room = Room(name="wp5 room", created_by=owner.id, is_active=True)
    db.add(room)
    await db.commit()
    db.add(RoomPermission(room_id=room.id, user_id=owner.id, role="owner", invited_by=owner.id))
    await db.commit()
    return owner, room


@pytest_asyncio.fixture
async def room_member(db, room_owner):
    _, room = room_owner
    member = User(username="p5member", display_name="Member", user_type="human")
    db.add(member)
    await db.commit()
    db.add(RoomPermission(room_id=room.id, user_id=member.id, role="member",
                          invited_by=room_owner[0].id))
    await db.commit()
    return member


async def _paired_helper(client, owner, device="dev"):
    code = (await client.post(f"{BASE}/pairing-codes", headers=headers(owner))).json()["code"]
    resp = await client.post(f"{BASE}/pair",
                             json={"code": code, "device_name": device, "platform": "linux"})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _make_seat(client, paired, room_id, address=ADDR_SEAT):
    resp = await client.post(
        f"{BASE}/me/seats", headers=_helper_headers(paired),
        json={"via": "local", "room_id": room_id, "agent_key": "codex",
              "kind": "codex", "display_name": "Codex", "xmtp_address": address},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_pause_resume_lifecycle_and_heartbeat(client, db, room_owner, room_member):
    owner, room = room_owner
    paired = await _paired_helper(client, owner)
    grant = await _make_seat(client, paired, room.id)
    seat_id = grant["seat_id"]
    h = _helper_headers(paired)

    # A member who owns neither seat nor room cannot pause
    assert (await client.post(f"{ROOMS}/{room.id}/seats/{seat_id}/pause",
                              headers=headers(room_member))).status_code == 403

    # Seat owner pauses; heartbeat reports it in seats_to_pause — NEVER in
    # seats_to_stop (that list triggers destructive local cleanup).
    assert (await client.post(f"{ROOMS}/{room.id}/seats/{seat_id}/pause",
                              headers=headers(owner))).status_code == 204
    seat = await db.get(AgentSeat, seat_id)
    assert seat.paused_at is not None and seat.removed_at is None

    beat = (await client.post(f"{BASE}/me/heartbeat", headers=h,
                              json={"agents": [], "seats": []})).json()
    assert seat_id in beat["seats_to_pause"]
    assert seat_id not in beat["seats_to_stop"]

    # SeatView exposes paused_at and source
    seats = (await client.get(f"{ROOMS}/{room.id}/seats", headers=headers(owner))).json()
    assert seats[0]["paused_at"] is not None and seats[0]["source"] == "helper"

    # Pause is idempotent; resume revives only a paused seat
    assert (await client.post(f"{ROOMS}/{room.id}/seats/{seat_id}/pause",
                              headers=headers(owner))).status_code == 204
    assert (await client.post(f"{ROOMS}/{room.id}/seats/{seat_id}/resume",
                              headers=headers(owner))).status_code == 204
    await db.refresh(seat)
    assert seat.paused_at is None

    beat2 = (await client.post(f"{BASE}/me/heartbeat", headers=h,
                               json={"agents": [], "seats": []})).json()
    assert seat_id not in beat2["seats_to_pause"]

    # Pausing a removed seat is a conflict
    assert (await client.delete(f"{ROOMS}/{room.id}/seats/{seat_id}",
                                headers=headers(owner))).status_code == 204
    assert (await client.post(f"{ROOMS}/{room.id}/seats/{seat_id}/pause",
                              headers=headers(owner))).status_code == 409


@pytest.mark.asyncio
async def test_room_owner_can_pause_foreign_seat(client, db, room_owner, room_member):
    owner, room = room_owner
    paired_member = await _paired_helper(client, room_member)
    grant = await _make_seat(client, paired_member, room.id)
    seat_id = grant["seat_id"]

    assert (await client.post(f"{ROOMS}/{room.id}/seats/{seat_id}/pause",
                              headers=headers(owner))).status_code == 204
    beat = (await client.post(f"{BASE}/me/heartbeat", headers=_helper_headers(paired_member),
                              json={"agents": [], "seats": []})).json()
    assert seat_id in beat["seats_to_pause"]


@pytest.mark.asyncio
async def test_mark_group_added_allowed_for_room_owner(client, db, room_owner, room_member):
    """A4: the room owner may report group membership for a member's seat so
    owner-driven group sync can close the loop."""
    owner, room = room_owner
    paired_member = await _paired_helper(client, room_member)
    grant = await _make_seat(client, paired_member, room.id)
    seat_id = grant["seat_id"]

    assert (await client.post(f"{ROOMS}/{room.id}/seats/{seat_id}/group-added",
                              headers=headers(owner))).status_code == 204
    seat = await db.get(AgentSeat, seat_id)
    assert seat.group_status == "added"

    # A non-owner member still cannot
    other = User(username="p5other", display_name="O", user_type="human")
    db.add(other)
    await db.commit()
    db.add(RoomPermission(room_id=room.id, user_id=other.id, role="member",
                          invited_by=owner.id))
    await db.commit()
    resp = await client.post(
        f"{BASE}/me/seats", headers=_helper_headers(paired_member),
        json={"via": "local", "room_id": room.id, "agent_key": "codex2",
              "kind": "codex", "display_name": "Codex2", "xmtp_address": "0x" + "e" * 40},
    )
    assert resp.status_code == 201
    sid2 = resp.json()["seat_id"]
    assert (await client.post(f"{ROOMS}/{room.id}/seats/{sid2}/group-added",
                              headers=headers(other))).status_code == 403


@pytest.mark.asyncio
async def test_heartbeat_rooms_carries_settings_version(client, db, room_owner):
    owner, room = room_owner
    paired = await _paired_helper(client, owner)

    beat = (await client.post(f"{BASE}/me/heartbeat", headers=_helper_headers(paired),
                              json={"agents": [], "seats": []})).json()
    room_entry = [r for r in beat["rooms"] if r["id"] == room.id]
    assert room_entry and room_entry[0]["settings_version"] == 0
    assert room_entry[0]["settings_json"] is None

    settings = {"template_key": "t", "house_rules": ["rule one"]}
    patch = await client.patch(f"{ROOMS}/{room.id}/settings", headers=headers(owner),
                               json={"settings": settings})
    assert patch.status_code == 200

    beat2 = (await client.post(f"{BASE}/me/heartbeat", headers=_helper_headers(paired),
                               json={"agents": [], "seats": []})).json()
    room_entry2 = [r for r in beat2["rooms"] if r["id"] == room.id]
    assert room_entry2[0]["settings_version"] == 1
    assert room_entry2[0]["settings_json"] == settings


@pytest.mark.asyncio
async def test_remove_member_retires_agent_seats_atomically(client, db, room_owner):
    """Removing an Agent *member* retires its live seats in the same txn —
    the helper then learns via seats_to_stop."""
    owner, room = room_owner
    paired = await _paired_helper(client, owner)
    grant = await _make_seat(client, paired, room.id)

    gone = await client.delete(
        f"{ROOMS}/{room.id}/members/{grant['agent_user_id']}", headers=headers(owner)
    )
    assert gone.status_code == 200

    seat = await db.get(AgentSeat, grant["seat_id"])
    assert seat.removed_at is not None and seat.group_status == "removed"
    assert (await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == room.id,
        RoomPermission.user_id == grant["agent_user_id"]))).scalar_one_or_none() is None

    beat = (await client.post(f"{BASE}/me/heartbeat", headers=_helper_headers(paired),
                              json={"agents": [], "seats": []})).json()
    assert grant["seat_id"] in beat["seats_to_stop"]
