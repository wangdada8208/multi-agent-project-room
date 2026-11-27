"""WP4/m2 activity service: safe-metadata ingest + signed checkpoint anchors.

Authorization model
-------------------
* helper token (``POST /helpers/me/activity*``): the helper's owner must hold
  owner/member role in every referenced room, and each event's ``actor_id``
  must be an identity the helper legitimately controls (its owner, itself,
  or one of its seats in that room).
* agent JWT (``POST /rooms/{id}/activity*``): the agent must hold membership
  or a live seat in the room and may only report actors that are its own
  identities.
* checkpoints additionally require an EIP-191 signature over the exact
  canonical ``MAPR1-LEDGER-CHECKPOINT`` payload the worker signs
  (workers/xmtp-member/src/activity.ts), and the recovered signer must be a
  room member's bound XMTP address or a live seat's XMTP address.

Monotonicity: per ``(room_id, stream_id)`` a lower ``head_seq`` than the
stored maximum is a rollback (409); the same ``head_seq`` with a different
``head_hash`` is a chain conflict (409); an identical head is an idempotent
duplicate (200).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Iterable, Optional

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.a2a.models import A2ATask, TaskEvent
from app.activity.models import ActivityCheckpoint, ActivityEvent
from app.activity.schemas import (
    ActivityFeed,
    ActivityItem,
    CheckpointView,
    SafeActivityEventIn,
    SignedCheckpointIn,
)
from app.permissions.service import require_role
from app.approval.models import Approval
from app.core.eip191 import normalize_address, recover_signer
from app.core.timestamps import as_utc
from app.helper.models import AgentSeat, HelperDevice
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.models.user import User

CHECKPOINT_PREFIX = "MAPR1-LEDGER-CHECKPOINT "


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    dt = as_utc(dt)
    return dt.isoformat() if dt is not None else None


def checkpoint_message(cp: SignedCheckpointIn) -> str:
    """Rebuild the exact EIP-191 message signed by the worker.

    ``canonicalStringify`` in workers canonical.ts is ``JSON.stringify``
    with recursively sorted object keys; for this flat payload the Python
    equivalent is ``json.dumps(sort_keys=True, separators=(",", ":"),
    ensure_ascii=False)`` — compact separators, UTF-8 output like JS.
    """
    canonical = json.dumps(
        cp.signed_payload(), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return CHECKPOINT_PREFIX + canonical


def verify_checkpoint_signature(cp: SignedCheckpointIn) -> str:
    """Return the normalized signer address; 422 when the proof is forged."""
    claimed = normalize_address(cp.signer)
    recovered = recover_signer(checkpoint_message(cp), cp.signature)
    if recovered != claimed:
        raise HTTPException(422, "Signature does not match the claimed signer")
    return claimed


# ── room & actor authorization ──────────────────────────────────────────

async def _active_room(db: AsyncSession, room_id: str) -> Room:
    room = await db.get(Room, room_id)
    if room is None or not room.is_active:
        raise HTTPException(404, "Room not found")
    return room


async def _helper_room_access(
    db: AsyncSession, helper: HelperDevice, room_id: str
) -> None:
    """Helper may report only into rooms where its owner is owner/member."""
    await _active_room(db, room_id)
    perm = (
        await db.execute(
            select(RoomPermission).where(
                RoomPermission.room_id == room_id,
                RoomPermission.user_id == helper.owner_user_id,
            )
        )
    ).scalar_one_or_none()
    if perm is None or perm.role not in ("owner", "member"):
        raise HTTPException(403, "Helper owner is not a member of this room")


async def _helper_actor_ids(db: AsyncSession, helper: HelperDevice, room_id: str) -> set[str]:
    """Identities a helper may legitimately report as actors in a room."""
    allowed = {helper.owner_user_id.lower(), helper.id.lower()}
    perm = (
        await db.execute(
            select(RoomPermission.xmtp_address).where(
                RoomPermission.room_id == room_id,
                RoomPermission.user_id == helper.owner_user_id,
            )
        )
    ).scalar_one_or_none()
    if perm:
        allowed.add(perm.lower())
    seats = (
        await db.execute(
            select(AgentSeat).where(
                AgentSeat.helper_id == helper.id, AgentSeat.room_id == room_id
            )
        )
    ).scalars().all()
    for seat in seats:
        for value in (seat.id, seat.agent_user_id, seat.agent_key, seat.xmtp_address):
            if value:
                allowed.add(value.lower())
    return allowed


async def _agent_room_access(
    db: AsyncSession, agent: User, room_id: str
) -> list[AgentSeat]:
    """Agent may report only where it has membership or a live seat."""
    await _active_room(db, room_id)
    perm = (
        await db.execute(
            select(RoomPermission).where(
                RoomPermission.room_id == room_id,
                RoomPermission.user_id == agent.id,
            )
        )
    ).scalar_one_or_none()
    seats = (
        await db.execute(
            select(AgentSeat).where(
                AgentSeat.room_id == room_id,
                AgentSeat.agent_user_id == agent.id,
                AgentSeat.removed_at.is_(None),
            )
        )
    ).scalars().all()
    if perm is None and not seats:
        raise HTTPException(403, "Agent is not a member of this room")
    if seats and all(s.paused_at is not None for s in seats):
        raise HTTPException(403, "Agent seat is paused")
    return seats


def _agent_actor_ids(agent: User, perm_address: Optional[str], seats: Iterable[AgentSeat]) -> set[str]:
    allowed = {agent.id.lower()}
    if agent.username:
        allowed.add(agent.username.lower())
    if perm_address:
        allowed.add(perm_address.lower())
    for seat in seats:
        for value in (seat.id, seat.agent_user_id, seat.agent_key, seat.xmtp_address):
            if value:
                allowed.add(value.lower())
    return allowed


def _actor_allowed(actor_kind: str, actor_id: str, allowed: set[str]) -> bool:
    if actor_kind == "system" and actor_id.lower() == "system":
        return True
    return actor_id.lower() in allowed


async def _helper_checkpoint_signers(
    db: AsyncSession, helper: HelperDevice, room_id: str
) -> set[str]:
    """Allowed signer addresses for helper checkpoints in ``room_id``.

    Excludes paused/removed seats and viewer-role members so read-only members
    or foreign seats cannot forge or hijack checkpoint anchors.
    """
    signers: set[str] = set()
    seat_addrs = (
        await db.execute(
            select(AgentSeat.xmtp_address).where(
                AgentSeat.helper_id == helper.id,
                AgentSeat.room_id == room_id,
                AgentSeat.removed_at.is_(None),
                AgentSeat.paused_at.is_(None),
            )
        )
    ).scalars().all()
    for addr in seat_addrs:
        if addr:
            signers.add(addr.lower())
    perm_addr = (
        await db.execute(
            select(RoomPermission.xmtp_address).where(
                RoomPermission.room_id == room_id,
                RoomPermission.user_id == helper.owner_user_id,
                RoomPermission.role.in_(("owner", "member")),
            )
        )
    ).scalar_one_or_none()
    if perm_addr:
        signers.add(perm_addr.lower())
    return signers


async def _agent_checkpoint_signers(
    db: AsyncSession, agent: User, room_id: str, seats: list[AgentSeat]
) -> set[str]:
    """Allowed signer addresses for agent checkpoints in ``room_id``."""
    signers: set[str] = set()
    active_seats = [s for s in seats if s.paused_at is None]
    for s in active_seats:
        if s.xmtp_address:
            signers.add(s.xmtp_address.lower())
    user_ids: set[str] = {agent.id}
    if agent.owner_user_id:
        user_ids.add(agent.owner_user_id)
    helper_ids = {s.helper_id for s in active_seats if s.helper_id}
    if helper_ids:
        helper_owners = (
            await db.execute(
                select(HelperDevice.owner_user_id).where(HelperDevice.id.in_(helper_ids))
            )
        ).scalars().all()
        for owner_id in helper_owners:
            if owner_id:
                user_ids.add(owner_id)
    perm_addrs = (
        await db.execute(
            select(RoomPermission.xmtp_address).where(
                RoomPermission.room_id == room_id,
                RoomPermission.user_id.in_(user_ids),
                RoomPermission.role.in_(("owner", "member")),
            )
        )
    ).scalars().all()
    for addr in perm_addrs:
        if addr:
            signers.add(addr.lower())
    return signers


# ── ingest: events ──────────────────────────────────────────────────────

def _event_from_wire(ev: SafeActivityEventIn, reported_by: str | None) -> ActivityEvent:
    return ActivityEvent(
        id=ev.id,
        room_id=ev.room_id,
        actor_kind=ev.actor_kind,
        actor_id=ev.actor_id,
        kind=ev.kind,
        app=ev.app,
        status=ev.status,
        subject_id=ev.subject_id,
        stream_seq=ev.stream_seq,
        reported_by=reported_by,
        created_at=as_utc(ev.created_at),
    )


async def _ingest_one_event(
    db: AsyncSession, ev: SafeActivityEventIn, reported_by: str
) -> bool:
    """Insert one event; returns False when it was an identical duplicate.

    The ``id`` column is the uploader-generated idempotency key: a repeat of
    the same row is a no-op, the same id with different content is a 409.
    """
    existing = await db.get(ActivityEvent, ev.id)
    if existing is not None:
        if not existing.same_payload(_event_from_wire(ev, None)):
            raise HTTPException(409, "Event id already used with different content")
        return False
    db.add(_event_from_wire(ev, reported_by))
    try:
        # Flush now so a duplicate id inside the same batch — or one another
        # transaction committed meanwhile — surfaces here, not at commit.
        await db.flush()
    except IntegrityError:
        # Batches are atomic: roll the whole thing back and let the caller
        # retry; the idempotent re-post then converges to duplicates.
        await db.rollback()
        raise HTTPException(
            409, "Concurrent activity write conflicted; retry the batch"
        ) from None
    return True


async def ingest_events_for_helper(
    db: AsyncSession, helper: HelperDevice, events: list[SafeActivityEventIn]
) -> tuple[int, int]:
    """Batch-ingest helper-reported events; whole batch fails on first 4xx."""
    # Preload actor-id allowlists per referenced room (bounded by MAX_BATCH).
    allowlists: dict[str, set[str]] = {}
    for ev in events:
        if ev.room_id not in allowlists:
            await _helper_room_access(db, helper, ev.room_id)
            allowlists[ev.room_id] = await _helper_actor_ids(db, helper, ev.room_id)
    accepted = duplicates = 0
    for ev in events:
        if not _actor_allowed(ev.actor_kind, ev.actor_id, allowlists[ev.room_id]):
            raise HTTPException(403, "actor_id does not belong to this helper")
        if await _ingest_one_event(db, ev, reported_by=helper.id):
            accepted += 1
        else:
            duplicates += 1
    await db.commit()
    return accepted, duplicates


async def ingest_events_for_agent(
    db: AsyncSession,
    agent: User,
    room_id: str,
    events: list[SafeActivityEventIn],
) -> tuple[int, int]:
    seats = await _agent_room_access(db, agent, room_id)
    perm = (
        await db.execute(
            select(RoomPermission.xmtp_address).where(
                RoomPermission.room_id == room_id,
                RoomPermission.user_id == agent.id,
            )
        )
    ).scalar_one_or_none()
    allowed = _agent_actor_ids(agent, perm, seats)
    accepted = duplicates = 0
    for ev in events:
        if ev.room_id != room_id:
            raise HTTPException(403, "Event room_id does not match the request path")
        if not _actor_allowed(ev.actor_kind, ev.actor_id, allowed):
            raise HTTPException(403, "actor_id does not belong to this agent")
        if await _ingest_one_event(db, ev, reported_by=agent.id):
            accepted += 1
        else:
            duplicates += 1
    await db.commit()
    return accepted, duplicates


# ── ingest: signed ledger checkpoints ───────────────────────────────────

async def _ingest_one_checkpoint(
    db: AsyncSession,
    cp: SignedCheckpointIn,
    *,
    signer_address: str,
    reported_by: str,
) -> bool:
    """Insert one verified checkpoint honoring stream ownership & monotonicity."""
    existing_signer = await db.scalar(
        select(ActivityCheckpoint.signer_address)
        .where(
            ActivityCheckpoint.room_id == cp.room_id,
            ActivityCheckpoint.stream_id == cp.stream_id,
        )
        .limit(1)
    )
    if existing_signer is not None and existing_signer.lower() != signer_address.lower():
        raise HTTPException(
            403,
            "Checkpoint stream is owned by a different signer",
        )
    latest_seq = await db.scalar(
        select(func.max(ActivityCheckpoint.head_seq)).where(
            ActivityCheckpoint.room_id == cp.room_id,
            ActivityCheckpoint.stream_id == cp.stream_id,
        )
    )
    if latest_seq is not None and cp.head_seq < latest_seq:
        raise HTTPException(
            409,
            "Checkpoint head_seq regresses the anchored ledger head",
        )
    same_seq = (
        await db.execute(
            select(ActivityCheckpoint).where(
                ActivityCheckpoint.room_id == cp.room_id,
                ActivityCheckpoint.stream_id == cp.stream_id,
                ActivityCheckpoint.head_seq == cp.head_seq,
            )
        )
    ).scalar_one_or_none()
    if same_seq is not None:
        if same_seq.head_hash == cp.head_hash:
            return False  # identical anchor — idempotent duplicate
        raise HTTPException(
            409, "Conflicting head_hash for the same stream sequence"
        )
    db.add(
        ActivityCheckpoint(
            id=str(uuid.uuid4()),
            room_id=cp.room_id,
            stream_id=cp.stream_id,
            signer_address=signer_address,
            head_seq=cp.head_seq,
            head_hash=cp.head_hash,
            entry_count=cp.entry_count,
            signature=cp.signature,
            reported_by=reported_by,
            checkpoint_at=cp.checkpoint_at(),
            created_at=_now(),
        )
    )
    try:
        await db.flush()
    except IntegrityError:
        # A concurrent insert won the (room_id, stream_id, head_seq) slot.
        # The batch is atomic: roll back and report a conflict — the idempotent
        # retry converges (identical anchors dedupe, divergent ones 409 again).
        await db.rollback()
        raise HTTPException(
            409, "Concurrent checkpoint write conflicted; retry the batch"
        ) from None
    return True


async def ingest_checkpoints_for_helper(
    db: AsyncSession, helper: HelperDevice, checkpoints: list[SignedCheckpointIn]
) -> tuple[int, int]:
    signers_by_room: dict[str, set[str]] = {}
    verified: list[tuple[SignedCheckpointIn, str]] = []
    for cp in checkpoints:
        if cp.room_id not in signers_by_room:
            await _helper_room_access(db, helper, cp.room_id)
            signers_by_room[cp.room_id] = await _helper_checkpoint_signers(
                db, helper, cp.room_id
            )
        signer = verify_checkpoint_signature(cp)
        if signer not in signers_by_room[cp.room_id]:
            raise HTTPException(403, "Checkpoint signer is not authorized for this helper")
        verified.append((cp, signer))
    accepted = duplicates = 0
    for cp, signer in verified:
        if await _ingest_one_checkpoint(
            db, cp, signer_address=signer, reported_by=helper.id
        ):
            accepted += 1
        else:
            duplicates += 1
    await db.commit()
    return accepted, duplicates


async def ingest_checkpoints_for_agent(
    db: AsyncSession,
    agent: User,
    room_id: str,
    checkpoints: list[SignedCheckpointIn],
) -> tuple[int, int]:
    seats = await _agent_room_access(db, agent, room_id)
    allowed_signers = await _agent_checkpoint_signers(db, agent, room_id, seats)
    verified: list[tuple[SignedCheckpointIn, str]] = []
    for cp in checkpoints:
        if cp.room_id != room_id:
            raise HTTPException(403, "Checkpoint room_id does not match the request path")
        signer = verify_checkpoint_signature(cp)
        if signer not in allowed_signers:
            raise HTTPException(403, "Checkpoint signer is not authorized for this agent")
        verified.append((cp, signer))
    accepted = duplicates = 0
    for cp, signer in verified:
        if await _ingest_one_checkpoint(
            db, cp, signer_address=signer, reported_by=agent.id
        ):
            accepted += 1
        else:
            duplicates += 1
    await db.commit()
    return accepted, duplicates


# ── merged read ─────────────────────────────────────────────────────────

def _split_filter(value: Optional[str]) -> Optional[set[str]]:
    if value is None:
        return None
    parts = {v.strip() for v in value.split(",") if v.strip()}
    return parts or None


async def merged_activity_feed(
    db: AsyncSession,
    user: User,
    room_id: str,
    *,
    actor: Optional[str] = None,
    app: Optional[str] = None,
    kinds: Optional[set[str]] = None,
    statuses: Optional[set[str]] = None,
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    limit: int = 100,
) -> ActivityFeed:
    """Merge m2 events + Hub task_events + approvals + latest checkpoints.

    XMTP rooms get strictly safe metadata: approval titles/descriptions,
    task queries/results and task-event payloads are NEVER emitted there —
    chat content must not leak into the Hub activity feed. Hub-cleartext
    rooms expose only the approval title (already visible via the approvals
    API to any member); description/query/payload stay out regardless.
    """
    await require_role(room_id, user, db, min_role="viewer")
    room = await _active_room(db, room_id)
    plaintext_room = room.transport != "xmtp"
    since = as_utc(since)
    until = as_utc(until)

    items: list[ActivityItem] = []

    ev_q = select(ActivityEvent).where(ActivityEvent.room_id == room_id)
    if since is not None:
        ev_q = ev_q.where(ActivityEvent.created_at >= since)
    if until is not None:
        ev_q = ev_q.where(ActivityEvent.created_at <= until)
    if actor:
        ev_q = ev_q.where(func.lower(ActivityEvent.actor_id) == actor.lower())
    if app:
        ev_q = ev_q.where(ActivityEvent.app == app)
    if kinds:
        ev_q = ev_q.where(ActivityEvent.kind.in_(kinds))
    if statuses:
        ev_q = ev_q.where(ActivityEvent.status.in_(statuses))
    ev_rows = (
        await db.execute(
            ev_q.order_by(ActivityEvent.created_at.desc(), ActivityEvent.id).limit(limit)
        )
    ).scalars().all()
    for row in ev_rows:
        items.append(
            ActivityItem(
                id=f"evt:{row.id}",
                source="activity",
                actor_kind=row.actor_kind,
                actor_id=row.actor_id,
                kind=row.kind,
                app=row.app,
                status=row.status,
                subject_id=row.subject_id,
                stream_seq=row.stream_seq,
                reported_by=row.reported_by,
                created_at=_iso(row.created_at),
            )
        )

    # Hub task audit events — payload JSON is never emitted.
    te_q = (
        select(
            TaskEvent.id, TaskEvent.event_type, TaskEvent.event_seq, TaskEvent.created_at,
            A2ATask.id.label("task_id"), A2ATask.source_agent, A2ATask.status,
        )
        .join(A2ATask, TaskEvent.task_id == A2ATask.id)
        .where(A2ATask.room_id == room_id)
    )
    if since is not None:
        te_q = te_q.where(TaskEvent.created_at >= since)
    if until is not None:
        te_q = te_q.where(TaskEvent.created_at <= until)
    if actor:
        te_q = te_q.where(func.lower(A2ATask.source_agent) == actor.lower())
    if kinds:
        te_q = te_q.where(TaskEvent.event_type.in_(kinds))
    if statuses:
        te_q = te_q.where(A2ATask.status.in_(statuses))
    if not app:
        te_rows = (
            await db.execute(
                te_q.order_by(TaskEvent.created_at.desc(), TaskEvent.id).limit(limit)
            )
        ).all()
        for event in te_rows:
            items.append(
                ActivityItem(
                    id=f"task_event:{event.id}",
                    source="task_event",
                    actor_kind="agent",
                    actor_id=event.source_agent,
                    kind=event.event_type,
                    status=event.status,
                    subject_id=event.task_id,
                    stream_seq=event.event_seq,
                    created_at=_iso(event.created_at),
                )
            )

    # Hub approvals — description is never emitted; title only for non-XMTP.
    include_approvals = not app and (kinds is None or "approval" in kinds)
    if include_approvals:
        approval_fields = [
            Approval.id, Approval.requestor_id, Approval.status, Approval.decided_by,
            Approval.created_at, User.user_type,
        ]
        if plaintext_room:
            approval_fields.append(Approval.title)
        ap_q = (
            select(*approval_fields)
            .outerjoin(User, Approval.requestor_id == User.id)
            .where(Approval.room_id == room_id)
        )
        if since is not None:
            ap_q = ap_q.where(Approval.created_at >= since)
        if until is not None:
            ap_q = ap_q.where(Approval.created_at <= until)
        if actor:
            lowered = actor.lower()
            ap_q = ap_q.where(
                or_(
                    func.lower(Approval.requestor_id) == lowered,
                    func.lower(Approval.decided_by) == lowered,
                )
            )
        if statuses:
            ap_q = ap_q.where(Approval.status.in_(statuses))
        ap_rows = (
            await db.execute(
                ap_q.order_by(Approval.created_at.desc(), Approval.id).limit(limit)
            )
        ).all()
        for approval in ap_rows:
            items.append(
                ActivityItem(
                    id=f"approval:{approval.id}",
                    source="approval",
                    actor_kind=approval.user_type or "agent",
                    actor_id=approval.requestor_id,
                    kind="approval",
                    status=approval.status,
                    subject_id=approval.id,
                    reported_by=approval.decided_by,
                    created_at=_iso(approval.created_at),
                    title=approval.title if plaintext_room else None,
                )
            )

    items.sort(key=lambda i: (i.created_at or "", i.id), reverse=True)
    items = items[:limit]

    # Latest verified checkpoint per stream in this room (all streams).
    cp_rows = (
        await db.execute(
            select(ActivityCheckpoint)
            .where(ActivityCheckpoint.room_id == room_id)
            .order_by(
                ActivityCheckpoint.stream_id,
                ActivityCheckpoint.head_seq.desc(),
                ActivityCheckpoint.created_at.desc(),
            )
        )
    ).scalars().all()
    heads: dict[str, ActivityCheckpoint] = {}
    for row in cp_rows:
        heads.setdefault(row.stream_id, row)
    checkpoints = [
        CheckpointView(
            id=row.id,
            stream_id=row.stream_id,
            signer_address=row.signer_address,
            head_seq=row.head_seq,
            head_hash=row.head_hash,
            entry_count=row.entry_count,
            signature=row.signature,
            reported_by=row.reported_by,
            checkpoint_at=_iso(row.checkpoint_at) or "",
            created_at=_iso(row.created_at) or "",
        )
        for row in heads.values()
    ]
    checkpoints.sort(key=lambda c: c.stream_id)

    return ActivityFeed(
        room_id=room_id, items=items, checkpoints=checkpoints, count=len(items)
    )
