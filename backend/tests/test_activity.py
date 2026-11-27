"""WP4/m2: safe-metadata activity stream + signed ledger checkpoints.

Only synthetic users, rooms and in-process requests. EIP-191 signatures are
produced with eth_account wallets over the exact canonical
``MAPR1-LEDGER-CHECKPOINT`` payload that workers/xmtp-member/src/activity.ts
signs — no private key material leaves the test process.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from eth_account.messages import encode_defunct
from sqlalchemy import delete, func, select

from _signing import bind_address_signed, new_wallet
from app.activity.models import ActivityCheckpoint, ActivityEvent
from app.a2a.models import A2ATask, TaskEvent
from app.approval.models import Approval
from app.core.security import create_access_token
from app.helper.models import AgentSeat
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.models.user import User

BASE = "/api/v1/helpers"
ROOMS = "/api/v1/rooms"
CHECKPOINT_PREFIX = "MAPR1-LEDGER-CHECKPOINT "


def headers(user):
    return {"Authorization": "Bearer " + create_access_token(user.id, user.user_type)}


def _helper_headers(paired):
    return {"Authorization": f"Bearer {paired['helper_token']}"}


def sign_checkpoint(
    account,
    *,
    room_id: str,
    stream_id: str = "ledger-main",
    head_seq: int = 1,
    head_hash: str = "a" * 64,
    entry_count: int = 10,
    created_at: str = "2026-11-20T00:00:00.000Z",
) -> dict:
    """Byte-exact replica of signLedgerCheckpoint in workers activity.ts."""
    payload = {
        "version": 1,
        "room_id": room_id,
        "stream_id": stream_id,
        "head_seq": head_seq,
        "head_hash": head_hash,
        "entry_count": entry_count,
        "created_at": created_at,
    }
    message = CHECKPOINT_PREFIX + json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    signature = account.sign_message(encode_defunct(text=message)).signature.hex()
    return {
        **payload,
        "signer": account.address,
        "signature": "0x" + signature.removeprefix("0x"),
    }


def _event(room_id: str, actor_id: str, *, actor_kind="agent", kind="request_sent",
           status="ok", **extra) -> dict:
    ev = {
        "id": str(uuid.uuid4()),
        "room_id": room_id,
        "actor_kind": actor_kind,
        "actor_id": actor_id,
        "kind": kind,
        "status": status,
        "created_at": "2026-11-20T01:00:00.000Z",
    }
    ev.update(extra)
    return ev


@pytest_asyncio.fixture
async def room_owner(db):
    owner = User(username="act_owner", display_name="Owner", user_type="human")
    db.add(owner)
    await db.commit()
    room = Room(name="activity room", created_by=owner.id, is_active=True)
    db.add(room)
    await db.commit()
    db.add(RoomPermission(room_id=room.id, user_id=owner.id, role="owner", invited_by=owner.id))
    await db.commit()
    return owner, room


@pytest_asyncio.fixture
async def paired_helper(client, room_owner):
    owner, _room = room_owner
    code = (await client.post(f"{BASE}/pairing-codes", headers=headers(owner))).json()["code"]
    resp = await client.post(
        f"{BASE}/pair", json={"code": code, "device_name": "dev", "platform": "linux"}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _make_seat(client, paired, room_id, address, agent_key="codex"):
    resp = await client.post(
        f"{BASE}/me/seats",
        headers=_helper_headers(paired),
        json={
            "via": "local",
            "room_id": room_id,
            "agent_key": agent_key,
            "kind": "codex",
            "display_name": "Codex",
            "xmtp_address": address,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# ── ingest: schema redlines ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_forbidden_extra_and_plaintext_fields_rejected_422(
    client, db, room_owner, paired_helper, caplog
):
    """payload/content/params/digest-style keys must hard-fail with 422 —
    they may never ride the metadata pipeline."""
    owner, room = room_owner
    marker = "do-not-echo-xmtp-ciphertext"
    for forbidden in (
        "payload", "payload_hash", "content", "params", "params_hash",
        "digest", "body", "to", "subject", "text", "message", marker,
    ):
        ev = _event(room.id, owner.id, actor_kind="human", **{forbidden: marker})
        resp = await client.post(
            f"{BASE}/me/activity", headers=_helper_headers(paired_helper),
            json={"events": [ev]},
        )
        assert resp.status_code == 422, f"{forbidden} must be rejected: {resp.text}"
        assert marker not in resp.text

    # Same redline on the checkpoint batch wrapper.
    forged = sign_checkpoint(new_wallet(), room_id=room.id)
    forged["payload"] = {"ciphertext": marker}
    resp = await client.post(
        f"{BASE}/me/activity/checkpoints", headers=_helper_headers(paired_helper),
        json={"checkpoints": [forged]},
    )
    assert resp.status_code == 422
    assert marker not in resp.text

    # Malformed signature/head shapes fail schema validation too.
    bad = sign_checkpoint(new_wallet(), room_id=room.id)
    bad["signature"] = "0xdeadbeef"
    resp = await client.post(
        f"{BASE}/me/activity/checkpoints", headers=_helper_headers(paired_helper),
        json={"checkpoints": [bad]},
    )
    assert resp.status_code == 422
    bad["head_hash"] = "ZZ" * 32
    bad["signature"] = "0x" + "a" * 130
    resp = await client.post(
        f"{BASE}/me/activity/checkpoints", headers=_helper_headers(paired_helper),
        json={"checkpoints": [bad]},
    )
    assert resp.status_code == 422
    assert marker not in caplog.text
    assert await db.scalar(select(func.count()).select_from(ActivityEvent)) == 0
    assert await db.scalar(select(func.count()).select_from(ActivityCheckpoint)) == 0


@pytest.mark.asyncio
async def test_activity_room_archival_and_physical_deletion(client, db, room_owner):
    owner, room = room_owner
    other_room = Room(name="other room", created_by=owner.id)
    db.add(other_room)
    await db.flush()
    archived_id, other_id = room.id, other_room.id
    for room_id in (archived_id, other_id):
        db.add(ActivityEvent(
            id=str(uuid.uuid4()), room_id=room_id, actor_kind="human",
            actor_id=owner.id, kind="activity", created_at=datetime.now(timezone.utc),
        ))
        db.add(ActivityCheckpoint(
            room_id=room_id, stream_id="ledger", signer_address="0x" + "a" * 40,
            head_seq=1, head_hash="b" * 64, entry_count=1, signature="0x" + "c" * 130,
            checkpoint_at=datetime.now(timezone.utc),
        ))
    await db.commit()

    assert (await client.delete(f"{ROOMS}/{archived_id}", headers=headers(owner))).status_code == 200
    assert (await client.get(f"{ROOMS}/{archived_id}/activity", headers=headers(owner))).status_code == 403
    for model in (ActivityEvent, ActivityCheckpoint):
        assert set((await db.scalars(select(model.room_id))).all()) == {archived_id, other_id}

    if db.bind.dialect.name == "postgresql":
        await db.execute(delete(RoomPermission).where(RoomPermission.room_id == archived_id))
        await db.execute(delete(Room).where(Room.id == archived_id))
        await db.commit()
        for model in (ActivityEvent, ActivityCheckpoint):
            assert (await db.scalars(select(model.room_id))).all() == [other_id]


# ── ingest: events happy path + idempotency ─────────────────────────────

@pytest.mark.asyncio
async def test_helper_event_ingest_and_idempotent_duplicates(
    client, db, room_owner, paired_helper
):
    owner, room = room_owner
    wallet = new_wallet()
    grant = await _make_seat(client, paired_helper, room.id, wallet.address)
    agent_id = grant["agent_user_id"]

    events = [
        _event(room.id, agent_id, kind="request_sent", status="ok",
               subject_id="req-1", stream_seq=1),
        _event(room.id, owner.id, actor_kind="human", kind="consent_approved",
               status="ok", stream_seq=2),
        _event(room.id, wallet.address, kind="action_finished", status="ok",
               app="gmail", stream_seq=3),
        _event(room.id, paired_helper["helper_id"], actor_kind="helper",
               kind="receipt_resent", status="ok", stream_seq=4),
        _event(room.id, "system", actor_kind="system",
               kind="recovered_uncertain", status="uncertain", stream_seq=5),
    ]
    resp = await client.post(
        f"{BASE}/me/activity", headers=_helper_headers(paired_helper),
        json={"events": events},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"accepted": 5, "duplicates": 0}

    # Treat different offsets for the same instant as the same event.
    replay = [{**event, "created_at": "2026-11-20T09:00:00+08:00"} for event in events]
    again = await client.post(
        f"{BASE}/me/activity", headers=_helper_headers(paired_helper),
        json={"events": replay},
    )
    assert again.status_code == 200 and again.json() == {"accepted": 0, "duplicates": 5}
    count = await db.scalar(select(func.count()).select_from(ActivityEvent))
    assert count == 5

    rows = (await db.execute(select(ActivityEvent))).scalars().all()
    assert {r.reported_by for r in rows} == {paired_helper["helper_id"]}


@pytest.mark.asyncio
async def test_duplicate_event_id_with_different_content_conflicts(
    client, room_owner, paired_helper
):
    _owner, room = room_owner
    wallet = new_wallet()
    grant = await _make_seat(client, paired_helper, room.id, wallet.address)
    ev = _event(room.id, grant["agent_user_id"])
    resp = await client.post(
        f"{BASE}/me/activity", headers=_helper_headers(paired_helper),
        json={"events": [ev]},
    )
    assert resp.status_code == 200

    tampered = dict(ev, status="denied")
    resp = await client.post(
        f"{BASE}/me/activity", headers=_helper_headers(paired_helper),
        json={"events": [tampered]},
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_cross_room_and_spoofed_actor_rejected_403(
    client, db, room_owner, paired_helper
):
    owner, room = room_owner
    wallet = new_wallet()
    grant = await _make_seat(client, paired_helper, room.id, wallet.address)

    # A room the helper's owner does NOT belong to.
    other_room = Room(name="foreign", is_active=True)
    db.add(other_room)
    await db.commit()
    ev = _event(other_room.id, grant["agent_user_id"])
    resp = await client.post(
        f"{BASE}/me/activity", headers=_helper_headers(paired_helper),
        json={"events": [ev]},
    )
    assert resp.status_code == 403

    # An actor the helper does not control (victim's address / foreign user).
    victim = new_wallet()
    for bad_actor in (victim.address, "not-the-owner", str(uuid.uuid4())):
        ev = _event(room.id, bad_actor)
        resp = await client.post(
            f"{BASE}/me/activity", headers=_helper_headers(paired_helper),
            json={"events": [ev]},
        )
        assert resp.status_code == 403, f"spoofed actor {bad_actor} accepted"

    # "system" actor_id only passes for actor_kind='system'.
    ev = _event(room.id, "system", actor_kind="agent")
    resp = await client.post(
        f"{BASE}/me/activity", headers=_helper_headers(paired_helper),
        json={"events": [ev]},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_batch_limit_100_enforced(client, room_owner, paired_helper):
    _owner, room = room_owner
    events = [_event(room.id, "x") for _ in range(101)]
    resp = await client.post(
        f"{BASE}/me/activity", headers=_helper_headers(paired_helper),
        json={"events": events},
    )
    assert resp.status_code == 422


# ── ingest: agent JWT path ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_agent_event_ingest_scoped_to_own_room_and_actor(
    client, db, room_owner, paired_helper
):
    owner, room = room_owner
    wallet = new_wallet()
    grant = await _make_seat(client, paired_helper, room.id, wallet.address)
    agent_headers = {"Authorization": f"Bearer {grant['agent_token']}"}
    agent_id = grant["agent_user_id"]

    ev = _event(room.id, agent_id, kind="action_finished", app="gmail")
    resp = await client.post(
        f"{ROOMS}/{room.id}/activity", headers=agent_headers,
        json={"events": [ev]},
    )
    assert resp.status_code == 200 and resp.json()["accepted"] == 1

    # The seat's own xmtp address is also a legitimate actor identity.
    ev2 = _event(room.id, wallet.address)
    resp = await client.post(
        f"{ROOMS}/{room.id}/activity", headers=agent_headers,
        json={"events": [ev2]},
    )
    assert resp.status_code == 200

    # Spoofed actor → 403; event pointing at another room → 403.
    bad = _event(room.id, owner.id)
    resp = await client.post(
        f"{ROOMS}/{room.id}/activity", headers=agent_headers,
        json={"events": [bad]},
    )
    assert resp.status_code == 403

    other_room = Room(name="other", is_active=True)
    db.add(other_room)
    await db.commit()
    ev_other = _event(other_room.id, agent_id)
    resp = await client.post(
        f"{ROOMS}/{other_room.id}/activity", headers=agent_headers,
        json={"events": [ev_other]},
    )
    assert resp.status_code == 403
    resp = await client.post(
        f"{ROOMS}/{room.id}/activity", headers=agent_headers,
        json={"events": [ev_other]},
    )
    assert resp.status_code == 403

    # A human token cannot use the agent ingest path.
    resp = await client.post(
        f"{ROOMS}/{room.id}/activity", headers=headers(owner),
        json={"events": [_event(room.id, owner.id)]},
    )
    assert resp.status_code == 403


# ── checkpoints: signature + authorization ──────────────────────────────

@pytest.mark.asyncio
async def test_signed_checkpoint_verified_against_worker_format(
    client, db, room_owner, paired_helper
):
    """A checkpoint signed exactly like workers activity.ts verifies and
    anchors; tampering with any signed field breaks verification."""
    _owner, room = room_owner
    wallet = new_wallet()
    grant = await _make_seat(client, paired_helper, room.id, wallet.address)

    cp = sign_checkpoint(
        wallet, room_id=room.id, head_seq=7, head_hash="ab" * 32, entry_count=42,
        created_at="2026-11-20T08:00:00.000Z",
    )
    resp = await client.post(
        f"{BASE}/me/activity/checkpoints", headers=_helper_headers(paired_helper),
        json={"checkpoints": [cp]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"accepted": 1, "duplicates": 0}

    row = (await db.execute(select(ActivityCheckpoint))).scalar_one()
    assert row.signer_address == wallet.address.lower()
    assert row.head_seq == 7 and row.entry_count == 42
    assert row.stream_id == "ledger-main"

    # Exact duplicate re-anchor is idempotent.
    again = await client.post(
        f"{BASE}/me/activity/checkpoints", headers=_helper_headers(paired_helper),
        json={"checkpoints": [cp]},
    )
    assert again.status_code == 200 and again.json() == {"accepted": 0, "duplicates": 1}
    count = await db.scalar(select(func.count()).select_from(ActivityCheckpoint))
    assert count == 1


@pytest.mark.asyncio
async def test_forged_signature_and_unauthorized_signer(
    client, db, room_owner, paired_helper
):
    _owner, room = room_owner
    wallet = new_wallet()
    await _make_seat(client, paired_helper, room.id, wallet.address)

    # Signature produced by a DIFFERENT key than the claimed signer → 422.
    cp = sign_checkpoint(wallet, room_id=room.id, head_seq=1)
    attacker = new_wallet()
    cp["signer"] = attacker.address
    resp = await client.post(
        f"{BASE}/me/activity/checkpoints", headers=_helper_headers(paired_helper),
        json={"checkpoints": [cp]},
    )
    assert resp.status_code == 422

    # Tampered signed field (head_hash changed after signing) → 422.
    cp2 = sign_checkpoint(wallet, room_id=room.id, head_seq=2)
    cp2["head_hash"] = "cd" * 32
    resp = await client.post(
        f"{BASE}/me/activity/checkpoints", headers=_helper_headers(paired_helper),
        json={"checkpoints": [cp2]},
    )
    assert resp.status_code == 422

    # Well-formed signature from an address that is NOT a member/seat → 403.
    outsider = new_wallet()
    cp3 = sign_checkpoint(outsider, room_id=room.id, head_seq=3)
    resp = await client.post(
        f"{BASE}/me/activity/checkpoints", headers=_helper_headers(paired_helper),
        json={"checkpoints": [cp3]},
    )
    assert resp.status_code == 403

    count = await db.scalar(select(func.count()).select_from(ActivityCheckpoint))
    assert count == 0


@pytest.mark.asyncio
async def test_checkpoint_monotonicity_rollback_and_conflict(
    client, db, room_owner, paired_helper
):
    _owner, room = room_owner
    wallet = new_wallet()
    await _make_seat(client, paired_helper, room.id, wallet.address)
    h = _helper_headers(paired_helper)
    url = f"{BASE}/me/activity/checkpoints"

    anchor5 = sign_checkpoint(wallet, room_id=room.id, head_seq=5, head_hash="aa" * 32)
    assert (await client.post(url, headers=h, json={"checkpoints": [anchor5]})).status_code == 200

    # Rollback: lower head_seq than the anchored head → 409.
    rollback = sign_checkpoint(wallet, room_id=room.id, head_seq=4, head_hash="bb" * 32)
    resp = await client.post(url, headers=h, json={"checkpoints": [rollback]})
    assert resp.status_code == 409

    # Fork/conflict: same head_seq but a different head_hash → 409.
    fork = sign_checkpoint(wallet, room_id=room.id, head_seq=5, head_hash="bb" * 32)
    resp = await client.post(url, headers=h, json={"checkpoints": [fork]})
    assert resp.status_code == 409

    # A forward anchor still succeeds; re-posting the ORIGINAL seq-5 anchor
    # afterwards is still an idempotent duplicate, not a rollback.
    anchor8 = sign_checkpoint(wallet, room_id=room.id, head_seq=8, head_hash="cc" * 32)
    assert (await client.post(url, headers=h, json={"checkpoints": [anchor8]})).status_code == 200
    resp = await client.post(url, headers=h, json={"checkpoints": [anchor5]})
    assert resp.status_code == 409  # truncation of the newer head

    # A different stream is independent.
    other = sign_checkpoint(
        wallet, room_id=room.id, stream_id="outbox", head_seq=1, head_hash="dd" * 32
    )
    resp = await client.post(url, headers=h, json={"checkpoints": [other]})
    assert resp.status_code == 200

    heads = {
        (r.stream_id, r.head_seq, r.head_hash)
        for r in (await db.execute(select(ActivityCheckpoint))).scalars().all()
    }
    assert heads == {
        ("ledger-main", 5, "aa" * 32),
        ("ledger-main", 8, "cc" * 32),
        ("outbox", 1, "dd" * 32),
    }


@pytest.mark.asyncio
async def test_agent_checkpoint_endpoint_and_member_address_signer(
    client, db, room_owner, paired_helper
):
    """Agent JWT path: the room owner bound address may sign; the agent
    reports it for its own room only."""
    owner, room = room_owner
    wallet = new_wallet()
    grant = await _make_seat(client, paired_helper, room.id, wallet.address)
    agent_headers = {"Authorization": f"Bearer {grant['agent_token']}"}

    # Room owner binds their address → that address is an authorized signer.
    owner_wallet = new_wallet()
    bound = await bind_address_signed(client, room.id, owner_wallet, headers(owner))
    assert bound.status_code == 200, bound.text

    cp = sign_checkpoint(owner_wallet, room_id=room.id, head_seq=1, head_hash="ef" * 32)
    resp = await client.post(
        f"{ROOMS}/{room.id}/activity/checkpoints", headers=agent_headers,
        json={"checkpoints": [cp]},
    )
    assert resp.status_code == 200 and resp.json()["accepted"] == 1

    # Wrong room in payload vs path → 403. Human JWT → 403.
    bad = sign_checkpoint(owner_wallet, room_id="0" * 36, head_seq=1, head_hash="ef" * 32)
    resp = await client.post(
        f"{ROOMS}/{room.id}/activity/checkpoints", headers=agent_headers,
        json={"checkpoints": [bad]},
    )
    assert resp.status_code == 403
    resp = await client.post(
        f"{ROOMS}/{room.id}/activity/checkpoints", headers=headers(owner),
        json={"checkpoints": [cp]},
    )
    assert resp.status_code == 403


# ── merged feed ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_merged_feed_filters_and_checkpoint_heads(
    client, db, room_owner, paired_helper
):
    owner, room = room_owner
    wallet = new_wallet()
    grant = await _make_seat(client, paired_helper, room.id, wallet.address)
    agent_id = grant["agent_user_id"]

    events = [
        _event(room.id, agent_id, kind="request_sent", status="ok",
               created_at="2026-11-20T01:00:00Z"),
        _event(room.id, agent_id, kind="action_finished", status="ok",
               app="gmail", created_at="2026-11-20T02:00:00Z"),
        _event(room.id, owner.id, actor_kind="human", kind="consent_denied",
               status="denied", created_at="2026-11-20T03:00:00Z"),
    ]
    assert (await client.post(
        f"{BASE}/me/activity", headers=_helper_headers(paired_helper),
        json={"events": events})).status_code == 200

    # Hub-side task + approval rows.
    task = A2ATask(id="task-1", context_id="ctx", source_agent="hub",
                   query="secret query text", status="completed", room_id=room.id)
    db.add(task)
    await db.flush()
    db.add(TaskEvent(task_id=task.id, event_seq=1, event_type="task_completed",
                     payload={"note": "hidden"},
                     created_at=datetime(2026, 11, 20, 4, tzinfo=timezone.utc)))
    db.add(Approval(id="appr-1", room_id=room.id, requestor_id=agent_id,
                    title="send mail to alice@example.com",
                    description="full body", status="pending",
                    created_at=datetime(2026, 11, 20, 5, tzinfo=timezone.utc)))
    await db.commit()

    cp = sign_checkpoint(wallet, room_id=room.id, head_seq=9, head_hash="aa" * 32)
    assert (await client.post(
        f"{BASE}/me/activity/checkpoints", headers=_helper_headers(paired_helper),
        json={"checkpoints": [cp]})).status_code == 200

    feed = (await client.get(f"{ROOMS}/{room.id}/activity", headers=headers(owner))).json()
    assert feed["room_id"] == room.id
    assert feed["count"] == 5
    sources = {i["source"] for i in feed["items"]}
    assert sources == {"activity", "task_event", "approval"}
    assert feed["checkpoints"][0]["head_seq"] == 9
    assert feed["checkpoints"][0]["head_hash"] == "aa" * 32

    # Zero plaintext on an XMTP room: no title/description/query/payload.
    raw = json.dumps(feed, ensure_ascii=False)
    for secret in ("send mail to alice", "full body", "secret query text", "hidden"):
        assert secret not in raw
    approval_item = [i for i in feed["items"] if i["source"] == "approval"][0]
    assert approval_item["title"] is None

    # Filters: actor / kind / status / since-until / limit.
    by_actor = (await client.get(
        f"{ROOMS}/{room.id}/activity?actor={agent_id}", headers=headers(owner))).json()
    assert {i["actor_id"] for i in by_actor["items"]} == {agent_id}

    by_kind = (await client.get(
        f"{ROOMS}/{room.id}/activity?kind=approval,request_sent",
        headers=headers(owner))).json()
    assert {i["kind"] for i in by_kind["items"]} == {"approval", "request_sent"}

    by_status = (await client.get(
        f"{ROOMS}/{room.id}/activity?status=denied", headers=headers(owner))).json()
    assert all(i["status"] == "denied" for i in by_status["items"])

    by_app = (await client.get(
        f"{ROOMS}/{room.id}/activity?app=gmail", headers=headers(owner))).json()
    assert [i["kind"] for i in by_app["items"]] == ["action_finished"]

    window = (await client.get(
        f"{ROOMS}/{room.id}/activity?since=2026-11-20T01:30:00Z&until=2026-11-20T04:30:00Z",
        headers=headers(owner))).json()
    assert {i["kind"] for i in window["items"]} == {"action_finished", "consent_denied", "task_completed"}

    capped = (await client.get(
        f"{ROOMS}/{room.id}/activity?limit=2", headers=headers(owner))).json()
    assert capped["count"] == 2
    assert capped["items"][0]["created_at"] >= capped["items"][1]["created_at"]

    # limit > 200 is rejected; a non-member cannot read the feed.
    assert (await client.get(
        f"{ROOMS}/{room.id}/activity?limit=201", headers=headers(owner))).status_code == 422
    outsider = User(username="act_out", display_name="O", user_type="human")
    db.add(outsider)
    await db.commit()
    assert (await client.get(
        f"{ROOMS}/{room.id}/activity", headers=headers(outsider))).status_code == 403


@pytest.mark.asyncio
async def test_hub_transport_room_shows_approval_title_only(
    client, db, room_owner, paired_helper
):
    """Non-XMTP rooms may surface the approval title (already member-visible
    via the approvals API); description/query still never leave the feed."""
    owner, room = room_owner
    room.transport = "hub"
    await db.commit()
    db.add(Approval(id="appr-2", room_id=room.id, requestor_id=owner.id,
                    title="public title", description="private description",
                    status="pending"))
    await db.commit()
    feed = (await client.get(f"{ROOMS}/{room.id}/activity", headers=headers(owner))).json()
    item = [i for i in feed["items"] if i["source"] == "approval"][0]
    assert item["title"] == "public title"
    assert "private description" not in json.dumps(feed)


# ── security audit regression tests (M3, L3) ──


@pytest.mark.asyncio
async def test_m3_checkpoint_signer_scoped_and_stream_locked_against_poisoning(
    client, db, room_owner, paired_helper
):
    """M3: viewer addresses and foreign room members cannot sign checkpoints for
    another caller, and a second signer cannot hijack/poison an existing stream_id."""
    owner, room = room_owner
    seat_wallet = new_wallet()
    grant = await _make_seat(client, paired_helper, room.id, seat_wallet.address)
    agent_headers = {"Authorization": f"Bearer {grant['agent_token']}"}

    # Bind a viewer's wallet and another member's wallet in the same room.
    viewer = User(username="act_viewer", display_name="V", user_type="human")
    member_b = User(username="act_member_b", display_name="B", user_type="human")
    db.add_all([viewer, member_b])
    await db.commit()
    db.add_all([
        RoomPermission(room_id=room.id, user_id=viewer.id, role="viewer", invited_by=owner.id),
        RoomPermission(room_id=room.id, user_id=member_b.id, role="member", invited_by=owner.id),
    ])
    await db.commit()
    viewer_wallet, wallet_b = new_wallet(), new_wallet()
    assert (await bind_address_signed(client, room.id, viewer_wallet, headers(viewer))).status_code == 200
    assert (await bind_address_signed(client, room.id, wallet_b, headers(member_b))).status_code == 200

    # Even if signed validly by viewer or foreign member_b, helper/agent cannot anchor it.
    for bad_wallet in (viewer_wallet, wallet_b):
        bad_cp = sign_checkpoint(bad_wallet, room_id=room.id, stream_id="stream-poison", head_seq=999999)
        assert (
            await client.post(
                f"{BASE}/me/activity/checkpoints",
                headers=_helper_headers(paired_helper),
                json={"checkpoints": [bad_cp]},
            )
        ).status_code == 403
        assert (
            await client.post(
                f"{ROOMS}/{room.id}/activity/checkpoints",
                headers=agent_headers,
                json={"checkpoints": [bad_cp]},
            )
        ).status_code == 403

    # Stream ownership: seat_wallet anchors stream "s-owner" at seq 1, then
    # owner's wallet (also authorized for the room/seat) tries to jump on the
    # SAME stream_id -> 403 different stream owner.
    owner_wallet = new_wallet()
    assert (await bind_address_signed(client, room.id, owner_wallet, headers(owner))).status_code == 200
    cp1 = sign_checkpoint(seat_wallet, room_id=room.id, stream_id="s-owner", head_seq=1)
    assert (
        await client.post(
            f"{BASE}/me/activity/checkpoints",
            headers=_helper_headers(paired_helper),
            json={"checkpoints": [cp1]},
        )
    ).status_code == 200
    hijack = sign_checkpoint(owner_wallet, room_id=room.id, stream_id="s-owner", head_seq=500)
    assert (
        await client.post(
            f"{BASE}/me/activity/checkpoints",
            headers=_helper_headers(paired_helper),
            json={"checkpoints": [hijack]},
        )
    ).status_code == 403


@pytest.mark.asyncio
async def test_l3_paused_seat_blocked_from_activity_ingest(
    client, db, room_owner, paired_helper
):
    """L3: a paused agent seat cannot ingest events or checkpoints until resumed."""
    owner, room = room_owner
    wallet = new_wallet()
    grant = await _make_seat(client, paired_helper, room.id, wallet.address)
    seat_id = grant["seat_id"]
    agent_id = grant["agent_user_id"]
    agent_headers = {"Authorization": f"Bearer {grant['agent_token']}"}

    assert (
        await client.post(f"{ROOMS}/{room.id}/seats/{seat_id}/pause", headers=headers(owner))
    ).status_code == 204

    ev = _event(room.id, agent_id)
    assert (
        await client.post(f"{ROOMS}/{room.id}/activity", headers=agent_headers, json={"events": [ev]})
    ).status_code == 403
    cp = sign_checkpoint(wallet, room_id=room.id, stream_id=wallet.address.lower(), head_seq=1)
    assert (
        await client.post(
            f"{ROOMS}/{room.id}/activity/checkpoints",
            headers=agent_headers,
            json={"checkpoints": [cp]},
        )
    ).status_code == 403

    assert (
        await client.post(f"{ROOMS}/{room.id}/seats/{seat_id}/resume", headers=headers(owner))
    ).status_code == 204
    assert (
        await client.post(f"{ROOMS}/{room.id}/activity", headers=agent_headers, json={"events": [ev]})
    ).status_code == 200
