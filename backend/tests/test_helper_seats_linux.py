"""WP3 seat lifecycle: join tickets (S7), room roles (D4), seat reuse, S6 hygiene.

Only synthetic users, rooms and in-process requests; no XMTP or external transport.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.core.security import create_access_token, decode_access_token
from app.helper.models import AgentSeat, HelperCode
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.models.user import User

BASE = "/api/v1/helpers"
ROOMS = "/api/v1/rooms"
ADDR_SEAT = "0x" + "a" * 40
ADDR_SEAT_2 = "0x" + "b" * 40
ADDR_OWNER = "0x" + "c" * 40


def headers(user):
    return {"Authorization": "Bearer " + create_access_token(user.id, user.user_type)}


def _helper_headers(paired):
    return {"Authorization": f"Bearer {paired['helper_token']}"}


@pytest_asyncio.fixture
async def room_owner(db):
    owner = User(username="seatowner", display_name="Seat Owner", user_type="human")
    db.add(owner)
    await db.commit()
    room = Room(name="war room", created_by=owner.id, is_active=True)
    db.add(room)
    await db.commit()
    db.add(RoomPermission(room_id=room.id, user_id=owner.id, role="owner", invited_by=owner.id))
    await db.commit()
    return owner, room


@pytest_asyncio.fixture
async def room_member(db, room_owner):
    _, room = room_owner
    member = User(username="seatmember", display_name="Seat Member", user_type="human")
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


async def _join_ticket(client, owner, helper_id, room_id, agent_key="codex"):
    resp = await client.post(f"{BASE}/{helper_id}/join-tickets", headers=headers(owner),
                             json={"room_id": room_id, "agent_key": agent_key,
                                   "owner_xmtp_address": ADDR_OWNER})
    assert resp.status_code == 201, resp.text
    return resp.json()["ticket"]


def _seat_via_ticket(ticket, agent_key="codex", kind="codex", address=ADDR_SEAT):
    return {"via": "ticket", "ticket": ticket, "agent_key": agent_key,
            "kind": kind, "display_name": "Codex", "xmtp_address": address}


def _seat_via_local(room_id, agent_key="codex", kind="codex", address=ADDR_SEAT):
    return {"via": "local", "room_id": room_id, "agent_key": agent_key,
            "kind": kind, "display_name": "Codex", "xmtp_address": address}


@pytest.mark.asyncio
async def test_ticket_seat_grant_creates_agent_account_and_membership(client, db, room_owner):
    owner, room = room_owner
    paired = await _paired_helper(client, owner)
    ticket = await _join_ticket(client, owner, paired["helper_id"], room.id)
    resp = await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                             json=_seat_via_ticket(ticket))
    assert resp.status_code == 201, resp.text
    assert resp.headers["cache-control"] == "no-store"
    grant = resp.json()
    assert grant["room_id"] == room.id and grant["room_name"] == room.name
    assert grant["allowed_senders"] == [ADDR_OWNER]
    assert grant["xmtp_group_id"] == room.xmtp_group_id

    agent = await db.get(User, grant["agent_user_id"])
    assert agent.user_type == "agent" and agent.owner_user_id == owner.id
    assert agent.username == grant["agent_username"]
    # The member-process token is an agent token, never the owner's (plan F5 fix),
    # and this path never consults MAPR_AGENT_ENROLLMENT_SECRET.
    payload = decode_access_token(grant["agent_token"])
    assert payload["sub"] == agent.id and payload["typ"] == "agent"

    perm = (await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == room.id,
        RoomPermission.user_id == agent.id))).scalar_one()
    assert perm.role == "member" and perm.invited_by == owner.id
    seat = (await db.execute(select(AgentSeat).where(
        AgentSeat.room_id == room.id))).scalar_one()
    assert seat.helper_id == paired["helper_id"] and seat.group_status == "pending"
    assert seat.xmtp_address == ADDR_SEAT


@pytest.mark.asyncio
async def test_ticket_single_use_under_concurrency(client, db, room_owner):
    owner, room = room_owner
    paired = await _paired_helper(client, owner)
    ticket = await _join_ticket(client, owner, paired["helper_id"], room.id)
    first, second = await asyncio.gather(
        client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                    json=_seat_via_ticket(ticket, address=ADDR_SEAT)),
        client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                    json=_seat_via_ticket(ticket, address=ADDR_SEAT_2)),
    )
    assert sorted(r.status_code for r in (first, second)) == [201, 409]
    seats = (await db.execute(select(AgentSeat).where(
        AgentSeat.room_id == room.id))).scalars().all()
    assert len(seats) == 1
    code_row = await db.get(HelperCode, ticket.split(".")[0][len("mjt_"):])
    assert code_row.consumed_at is not None


@pytest.mark.asyncio
async def test_ticket_bound_to_issuing_helper_and_expired(client, db, room_owner):
    owner, room = room_owner
    paired_a = await _paired_helper(client, owner, "dev-a")
    paired_b = await _paired_helper(client, owner, "dev-b")
    ticket = await _join_ticket(client, owner, paired_a["helper_id"], room.id)

    # A ticket only works for the helper it was issued to (S7), and a failed
    # attempt must not consume it.
    deny = await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired_b),
                             json=_seat_via_ticket(ticket))
    assert deny.status_code == 409
    assert ticket not in deny.text
    ok = await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired_a),
                           json=_seat_via_ticket(ticket))
    assert ok.status_code == 201

    expired = await _join_ticket(client, owner, paired_b["helper_id"], room.id)
    record = await db.get(HelperCode, expired.split(".")[0][len("mjt_"):])
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()
    assert (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired_b),
                              json=_seat_via_ticket(expired))).status_code == 409


@pytest.mark.asyncio
async def test_local_join_and_role_boundaries(client, db, room_owner, room_member):
    owner, room = room_owner
    viewer = User(username="viewonly", display_name="V", user_type="human")
    outsider = User(username="outsider", display_name="O", user_type="human")
    db.add_all([viewer, outsider])
    await db.commit()
    db.add(RoomPermission(room_id=room.id, user_id=viewer.id, role="viewer",
                          invited_by=owner.id))
    await db.commit()
    paired_viewer = await _paired_helper(client, viewer)
    paired_member = await _paired_helper(client, room_member)
    paired_out = await _paired_helper(client, outsider)

    # Decision D4: viewers and non-members may not bring agents; members may.
    ticket_req = {"room_id": room.id, "agent_key": "codex", "owner_xmtp_address": ADDR_OWNER}
    assert (await client.post(f"{BASE}/{paired_viewer['helper_id']}/join-tickets",
                              headers=headers(viewer), json=ticket_req)).status_code == 403
    assert (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired_viewer),
                              json=_seat_via_local(room.id))).status_code == 403
    assert (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired_out),
                              json=_seat_via_local(room.id))).status_code == 403

    ok = await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired_member),
                           json=_seat_via_local(room.id))
    assert ok.status_code == 201
    assert ok.json()["allowed_senders"] == []


@pytest.mark.asyncio
async def test_agent_account_reused_across_rooms_and_helpers(client, db, room_owner):
    owner, room = room_owner
    room2 = Room(name="second room", created_by=owner.id, is_active=True)
    db.add(room2)
    await db.commit()
    db.add(RoomPermission(room_id=room2.id, user_id=owner.id, role="member",
                          invited_by=owner.id))
    await db.commit()
    paired = await _paired_helper(client, owner)
    first = (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                               json=_seat_via_local(room.id))).json()
    second = (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                                json=_seat_via_local(room2.id, address=ADDR_SEAT_2))).json()
    assert first["agent_user_id"] == second["agent_user_id"]
    paired2 = await _paired_helper(client, owner, "dev-2")
    third = (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired2),
                               json=_seat_via_local(room.id, address=ADDR_OWNER))).json()
    assert third["agent_user_id"] == first["agent_user_id"]
    agents = (await db.execute(select(User).where(
        User.user_type == "agent", User.owner_user_id == owner.id))).scalars().all()
    assert len(agents) == 1


@pytest.mark.asyncio
async def test_room_seats_listing_group_added_and_non_member(client, db, room_owner, room_member):
    owner, room = room_owner
    stranger = User(username="stranger", display_name="S", user_type="human")
    db.add(stranger)
    await db.commit()
    paired = await _paired_helper(client, owner)
    grant = (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                               json=_seat_via_local(room.id))).json()

    seats = (await client.get(f"{ROOMS}/{room.id}/seats", headers=headers(room_member))).json()
    assert [s["seat_id"] for s in seats] == [grant["seat_id"]]
    assert seats[0]["owner_user_id"] == owner.id
    assert seats[0]["xmtp_address"] == ADDR_SEAT
    assert seats[0]["group_status"] == "pending"
    assert (await client.get(f"{ROOMS}/{room.id}/seats", headers=headers(stranger))).status_code == 403

    path = f"{ROOMS}/{room.id}/seats/{grant['seat_id']}/group-added"
    # only the seat owner may report, and it is idempotent
    assert (await client.post(path, headers=headers(room_member))).status_code == 403
    assert (await client.post(path, headers=headers(owner))).status_code == 204
    assert (await client.post(path, headers=headers(owner))).status_code == 204
    status = (await client.get(f"{BASE}/me/seats/{grant['seat_id']}",
                               headers=_helper_headers(paired))).json()
    assert status["group_status"] == "added"


@pytest.mark.asyncio
async def test_seat_removal_rejoin_and_room_owner_removal(client, db, room_owner, room_member):
    owner, room = room_owner
    paired = await _paired_helper(client, owner)
    grant = (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                               json=_seat_via_local(room.id))).json()

    # a member who owns neither seat nor room cannot remove it
    assert (await client.delete(f"{ROOMS}/{room.id}/seats/{grant['seat_id']}",
                                headers=headers(room_member))).status_code == 403
    # the helper retires its own seat; membership is released
    assert (await client.delete(f"{BASE}/me/seats/{grant['seat_id']}",
                                headers=_helper_headers(paired))).status_code == 204
    assert (await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == room.id,
        RoomPermission.user_id == grant["agent_user_id"]))).scalar_one_or_none() is None
    assert (await client.get(f"{BASE}/me/seats/{grant['seat_id']}",
                             headers=_helper_headers(paired))).json()["group_status"] == "removed"
    beat = (await client.post(f"{BASE}/me/heartbeat", headers=_helper_headers(paired),
                              json={"agents": [], "seats": []})).json()
    assert beat["revoked"] is False and grant["seat_id"] in beat["seats_to_stop"]

    # re-joining reuses the same seat row
    again = (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                               json=_seat_via_local(room.id, address=ADDR_SEAT_2))).json()
    assert again["seat_id"] == grant["seat_id"]
    seat = (await db.execute(select(AgentSeat).where(
        AgentSeat.room_id == room.id))).scalar_one()
    assert seat.group_status == "pending" and seat.removed_at is None
    assert seat.xmtp_address == ADDR_SEAT_2


@pytest.mark.asyncio
async def test_room_owner_can_remove_foreign_seat(client, db, room_owner, room_member):
    """The room owner may remove a seat owned by someone else (member's helper)."""
    owner, room = room_owner
    paired_member = await _paired_helper(client, room_member)
    grant = (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired_member),
                               json=_seat_via_local(room.id))).json()
    assert (await client.delete(f"{ROOMS}/{room.id}/seats/{grant['seat_id']}",
                                headers=headers(owner))).status_code == 204
    seat = (await db.execute(select(AgentSeat).where(
        AgentSeat.id == grant["seat_id"]))).scalar_one()
    assert seat.removed_at is not None and seat.group_status == "removed"
    # the member's agent lost its room membership along with the seat
    assert (await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == room.id,
        RoomPermission.user_id == grant["agent_user_id"]))).scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_refresh_token_revocation_and_foreign_helper(client, db, room_owner):
    owner, room = room_owner
    paired = await _paired_helper(client, owner)
    other_helper = await _paired_helper(client, owner, "dev-2")
    grant = (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                               json=_seat_via_local(room.id))).json()

    refreshed = await client.post(f"{BASE}/me/seats/{grant['seat_id']}/token",
                                  headers=_helper_headers(paired))
    assert refreshed.status_code == 200
    payload = decode_access_token(refreshed.json()["agent_token"])
    assert payload["sub"] == grant["agent_user_id"] and payload["typ"] == "agent"

    # another helper of the same owner cannot touch this seat
    assert (await client.get(f"{BASE}/me/seats/{grant['seat_id']}",
                             headers=_helper_headers(other_helper))).status_code == 404
    assert (await client.delete(f"{BASE}/me/seats/{grant['seat_id']}",
                                headers=_helper_headers(other_helper))).status_code == 404

    # revocation: strict endpoints 401, heartbeat reports revoked + seats to stop
    assert (await client.delete(f"{BASE}/{paired['helper_id']}", headers=headers(owner))).status_code == 204
    assert (await client.get(f"{BASE}/me/seats/{grant['seat_id']}",
                             headers=_helper_headers(paired))).status_code == 401
    beat = (await client.post(f"{BASE}/me/heartbeat", headers=_helper_headers(paired),
                              json={"agents": [], "seats": []})).json()
    assert beat["revoked"] is True and grant["seat_id"] in beat["seats_to_stop"]


