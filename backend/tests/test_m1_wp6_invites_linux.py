"""m1/WP6: reusable invites, EIP-191 address proofs, cloud agent registration.

Only synthetic users, rooms and in-process requests; real EIP-191 signatures
are produced with eth_account wallets — no private key material leaves the
test process.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import asyncio
import sqlite3

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, select

from conftest import engine as isolated_engine

from _signing import (
    agent_register_poll,
    agent_register_signed,
    bind_address_signed,
    new_wallet,
    redeem_signed,
    signed_proof,
)
from app.core.eip191 import ACTION_AGENT_REGISTER, MAX_LIVE_NONCES_PER_ADDRESS
from app.core.security import create_access_token, decode_access_token
from app.helper.models import AgentSeat
from app.models.room_invite import RoomInvite
from app.models.room_invite_redemption import RoomInviteRedemption
from app.models.room_permission import RoomPermission
from app.models.user import User


def headers(user):
    return {"Authorization": "Bearer " + create_access_token(user.id, user.user_type)}


async def _register(client, username: str) -> dict[str, str]:
    resp = await client.post(
        "/api/v1/auth/register",
        json={"username": username, "password": "secret123", "display_name": username},
    )
    assert resp.status_code in (200, 201), resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _create_room(client, auth_headers) -> str:
    created = await client.post(
        "/api/v1/rooms", headers=auth_headers, json={"name": "m1 房间"}
    )
    assert created.status_code == 200, created.text
    room_id = created.json()["room"]["id"]
    bound = await client.post(
        f"/api/v1/rooms/{room_id}/xmtp-binding",
        headers=auth_headers,
        json={"xmtp_group_id": "m1-group-1"},
    )
    assert bound.status_code == 200, bound.text
    return room_id


async def _make_invite(client, auth_headers, room_id: str, **kwargs) -> str:
    resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites", headers=auth_headers, json=kwargs
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["invite"]["token"]


@pytest.mark.asyncio
async def test_redeem_requires_valid_signature_and_burns_nonce(client, auth_headers):
    """Unsigned/foreign-signed/mismatched proofs are rejected; a consumed
    nonce cannot be replayed."""
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(client, auth_headers, room_id)

    # No proof at all → 422 (address-only squatting is dead)
    bare = await client.post(
        f"/api/v1/invites/{token}/redeem", json={"xmtp_address": "0x" + "1" * 40}
    )
    assert bare.status_code == 422

    # Signed by a DIFFERENT wallet than the claimed address → 422
    victim = new_wallet()
    attacker = new_wallet()
    proof = await signed_proof(client, "invite-redeem", token, attacker)
    forged = await client.post(
        f"/api/v1/invites/{token}/redeem",
        json={"xmtp_address": victim.address, **proof},
    )
    assert forged.status_code == 422

    # A nonce issued for a DIFFERENT token cannot be spent here → 422
    other_proof = await signed_proof(client, "invite-redeem", "other-token", victim)
    wrong_resource = await client.post(
        f"/api/v1/invites/{token}/redeem",
        json={"xmtp_address": victim.address, **other_proof},
    )
    assert wrong_resource.status_code == 422

    # Real proof succeeds; replaying the SAME proof → 409 (nonce single-use)
    ok = await client.post(
        f"/api/v1/invites/{token}/redeem",
        json={"xmtp_address": attacker.address, **await signed_proof(client, "invite-redeem", token, attacker)},
    )
    assert ok.status_code == 200, ok.text
    proof2 = await signed_proof(client, "invite-redeem", token, attacker)
    first = await client.post(
        f"/api/v1/invites/{token}/redeem",
        json={"xmtp_address": attacker.address, **proof2},
    )
    assert first.status_code == 200  # idempotent re-redemption of the same address
    second = await client.post(
        f"/api/v1/invites/{token}/redeem",
        json={"xmtp_address": attacker.address, **proof2},
    )
    assert second.status_code == 409  # same nonce+signature pair is replay → rejected


@pytest.mark.asyncio
async def test_multi_use_invite_consumes_capacity_atomically(client, auth_headers, db):
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(client, auth_headers, room_id, max_uses=2)

    info = (await client.get(f"/api/v1/invites/{token}")).json()
    assert info["remaining_uses"] == 2 and info["max_uses"] == 2

    w1, w2, w3 = new_wallet(), new_wallet(), new_wallet()
    assert (await redeem_signed(client, token, w1)).status_code == 200
    assert (await redeem_signed(client, token, w2)).status_code == 200

    info2 = (await client.get(f"/api/v1/invites/{token}")).json()
    assert info2["remaining_uses"] == 0

    third = await redeem_signed(client, token, w3)
    assert third.status_code == 409

    invite = await db.get(RoomInvite, token)
    assert invite.use_count == 2

    # Every successful redemption has its own audit row
    rows = (await db.execute(select(RoomInviteRedemption).where(
        RoomInviteRedemption.token == token))).scalars().all()
    assert len(rows) == 2
    assert {r.status for r in rows} == {"consumed"}
    assert {r.redeemer_address for r in rows} == {w1.address.lower(), w2.address.lower()}


@pytest.mark.asyncio
async def test_agent_register_creates_seat_user_and_membership(client, auth_headers, db):
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(
        client, auth_headers, room_id, proposed_scopes=["calendar.free_busy", "task.run"]
    )

    wallet = new_wallet()
    resp = await agent_register_signed(client, token, wallet, display_name="Cloud Codex")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["status"] == "consumed"
    assert data["room_id"] == room_id
    assert data["xmtp_group_id"] == "m1-group-1"
    assert data["approved_scopes"] == ["calendar.free_busy", "task.run"]

    payload = decode_access_token(data["agent_token"])
    assert payload["typ"] == "agent" and payload["sub"] == data["agent_user_id"]

    agent_user = await db.get(User, data["agent_user_id"])
    assert agent_user.user_type == "agent"
    assert agent_user.username == f"agent-xmtp-{wallet.address.lower()}"

    seat = await db.get(AgentSeat, data["seat_id"])
    assert seat.helper_id is None and seat.source == "invite"
    assert seat.xmtp_address == wallet.address.lower()
    assert seat.group_status == "pending"

    perm = (await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == room_id,
        RoomPermission.user_id == agent_user.id))).scalar_one()
    assert perm.role == "member" and perm.xmtp_address == wallet.address.lower()

    # The invite seat is visible in the room seat listing with source='invite'
    seats = (await client.get(f"/api/v1/rooms/{room_id}/seats", headers=auth_headers)).json()
    invite_seats = [s for s in seats if s["seat_id"] == seat.id]
    assert invite_seats and invite_seats[0]["source"] == "invite"
    assert invite_seats[0]["paused_at"] is None

    # Re-registering with the same wallet is idempotent (fresh token, same seat)
    again = await agent_register_signed(client, token, wallet)
    assert again.status_code == 200
    assert again.json()["seat_id"] == seat.id


@pytest.mark.asyncio
async def test_requires_approval_pending_then_approve_then_token(client, auth_headers, db):
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(
        client, auth_headers, room_id, requires_approval=True, max_uses=1,
        proposed_scopes=["task.run"],
    )

    wallet = new_wallet()
    pending = await agent_register_signed(client, token, wallet)
    assert pending.status_code == 200
    assert pending.json()["status"] == "pending"
    redemption_id = pending.json()["redemption_id"]

    # Pending must NOT consume capacity
    invite = await db.get(RoomInvite, token)
    assert invite.use_count == 0

    # Poll before approval → still pending, no token
    poll = await agent_register_poll(client, token, wallet)
    assert poll.status_code == 200 and poll.json()["status"] == "pending"
    assert "agent_token" not in poll.json()

    # Owner sees it in the pending queue
    queue = await client.get(
        f"/api/v1/rooms/{room_id}/redemptions?status=pending", headers=auth_headers
    )
    assert queue.status_code == 200
    assert [r["id"] for r in queue.json()["redemptions"]] == [redemption_id]
    assert queue.json()["redemptions"][0]["redeemer_address"] == wallet.address.lower()

    # Non-owner cannot approve
    other = await _register(client, "m1_outsider")
    denied = await client.post(
        f"/api/v1/rooms/{room_id}/redemptions/{redemption_id}/approve",
        headers=other, json={},
    )
    assert denied.status_code == 403

    # approved_scopes must be a subset of proposed_scopes
    bad = await client.post(
        f"/api/v1/rooms/{room_id}/redemptions/{redemption_id}/approve",
        headers=auth_headers, json={"approved_scopes": ["payment.send"]},
    )
    assert bad.status_code == 422
    superset = await client.post(
        f"/api/v1/rooms/{room_id}/redemptions/{redemption_id}/approve",
        headers=auth_headers, json={"approved_scopes": ["email.receipt"]},
    )
    assert superset.status_code == 422

    approved = await client.post(
        f"/api/v1/rooms/{room_id}/redemptions/{redemption_id}/approve",
        headers=auth_headers, json={"approved_scopes": ["task.run"]},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["redemption"]["status"] == "approved"
    assert approved.json()["redemption"]["approved_scopes"] == ["task.run"]

    await db.refresh(invite)
    assert invite.use_count == 1

    # Poll now delivers the agent token exactly once the seat exists
    poll2 = await agent_register_poll(client, token, wallet)
    assert poll2.status_code == 200, poll2.text
    assert poll2.json()["status"] == "consumed"
    token_payload = decode_access_token(poll2.json()["agent_token"])
    assert token_payload["typ"] == "agent"

    # Second approve is a no-op conflict
    again = await client.post(
        f"/api/v1/rooms/{room_id}/redemptions/{redemption_id}/approve",
        headers=auth_headers, json={},
    )
    assert again.status_code == 409


@pytest.mark.asyncio
async def test_requires_approval_deny_and_capacity_race(client, auth_headers, db):
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(client, auth_headers, room_id, requires_approval=True, max_uses=1)

    w1, w2 = new_wallet(), new_wallet()
    r1 = await agent_register_signed(client, token, w1)
    r2 = await agent_register_signed(client, token, w2)
    assert r1.json()["status"] == "pending" and r2.json()["status"] == "pending"
    invite = await db.get(RoomInvite, token)
    assert invite.use_count == 0

    red1, red2 = r1.json()["redemption_id"], r2.json()["redemption_id"]
    # Deny r2 first
    denied = await client.post(
        f"/api/v1/rooms/{room_id}/redemptions/{red2}/deny",
        headers=auth_headers, json={"reason": "not welcome"},
    )
    assert denied.status_code == 200
    poll = await agent_register_poll(client, token, w2)
    assert poll.status_code == 409

    # Approve r1 — the only slot is consumed; capacity check stays atomic.
    ok = await client.post(
        f"/api/v1/rooms/{room_id}/redemptions/{red1}/approve",
        headers=auth_headers, json={},
    )
    assert ok.status_code == 200
    await db.refresh(invite)
    assert invite.use_count == 1


@pytest.mark.asyncio
async def test_revoked_invite_cascades_pending_redemptions(client, auth_headers, db):
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(client, auth_headers, room_id, requires_approval=True, max_uses=3)

    wallet = new_wallet()
    pending = await agent_register_signed(client, token, wallet)
    redemption_id = pending.json()["redemption_id"]

    revoked = await client.delete(f"/api/v1/rooms/{room_id}/invites/{token}", headers=auth_headers)
    assert revoked.status_code == 200

    row = await db.get(RoomInviteRedemption, redemption_id)
    assert row.status == "revoked"

    poll = await agent_register_poll(client, token, wallet)
    assert poll.status_code == 410
    approve = await client.post(
        f"/api/v1/rooms/{room_id}/redemptions/{redemption_id}/approve",
        headers=auth_headers, json={},
    )
    assert approve.status_code == 409


@pytest.mark.asyncio
async def test_cloud_agent_self_status_and_token_lifecycle(client, auth_headers, db):
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(client, auth_headers, room_id)
    wallet = new_wallet()
    reg = await agent_register_signed(client, token, wallet)
    data = reg.json()
    seat_id = data["seat_id"]
    agent_headers = {"Authorization": f"Bearer {data['agent_token']}"}

    status = await client.get(f"/api/v1/agent-seats/{seat_id}", headers=agent_headers)
    assert status.status_code == 200
    assert status.json()["removed_at"] is None and status.json()["source"] == "invite"

    renewed = await client.post(f"/api/v1/agent-seats/{seat_id}/token", headers=agent_headers)
    assert renewed.status_code == 200
    assert decode_access_token(renewed.json()["agent_token"])["sub"] == data["agent_user_id"]

    # A human cannot use the agent-self endpoint; a foreign agent gets 404.
    assert (await client.get(f"/api/v1/agent-seats/{seat_id}", headers=auth_headers)).status_code == 403
    stranger_agent = User(username="stranger-agent", display_name="S", user_type="agent")
    db.add(stranger_agent)
    await db.commit()
    assert (await client.get(
        f"/api/v1/agent-seats/{seat_id}", headers=headers(stranger_agent))).status_code == 404

    # Owner removes the agent member → seat retired in the same transaction
    gone = await client.delete(
        f"/api/v1/rooms/{room_id}/members/{data['agent_user_id']}", headers=auth_headers
    )
    assert gone.status_code == 200
    seat = await db.get(AgentSeat, seat_id)
    assert seat.removed_at is not None and seat.group_status == "removed"

    # Fail-closed: the removed agent still reads its status but gets no token.
    after = await client.get(f"/api/v1/agent-seats/{seat_id}", headers=agent_headers)
    assert after.status_code == 200 and after.json()["removed_at"] is not None
    assert (await client.post(
        f"/api/v1/agent-seats/{seat_id}/token", headers=agent_headers)).status_code == 409


@pytest.mark.asyncio
@pytest.mark.skipif(
    isolated_engine.dialect.name != "postgresql",
    reason="atomic capacity race needs real PG row locking; SQLite serializes differently",
)
async def test_pg_concurrent_redeem_single_use_atomic_capacity(client, auth_headers, db):
    """8 concurrent redemptions on a max_uses=1 invite: the conditional
    UPDATE ... WHERE use_count < max_uses must let exactly one through."""
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(client, auth_headers, room_id)  # max_uses=1

    results = await asyncio.gather(
        *[redeem_signed(client, token, new_wallet()) for _ in range(8)]
    )
    statuses = sorted(r.status_code for r in results)
    assert statuses == [200] + [409] * 7, statuses
    invite = await db.get(RoomInvite, token)
    assert invite.use_count == 1


@pytest.mark.asyncio
async def test_accept_then_redeem_consumes_one_slot(client, auth_headers, db):
    """/accept pays the capacity; /redeem only binds the verified address —
    a single-use invite must stay at use_count==1 through both steps."""
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(client, auth_headers, room_id)  # max_uses=1

    joiner = await _register(client, "accept_then_redeem")
    assert (await client.post(f"/api/v1/invites/{token}/accept", headers=joiner)).status_code == 200
    invite = await db.get(RoomInvite, token)
    assert invite.use_count == 1

    bound = await redeem_signed(client, token, new_wallet(), headers=joiner)
    assert bound.status_code == 200, bound.text
    await db.refresh(invite)
    assert invite.use_count == 1  # binding is not a second use

    # The invite is genuinely exhausted for everyone else.
    stranger = await _register(client, "second_joiner")
    assert (await client.post(f"/api/v1/invites/{token}/accept", headers=stranger)).status_code == 409
    assert (await redeem_signed(client, token, new_wallet())).status_code == 409


@pytest.mark.asyncio
async def test_accept_on_requires_approval_invite_goes_pending(client, auth_headers):
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(client, auth_headers, room_id, requires_approval=True, role="viewer")

    joiner = await _register(client, "approval_joiner")
    resp = await client.post(f"/api/v1/invites/{token}/accept", headers=joiner)
    assert resp.status_code == 200
    assert resp.json()["status"] == "pending"
    redemption_id = resp.json()["redemption_id"]

    # No membership yet — the approval gate cannot be bypassed via /accept
    assert (await client.get(f"/api/v1/rooms/{room_id}", headers=joiner)).status_code == 403

    ok = await client.post(
        f"/api/v1/rooms/{room_id}/redemptions/{redemption_id}/approve",
        headers=auth_headers, json={},
    )
    assert ok.status_code == 200
    me = await client.get(f"/api/v1/rooms/{room_id}", headers=joiner)
    assert me.status_code == 200
    perms = await client.get(f"/api/v1/rooms/{room_id}/permissions", headers=auth_headers)
    joiner_row = [m for m in perms.json()["members"] if m["username"] == "approval_joiner"]
    assert joiner_row and joiner_row[0]["role"] == "viewer"


@pytest.mark.asyncio
async def test_bind_xmtp_address_requires_signature_and_is_idempotent(client, auth_headers):
    room_id = await _create_room(client, auth_headers)
    member = await _register(client, "bound_member")
    await client.post(
        f"/api/v1/rooms/{room_id}/invite", headers=auth_headers,
        json={"username": "bound_member", "role": "member"},
    )

    wallet = new_wallet()
    bound = await bind_address_signed(client, room_id, wallet, member)
    assert bound.status_code == 200, bound.text
    assert bound.json()["xmtp_address"] == wallet.address.lower()

    # The member listing exposes the verified address for group removal.
    members = await client.get(f"/api/v1/rooms/{room_id}/permissions", headers=auth_headers)
    row = [m for m in members.json()["members"] if m["username"] == "bound_member"][0]
    assert row["xmtp_address"] == wallet.address.lower()

    # Non-member cannot bind
    outsider = await _register(client, "unbound_outsider")
    bad = await bind_address_signed(client, room_id, new_wallet(), outsider)
    assert bad.status_code == 404


@pytest.mark.asyncio
async def test_room_settings_patch_validation_and_versioning(client, auth_headers):
    room_id = await _create_room(client, auth_headers)

    ok = await client.patch(
        f"/api/v1/rooms/{room_id}/settings", headers=auth_headers,
        json={"settings": {"template_key": "research", "house_rules": ["be kind"],
                           "suggested_scopes": ["task.run"]}},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["settings_version"] == 1

    ok2 = await client.patch(
        f"/api/v1/rooms/{room_id}/settings", headers=auth_headers,
        json={"settings": {"template_key": "research"}},
    )
    assert ok2.status_code == 200 and ok2.json()["settings_version"] == 2

    bad = await client.patch(
        f"/api/v1/rooms/{room_id}/settings", headers=auth_headers,
        json={"settings": {"suggested_scopes": ["payment.send"]}},
    )
    assert bad.status_code == 422

    outsider = await _register(client, "settings_outsider")
    denied = await client.patch(
        f"/api/v1/rooms/{room_id}/settings", headers=outsider, json={"settings": {}},
    )
    assert denied.status_code == 403


# ── security audit regression tests (H1, M1, M2, L1, L2, L3, L4) ──


@pytest.mark.asyncio
async def test_h1_legacy_used_invite_cannot_resurrect_and_migration_backfills(
    client, auth_headers, db, tmp_path
):
    """H1: a pre-m1 invite with used_at set stays exhausted even if use_count=0,
    and m1 upgrade backfills use_count=1 WHERE used_at IS NOT NULL."""
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(client, auth_headers, room_id, max_uses=1)

    invite = await db.get(RoomInvite, token)
    invite.used_at = datetime.now(timezone.utc)
    invite.use_count = 0
    await db.commit()

    info = await client.get(f"/api/v1/invites/{token}")
    assert info.status_code == 200
    assert info.json()["remaining_uses"] == 0

    joiner = await _register(client, "h1_joiner")
    assert (await client.post(f"/api/v1/invites/{token}/accept", headers=joiner)).status_code == 409
    assert (await redeem_signed(client, token, new_wallet())).status_code == 409
    assert (await agent_register_signed(client, token, new_wallet())).status_code == 409

    # Real m1 migration script backfill + partial index check on a k10-shaped SQLite DB
    db_file = tmp_path / "k10_legacy.db"
    conn = sqlite3.connect(db_file)
    conn.executescript(
        """
        CREATE TABLE users (id TEXT PRIMARY KEY);
        CREATE TABLE rooms (id TEXT PRIMARY KEY);
        CREATE TABLE helper_devices (id TEXT PRIMARY KEY);
        CREATE TABLE agent_seats (
            id TEXT PRIMARY KEY, helper_id TEXT NOT NULL, agent_user_id TEXT NOT NULL,
            room_id TEXT NOT NULL, agent_key TEXT NOT NULL, kind TEXT NOT NULL,
            xmtp_address TEXT NOT NULL, group_status TEXT NOT NULL,
            created_at TEXT NOT NULL, group_added_at TEXT, removed_at TEXT
        );
        CREATE TABLE room_permissions (
            id INTEGER PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL,
            role TEXT NOT NULL, invited_by TEXT
        );
        CREATE TABLE room_invites (
            token TEXT PRIMARY KEY, room_id TEXT NOT NULL, created_by TEXT NOT NULL,
            proposed_scopes TEXT, expires_at TEXT NOT NULL, used_at TEXT,
            redeemed_by_address TEXT, created_at TEXT NOT NULL
        );
        INSERT INTO room_invites VALUES ('legacy-used', 'r1', 'u1', '[]', '2099-01-01', '2026-10-01T00:00:00Z', '0x1', '2026-09-01');
        INSERT INTO room_invites VALUES ('legacy-open', 'r1', 'u1', '[]', '2099-01-01', NULL, NULL, '2026-09-01');
        """
    )
    conn.close()

    mig_path = (
        Path(__file__).resolve().parents[1]
        / "alembic"
        / "versions"
        / "l20c20261120_m1_seats_invites_rules.py"
    )
    spec = spec_from_file_location("m1_mig_test", mig_path)
    assert spec and spec.loader
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)

    sync_engine = create_engine(f"sqlite:///{db_file}")
    with sync_engine.begin() as c:
        with Operations.context(MigrationContext.configure(c)):
            mod.upgrade()
        rows = dict(
            c.exec_driver_sql("SELECT token, use_count FROM room_invites").fetchall()
        )
        assert rows == {"legacy-used": 1, "legacy-open": 0}
        with Operations.context(MigrationContext.configure(c)):
            mod.downgrade()
    sync_engine.dispose()


@pytest.mark.asyncio
async def test_m1_m2_atomic_redemption_decisions_and_expiry_and_l2_l4(
    client, auth_headers, db
):
    """M1/M2/L2/L4 regressions: expired approval 410, atomic pending flips,
    deduped human pending /accept, and header-based agent-register polling."""
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(
        client, auth_headers, room_id, requires_approval=True, max_uses=3
    )

    # M2: expired pending redemption cannot be approved (410 + marked expired)
    expired_wallet = new_wallet()
    exp_res = await agent_register_signed(client, token, expired_wallet)
    assert exp_res.status_code == 200 and exp_res.json()["status"] == "pending"
    exp_id = exp_res.json()["redemption_id"]
    exp_row = await db.get(RoomInviteRedemption, exp_id)
    exp_row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=5)
    await db.commit()

    exp_app = await client.post(
        f"/api/v1/rooms/{room_id}/redemptions/{exp_id}/approve",
        headers=auth_headers,
        json={},
    )
    assert exp_app.status_code == 410
    await db.refresh(exp_row)
    assert exp_row.status == "expired"
    invite = await db.get(RoomInvite, token)
    assert invite.use_count == 0

    # M1 (double approve + stale deny): exactly one approve wins, one slot consumed,
    # and subsequent deny cannot overwrite consumed -> denied.
    human = await _register(client, "m1_human_race")
    acc1 = await client.post(f"/api/v1/invites/{token}/accept", headers=human)
    assert acc1.status_code == 200 and acc1.json()["status"] == "pending"
    # L2: repeated /accept for same pending human returns same id cleanly
    acc2 = await client.post(f"/api/v1/invites/{token}/accept", headers=human)
    assert acc2.status_code == 200 and acc2.json()["redemption_id"] == acc1.json()["redemption_id"]

    red_id = acc1.json()["redemption_id"]
    first_app, second_app = await asyncio.gather(
        client.post(f"/api/v1/rooms/{room_id}/redemptions/{red_id}/approve", headers=auth_headers, json={}),
        client.post(f"/api/v1/rooms/{room_id}/redemptions/{red_id}/approve", headers=auth_headers, json={}),
    )
    assert sorted([first_app.status_code, second_app.status_code]) == [200, 409]
    late_deny = await client.post(
        f"/api/v1/rooms/{room_id}/redemptions/{red_id}/deny",
        headers=auth_headers,
        json={"reason": "late"},
    )
    assert late_deny.status_code == 409
    await db.refresh(invite)
    assert invite.use_count == 1
    row = await db.get(RoomInviteRedemption, red_id)
    assert row.status == "consumed"

    # M1 (approve vs deny race): either approve wins (slot+1) or deny wins (slot+0), never split.
    race_w = new_wallet()
    race_reg = await agent_register_signed(client, token, race_w)
    race_id = race_reg.json()["redemption_id"]
    race_app, race_deny = await asyncio.gather(
        client.post(f"/api/v1/rooms/{room_id}/redemptions/{race_id}/approve", headers=auth_headers, json={}),
        client.post(f"/api/v1/rooms/{room_id}/redemptions/{race_id}/deny", headers=auth_headers, json={"reason": "race"}),
    )
    assert sorted([race_app.status_code, race_deny.status_code]) == [200, 409]
    await db.refresh(invite)
    race_row = await db.get(RoomInviteRedemption, race_id)
    if race_app.status_code == 200:
        assert race_row.status == "approved" and invite.use_count == 2
    else:
        assert race_row.status == "denied" and invite.use_count == 1

    # L4: GET agent-register accepts X-MAPR-* headers instead of query params
    w = new_wallet()
    reg = await agent_register_signed(client, token, w)
    assert reg.status_code == 200 and reg.json()["status"] == "pending"
    proof = await signed_proof(client, "invite-agent-register", token, w)
    poll_hdr = await client.get(
        f"/api/v1/invites/{token}/agent-register",
        headers={
            "X-MAPR-Address": w.address,
            "X-MAPR-Nonce": proof["nonce"],
            "X-MAPR-Signature": proof["signature"],
        },
    )
    assert poll_hdr.status_code == 200 and poll_hdr.json()["status"] == "pending"


@pytest.mark.asyncio
async def test_consumed_registration_nonces_allow_polling_beyond_open_limit(client, auth_headers):
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(client, auth_headers, room_id, requires_approval=True)
    wallet = new_wallet()
    poll_path = f"/api/v1/invites/{token}/agent-register"
    first_headers = None

    for _ in range(MAX_LIVE_NONCES_PER_ADDRESS + 1):
        proof = await signed_proof(client, ACTION_AGENT_REGISTER, token, wallet)
        poll_headers = {
            "X-MAPR-Address": wallet.address,
            "X-MAPR-Nonce": proof["nonce"],
            "X-MAPR-Signature": proof["signature"],
        }
        if first_headers is None:
            first_headers = poll_headers
        response = await client.get(poll_path, headers=poll_headers)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "pending"

    replay = await client.get(poll_path, headers=first_headers)
    assert replay.status_code == 409
    assert replay.json()["detail"] == "Signature challenge already used"


@pytest.mark.asyncio
async def test_thirty_third_open_registration_nonce_is_rejected(client):
    payload = {
        "action": ACTION_AGENT_REGISTER,
        "resource": "invite-token",
        "address": new_wallet().address,
    }
    for _ in range(MAX_LIVE_NONCES_PER_ADDRESS):
        response = await client.post("/api/v1/invites/nonce", json=payload)
        assert response.status_code == 201, response.text

    rejected = await client.post("/api/v1/invites/nonce", json=payload)
    assert rejected.status_code == 429
    assert rejected.json()["detail"] == "Too many open signature challenges"


@pytest.mark.asyncio
async def test_l1_settings_rejects_dict_forbidden_scopes_and_allow(client, auth_headers):
    """L1: PATCH /settings must reject forbidden scope keys inside dicts and 'allow'."""
    room_id = await _create_room(client, auth_headers)

    for bad_settings in (
        {"house_rules": {"scopes": {"payment.transfer": "allow"}, "notes": []}},
        {"suggested_scopes": ["task.run"], "house_rules": {"scopes": {"banking.read": "cannot"}}},
        {"suggested_scopes": ["task.run"], "extra": {"wallet.sign": "ask"}},
    ):
        resp = await client.patch(
            f"/api/v1/rooms/{room_id}/settings",
            headers=auth_headers,
            json={"settings": bad_settings},
        )
        assert resp.status_code == 422, f"expected 422 for {bad_settings}, got {resp.text}"


@pytest.mark.asyncio
async def test_l3_paused_cloud_seat_blocked_from_token_refresh(client, auth_headers):
    """L3: paused cloud seats cannot mint fresh JWTs, but recover after /resume."""
    room_id = await _create_room(client, auth_headers)
    token = await _make_invite(client, auth_headers, room_id)
    reg = await agent_register_signed(client, token, new_wallet())
    assert reg.status_code == 200
    data = reg.json()
    seat_id = data["seat_id"]
    agent_headers = {"Authorization": f"Bearer {data['agent_token']}"}

    assert (
        await client.post(f"/api/v1/rooms/{room_id}/seats/{seat_id}/pause", headers=auth_headers)
    ).status_code == 204

    st = await client.get(f"/api/v1/agent-seats/{seat_id}", headers=agent_headers)
    assert st.status_code == 200 and st.json()["paused_at"] is not None
    assert (
        await client.post(f"/api/v1/agent-seats/{seat_id}/token", headers=agent_headers)
    ).status_code == 409

    assert (
        await client.post(f"/api/v1/rooms/{room_id}/seats/{seat_id}/resume", headers=auth_headers)
    ).status_code == 204
    assert (
        await client.post(f"/api/v1/agent-seats/{seat_id}/token", headers=agent_headers)
    ).status_code == 200