@pytest.mark.asyncio
async def test_helper_rooms_listing(client, db, room_owner, room_member):
    _, room = room_owner
    paired = await _paired_helper(client, room_member)
    rooms = (await client.get(f"{BASE}/me/rooms", headers=_helper_headers(paired))).json()
    assert rooms == [{"id": room.id, "name": room.name,
                      "xmtp_group_id": room.xmtp_group_id, "role": "member"}]


@pytest.mark.asyncio
async def test_no_secrets_in_logs_or_error_responses(client, db, room_owner, caplog):
    owner, room = room_owner
    paired = await _paired_helper(client, owner)
    ticket = await _join_ticket(client, owner, paired["helper_id"], room.id)
    grant_resp = await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                                   json=_seat_via_ticket(ticket))
    assert grant_resp.status_code == 201
    grant = grant_resp.json()
    replay = await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                               json=_seat_via_ticket(ticket))
    assert replay.status_code == 409
    deny = await client.get(f"{BASE}/me/rooms",
                            headers={"Authorization": f"Bearer {paired['helper_token']}x"})
    assert deny.status_code == 401
    for secret in (ticket, paired["helper_token"], grant["agent_token"]):
        assert secret not in replay.text + deny.text + caplog.text


@pytest.mark.asyncio
async def test_seat_peers_agent_and_human_access(client, db, room_owner, room_member):
    """seat-peers：本房席位的 Agent 账号可读；人类需成员身份；外人双方皆拒。"""
    owner, room = room_owner
    paired = await _paired_helper(client, owner)
    grant = (await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                               json=_seat_via_local(room.id))).json()

    # 席位自己的 agent_token 可读同伴名单，且带信任分级
    peers = (await client.get(f"{ROOMS}/{room.id}/seat-peers",
                              headers={"Authorization": f"Bearer {grant['agent_token']}"})).json()
    assert [p["xmtp_address"] for p in peers] == [ADDR_SEAT]
    assert peers[0]["agent_display_name"] == "Codex"
    assert peers[0]["trust_tier"] == "local-cli"

    # 房间人类成员也可读
    human = await client.get(f"{ROOMS}/{room.id}/seat-peers", headers=headers(room_member))
    assert human.status_code == 200

    # 非成员人类与无席位 Agent 皆拒
    stranger = User(username="peerstranger", display_name="S", user_type="human")
    db.add(stranger)
    outsider_agent = User(username="peeragent", display_name="A", user_type="agent")
    db.add(outsider_agent)
    await db.commit()
    assert (await client.get(f"{ROOMS}/{room.id}/seat-peers",
                             headers=headers(stranger))).status_code == 403
    assert (await client.get(f"{ROOMS}/{room.id}/seat-peers",
                             headers=headers(outsider_agent))).status_code == 403

    # 席位被移除后，它的 Agent 账号立即失去读取权
    await client.delete(f"{BASE}/me/seats/{grant['seat_id']}", headers=_helper_headers(paired))
    assert (await client.get(f"{ROOMS}/{room.id}/seat-peers",
                             headers={"Authorization": f"Bearer {grant['agent_token']}"})).status_code == 403


@pytest.mark.asyncio
async def test_seat_view_carries_trust_tier(client, db, room_owner):
    """SeatView 带 trust_tier：webhook/openai-compatible 与本地 CLI 分级不同。"""
    owner, room = room_owner
    paired = await _paired_helper(client, owner)
    await client.post(f"{BASE}/me/seats", headers=_helper_headers(paired),
                      json=_seat_via_local(room.id))
    seats = (await client.get(f"{ROOMS}/{room.id}/seats", headers=headers(owner))).json()
    assert seats[0]["trust_tier"] == "local-cli"
