"""Local helper business rules.

Invariants every implementation must keep:
- Bearer secrets (pair code, join ticket, helper token) are stored only as salted sha256, like
  app/api/agent_bindings.py. Formats: `mpc_<id>.<secret>` (pair, 10 min), `mjt_<id>.<secret>`
  (join, 2 min), `mhp_<id>.<secret>` (helper, until revoked).
- Single use is enforced by one conditional UPDATE ... WHERE consumed_at IS NULL AND expires_at > now,
  checked by rowcount, never by a read-then-write.
- Owner identity always comes from the stored row (code.owner_user_id / helper.owner_user_id),
  never from the request body.
- A helper may only create seats in rooms where its owner has role owner or member (not viewer).
- Each (owner, agent_key) maps to exactly one agent User (user_type="agent", owner_user_id=owner),
  reused across rooms and helpers of the same owner. Creating it does not need
  MAPR_AGENT_ENROLLMENT_SECRET: the helper token is the owner's delegated authority.
- No message text ever passes through these functions.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import shlex
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.identity import comparison_identity
from app.permissions.service import require_role
from app.core.security import create_access_token
from app.core.timestamps import as_utc
from app.helper.models import AgentSeat, HelperCode, HelperDevice
from app.helper.schemas import (
    AgentSeatStatus,
    CreateSeatRequest,
    CreateSeatViaTicket,
    HeartbeatRequest,
    HeartbeatResponse,
    HeartbeatRoom,
    HelperDeviceView,
    HubRoom,
    JoinTicketRequest,
    JoinTicketResponse,
    PairingCodeResponse,
    PairResponse,
    SeatGrant,
    SeatPeer,
    SeatStatusResponse,
    SeatView,
    trust_tier,
)
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.models.user import User

PAIR_CODE_TTL_SECONDS = 600
JOIN_TICKET_TTL_SECONDS = 120
HELPER_TOKEN_PREFIX = "mhp_"
PAIR_CODE_PREFIX = "mpc_"
JOIN_TICKET_PREFIX = "mjt_"

# Bearer strings longer than this are rejected before any hashing or lookup.
_MAX_SECRET_LENGTH = 128
# Helper tokens refresh last_seen_at at most this often (heartbeat is 30s).
_LAST_SEEN_UPDATE_SECONDS = 60

_attempts: dict[tuple[str, str], deque] = defaultdict(deque)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _digest(secret_text: str, salt: str) -> str:
    return hashlib.sha256((salt + ":" + secret_text).encode()).hexdigest()


def _mint(prefix: str, row_id: str) -> tuple[str, str, str]:
    """Return (presented_token, token_hash, token_salt); only the hash is stored."""
    presented = f"{prefix}{row_id}.{secrets.token_urlsafe(32)}"
    salt = secrets.token_hex(16)
    return presented, _digest(presented, salt), salt


def _row_id_from(presented: str, prefix: str) -> str | None:
    if not presented.startswith(prefix) or len(presented) > _MAX_SECRET_LENGTH:
        return None
    row_id = presented[len(prefix):].partition(".")[0]
    return row_id or None


def _limit_attempt(user_id: str, action: str, limit: int, window: int):
    """In-memory sliding window, same shape as app/api/agent_bindings._limit_attempt."""
    now = time.monotonic()
    key = (user_id, action)
    attempts = _attempts[key]
    while attempts and attempts[0] <= now - window:
        attempts.popleft()
    if not attempts:
        del _attempts[key]
        attempts = _attempts[key]
    if len(attempts) >= limit:
        raise HTTPException(429, "Too many attempts")
    attempts.append(now)


def _reject_pair() -> None:
    raise HTTPException(409, "Pairing code unavailable")


def _reject_join() -> None:
    raise HTTPException(409, "Join ticket unavailable")


def _reject_helper() -> None:
    raise HTTPException(401, "Helper token invalid")


async def _find_code(db: AsyncSession, presented: str, prefix: str, kind: str) -> HelperCode | None:
    """Locate a HelperCode by the presented `<prefix><id>.<secret>` and verify its hash."""
    row_id = _row_id_from(presented, prefix)
    if row_id is None:
        return None
    row = await db.get(HelperCode, row_id)
    if row is None or row.kind != kind:
        return None
    if not hmac.compare_digest(_digest(presented, row.code_salt), row.code_hash):
        return None
    return row


async def _find_helper_by_token(db: AsyncSession, bearer: str) -> HelperDevice | None:
    helper_id = _row_id_from(bearer, HELPER_TOKEN_PREFIX)
    if helper_id is None:
        return None
    helper = await db.get(HelperDevice, helper_id)
    if helper is None:
        return None
    if not hmac.compare_digest(_digest(bearer, helper.token_salt), helper.token_hash):
        return None
    return helper


async def _room_permission(db: AsyncSession, room_id: str, user_id: str) -> RoomPermission | None:
    return (await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == room_id, RoomPermission.user_id == user_id))).scalar_one_or_none()


def _agent_username(owner_id: str, agent_key: str) -> str:
    """Deterministic agent account name; unique index doubles as the create race guard.

    `manual:<uuid>` keys become `manual-<uuid>` so the name stays inside the
    account-name charset (`[\\w.-]`). Bound by schemas._AGENT_KEY (<= 43 chars),
    so the result never exceeds users.username's 64 characters.
    """
    return f"agent-{owner_id[:12]}-{agent_key.replace(':', '-')}"


async def _get_or_create_agent_user(db: AsyncSession, owner_id: str, agent_key: str,
                                    display_name: str) -> User:
    """One agent account per (owner, agent_key), user_type='agent', owner_user_id=owner.

    The deterministic username's unique index serializes concurrent first creation:
    the loser's INSERT raises IntegrityError, the session is rolled back (nothing
    else may be pending at this point) and the winner's row is re-read.
    """
    username = _agent_username(owner_id, agent_key)
    existing = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if existing is not None:
        if existing.user_type != "agent" or existing.owner_user_id != owner_id:
            raise HTTPException(409, "Agent identity conflict")
        if existing.display_name != display_name:
            existing.display_name = display_name
            await db.flush()
        return existing
    agent = User(
        username=username,
        comparison_username=comparison_identity(username),
        display_name=display_name,
        user_type="agent",
        owner_user_id=owner_id,
        owner_bound_at=_now(),
        password_hash=None,
        last_seen_at=_now(),
    )
    db.add(agent)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        existing = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if existing is None or existing.user_type != "agent" or existing.owner_user_id != owner_id:
            raise HTTPException(409, "Agent identity conflict") from None
        if existing.display_name != display_name:
            existing.display_name = display_name
            await db.flush()
        return existing
    return agent


async def _release_membership(db: AsyncSession, agent_user_id: str, room_id: str) -> None:
    """Drop the agent's RoomPermission once no live seat uses it in this room."""
    remaining = await db.scalar(select(func.count()).select_from(AgentSeat).where(
        AgentSeat.agent_user_id == agent_user_id,
        AgentSeat.room_id == room_id,
        AgentSeat.removed_at.is_(None)))
    if remaining:
        return
    await db.execute(delete(RoomPermission).where(
        RoomPermission.room_id == room_id, RoomPermission.user_id == agent_user_id))


async def _retire_seat(db: AsyncSession, seat: AgentSeat) -> None:
    """Mark one seat removed and release its room membership if it was the last live one."""
    if seat.removed_at is not None:
        return
    now = _now()
    seat.removed_at = now
    seat.group_status = "removed"
    await db.flush()
    await _release_membership(db, seat.agent_user_id, seat.room_id)


def _seat_view(seat: AgentSeat, owner_user_id: str, agent_display_name: str) -> SeatView:
    return SeatView(
        seat_id=seat.id,
        room_id=seat.room_id,
        agent_user_id=seat.agent_user_id,
        agent_display_name=agent_display_name,
        owner_user_id=owner_user_id,
        kind=seat.kind,
        trust_tier=trust_tier(seat.kind),
        xmtp_address=seat.xmtp_address,
        group_status="removed" if seat.removed_at is not None else seat.group_status,
        source=seat.source,
        paused_at=as_utc(seat.paused_at).isoformat() if seat.paused_at else None,
    )


async def _seat_owner_user_id(db: AsyncSession, seat: AgentSeat) -> str | None:
    """The human allowed to manage this seat on behalf of its owner.

    helper seats: the paired helper's owner. invite (cloud) seats: the inviting
    user stored as the agent account's owner_user_id.
    """
    if seat.helper_id is not None:
        helper = await db.get(HelperDevice, seat.helper_id)
        return helper.owner_user_id if helper is not None else None
    agent = await db.get(User, seat.agent_user_id)
    return agent.owner_user_id if agent is not None else None


async def _can_manage_seat(db: AsyncSession, seat: AgentSeat, user: User) -> bool:
    """Seat owner or room owner may pause/resume/report group state."""
    if (await _seat_owner_user_id(db, seat)) == user.id:
        return True
    perm = await _room_permission(db, seat.room_id, user.id)
    return perm is not None and perm.role == "owner"


# ── human side ──

async def issue_pairing_code(db: AsyncSession, owner: User, hub_origin: str) -> PairingCodeResponse:
    """Human only. Rate limit 10 per 10 min. install_command embeds the code and hub_origin."""
    _limit_attempt(owner.id, "issue-pairing-code", 10, 600)
    now = _now()
    # UPDATE obtains a DB write/row lock, serializing issuance counts across workers.
    await db.execute(update(User).where(User.id == owner.id, User.user_type == "human")
                     .values(owner_user_id=User.owner_user_id).execution_options(synchronize_session=False))
    count = await db.scalar(select(func.count()).select_from(HelperCode).where(
        HelperCode.owner_user_id == owner.id,
        HelperCode.kind == "pair",
        HelperCode.created_at > now - timedelta(seconds=PAIR_CODE_TTL_SECONDS)))
    if count >= 10:
        await db.rollback()
        raise HTTPException(429, "Too many pairing codes")
    expires = now + timedelta(seconds=PAIR_CODE_TTL_SECONDS)
    row_id = str(uuid.uuid4())
    code, code_hash, code_salt = _mint(PAIR_CODE_PREFIX, row_id)
    db.add(HelperCode(id=row_id, kind="pair", owner_user_id=owner.id,
                      code_hash=code_hash, code_salt=code_salt,
                      expires_at=expires, created_at=now))
    await db.commit()
    install_command = (
        f"curl -fsSL {shlex.quote(hub_origin + '/install.sh')} | "
        f"sh -s -- --pair {shlex.quote(code)} --hub {shlex.quote(hub_origin)}"
    )
    return PairingCodeResponse(code=code, expires_at=expires.isoformat(),
                               install_command=install_command)


async def list_helpers(db: AsyncSession, owner: User) -> list[HelperDeviceView]:
    rows = (await db.execute(select(HelperDevice).where(
        HelperDevice.owner_user_id == owner.id)
        .order_by(HelperDevice.created_at, HelperDevice.id))).scalars().all()
    return [HelperDeviceView(
        id=h.id,
        device_name=h.device_name,
        platform=h.platform,
        created_at=as_utc(h.created_at).isoformat(),
        last_seen_at=as_utc(h.last_seen_at).isoformat() if h.last_seen_at else None,
        revoked=h.revoked_at is not None) for h in rows]


async def revoke_helper(db: AsyncSession, owner: User, helper_id: str) -> None:
    """Sets revoked_at and marks all its seats removed. Next heartbeat returns revoked=true."""
    helper = await db.get(HelperDevice, helper_id)
    if helper is None or helper.owner_user_id != owner.id:
        raise HTTPException(404, "Helper not found")
    now = _now()
    if helper.revoked_at is None:
        helper.revoked_at = now
    live = (await db.execute(select(AgentSeat).where(
        AgentSeat.helper_id == helper.id, AgentSeat.removed_at.is_(None)))).scalars().all()
    for seat in live:
        seat.removed_at = now
        seat.group_status = "removed"
    await db.flush()
    for seat in live:
        await _release_membership(db, seat.agent_user_id, seat.room_id)
    await db.commit()


async def issue_join_ticket(db: AsyncSession, owner: User, helper_id: str, req: JoinTicketRequest) -> JoinTicketResponse:
    """Human only; helper must belong to owner and not be revoked; owner must be owner/member of the room."""
    helper = await db.get(HelperDevice, helper_id)
    if helper is None or helper.owner_user_id != owner.id:
        raise HTTPException(404, "Helper not found")
    if helper.revoked_at is not None:
        raise HTTPException(409, "Helper revoked")
    # Viewers cannot bring agents into a room (decision D4).
    await require_role(req.room_id, owner, db, min_role="member")
    now = _now()
    expires = now + timedelta(seconds=JOIN_TICKET_TTL_SECONDS)
    row_id = str(uuid.uuid4())
    ticket, code_hash, code_salt = _mint(JOIN_TICKET_PREFIX, row_id)
    db.add(HelperCode(id=row_id, kind="join", owner_user_id=owner.id,
                      code_hash=code_hash, code_salt=code_salt,
                      helper_id=helper_id, room_id=req.room_id,
                      agent_key=req.agent_key, owner_xmtp_address=req.owner_xmtp_address,
                      expires_at=expires, created_at=now))
    await db.commit()
    return JoinTicketResponse(ticket=ticket, expires_at=expires.isoformat())


async def list_room_seats(db: AsyncSession, user: User, room_id: str) -> list[SeatView]:
    """Any room member may list. The room page auto-adds only seats whose owner_user_id is the viewer."""
    await require_role(room_id, user, db, min_role="viewer")
    rows = (await db.execute(
        select(AgentSeat, func.coalesce(HelperDevice.owner_user_id, User.owner_user_id), User.display_name)
        .outerjoin(HelperDevice, AgentSeat.helper_id == HelperDevice.id)
        .join(User, AgentSeat.agent_user_id == User.id)
        .where(AgentSeat.room_id == room_id)
        .order_by(AgentSeat.created_at, AgentSeat.id))).all()
    return [_seat_view(seat, owner_user_id, display_name)
            for seat, owner_user_id, display_name in rows]


async def list_seat_peers(db: AsyncSession, user: User, room_id: str) -> list[SeatPeer]:
    """席位互相认人的最小名单：名字、类型、信任分级、XMTP 地址。

    人类按房间成员身份放行（viewer 及以上）；Agent 账号须自己在本房有活跃席位。
    成员进程据此区分「发消息的是人还是 Agent」（连环护栏用），地址本就群成员互见。
    """
    if user.user_type == "agent":
        own = await db.scalar(select(func.count()).select_from(AgentSeat).where(
            AgentSeat.room_id == room_id,
            AgentSeat.agent_user_id == user.id,
            AgentSeat.removed_at.is_(None)))
        if not own:
            raise HTTPException(403, "Agent seat required in this room")
    else:
        await require_role(room_id, user, db, min_role="viewer")
    rows = (await db.execute(
        select(AgentSeat, User.display_name)
        .join(User, AgentSeat.agent_user_id == User.id)
        .where(AgentSeat.room_id == room_id, AgentSeat.removed_at.is_(None))
        .order_by(AgentSeat.created_at, AgentSeat.id))).all()
    return [SeatPeer(agent_display_name=display_name, kind=seat.kind,
                     trust_tier=trust_tier(seat.kind), xmtp_address=seat.xmtp_address,
                     source=seat.source,
                     paused_at=as_utc(seat.paused_at).isoformat() if seat.paused_at else None)
            for seat, display_name in rows]


async def mark_group_added(db: AsyncSession, user: User, room_id: str, seat_id: str) -> None:
    """Seat owner or room owner may report pending → added (idempotent). Hub cannot
    verify XMTP state; this flag only stops repeated add attempts. Room-owner
    access exists so the owner's client can pull cloud (source='invite') seats
    into the group and record the result."""
    seat = await db.get(AgentSeat, seat_id)
    if seat is None or seat.room_id != room_id:
        raise HTTPException(404, "Seat not found")
    if not await _can_manage_seat(db, seat, user):
        raise HTTPException(403, "Requires seat owner or room owner")
    if seat.removed_at is not None:
        raise HTTPException(409, "Seat removed")
    if seat.group_status == "added":
        return
    now = _now()
    changed = await db.execute(update(AgentSeat).where(
        AgentSeat.id == seat_id,
        AgentSeat.group_status == "pending",
        AgentSeat.removed_at.is_(None),
    ).values(group_status="added", group_added_at=now).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        await db.rollback()
        fresh = await db.get(AgentSeat, seat_id)
        if fresh is not None and fresh.group_status == "added" and fresh.removed_at is None:
            return
        raise HTTPException(409, "Seat state changed")
    await db.commit()


async def remove_seat_by_human(db: AsyncSession, user: User, room_id: str, seat_id: str) -> None:
    """Seat owner or room owner. Deletes the agent's RoomPermission row and sets removed_at."""
    seat = await db.get(AgentSeat, seat_id)
    if seat is None or seat.room_id != room_id:
        raise HTTPException(404, "Seat not found")
    if not await _can_manage_seat(db, seat, user):
        raise HTTPException(403, "Requires seat owner or room owner")
    await _retire_seat(db, seat)
    await db.commit()


async def set_seat_paused(db: AsyncSession, user: User, room_id: str, seat_id: str, paused: bool) -> None:
    """Owner-controlled pause/resume (WP5).

    Pause only stops the member process — the seat row, its identity and its
    audit trail stay (never conflated with removal). The helper learns about it
    through HeartbeatResponse.seats_to_pause; resume only revives seats that
    were explicitly paused. Idempotent.
    """
    seat = await db.get(AgentSeat, seat_id)
    if seat is None or seat.room_id != room_id:
        raise HTTPException(404, "Seat not found")
    if not await _can_manage_seat(db, seat, user):
        raise HTTPException(403, "Requires seat owner or room owner")
    if seat.removed_at is not None:
        raise HTTPException(409, "Seat removed")
    now = _now()
    if paused and seat.paused_at is None:
        seat.paused_at = now
    elif not paused and seat.paused_at is not None:
        seat.paused_at = None
    await db.commit()


# ── cloud agent self-service (WP5/WP6): the agent JWT, not a helper token ──

async def get_agent_seat_status(db: AsyncSession, user: User, seat_id: str) -> AgentSeatStatus:
    """Cloud agent reads its own seat lifecycle, including after removal.

    Deliberately does NOT require an active seat (unlike seat-peers): a removed
    agent must still learn removed_at so it can fail closed instead of
    believing it is still in the group.
    """
    seat = await db.get(AgentSeat, seat_id)
    if seat is None or seat.agent_user_id != user.id:
        raise HTTPException(404, "Seat not found")
    return AgentSeatStatus(
        seat_id=seat.id,
        room_id=seat.room_id,
        source=seat.source,
        group_status="removed" if seat.removed_at is not None else seat.group_status,
        paused_at=as_utc(seat.paused_at).isoformat() if seat.paused_at else None,
        removed_at=as_utc(seat.removed_at).isoformat() if seat.removed_at else None,
    )


async def refresh_agent_seat_token(db: AsyncSession, user: User, seat_id: str) -> str:
    """Renew the agent JWT for a seat the caller itself occupies.

    A removed seat gets no new tokens (403/409 — never silently re-armed).
    """
    seat = await db.get(AgentSeat, seat_id)
    if seat is None or seat.agent_user_id != user.id:
        raise HTTPException(404, "Seat not found")
    if seat.removed_at is not None:
        raise HTTPException(409, "Seat removed")
    if seat.paused_at is not None:
        raise HTTPException(409, "Seat paused")
    return create_access_token(seat.agent_user_id, "agent")


# ── helper side ──

async def pair_helper(db: AsyncSession, code: str, device_name: str, platform: str) -> PairResponse:
    """Consumes a kind='pair' code, creates HelperDevice, returns the token once (Cache-Control: no-store)."""
    row = await _find_code(db, code, PAIR_CODE_PREFIX, "pair")
    if row is None:
        _reject_pair()
    owner = await db.get(User, row.owner_user_id, populate_existing=True)
    if owner is None or owner.user_type != "human" or not owner.is_active:
        _reject_pair()
    now = _now()
    consumed = await db.execute(update(HelperCode).where(
        HelperCode.id == row.id,
        HelperCode.kind == "pair",
        HelperCode.consumed_at.is_(None),
        HelperCode.expires_at > now,
    ).values(consumed_at=now).execution_options(synchronize_session=False))
    if consumed.rowcount != 1:
        await db.rollback()
        _reject_pair()
    helper_id = str(uuid.uuid4())
    token, token_hash, token_salt = _mint(HELPER_TOKEN_PREFIX, helper_id)
    db.add(HelperDevice(id=helper_id, owner_user_id=owner.id, device_name=device_name,
                        platform=platform, token_hash=token_hash, token_salt=token_salt,
                        last_seen_at=now))
    await db.commit()
    return PairResponse(helper_id=helper_id, helper_token=token,
                        owner_user_id=owner.id, owner_display_name=owner.display_name)


async def authenticate_helper(db: AsyncSession, bearer: str, *, allow_revoked: bool = False) -> HelperDevice:
    """401 on unknown/revoked token; also 401 if the owner is inactive. Updates last_seen_at
    at most once a minute. allow_revoked exists only for heartbeat: a revoked helper must
    still learn it was revoked (revoked=true) instead of seeing a bare 401."""
    helper = await _find_helper_by_token(db, bearer)
    if helper is None:
        _reject_helper()
    if helper.revoked_at is not None and not allow_revoked:
        _reject_helper()
    owner = await db.get(User, helper.owner_user_id, populate_existing=True)
    if owner is None or not owner.is_active:
        _reject_helper()
    now = _now()
    if helper.last_seen_at is None or as_utc(helper.last_seen_at) <= now - timedelta(seconds=_LAST_SEEN_UPDATE_SECONDS):
        helper.last_seen_at = now
        await db.commit()
    return helper


async def list_helper_rooms(db: AsyncSession, helper: HelperDevice) -> list[HubRoom]:
    rows = (await db.execute(
        select(Room, RoomPermission)
        .join(RoomPermission, (RoomPermission.room_id == Room.id)
              & (RoomPermission.user_id == helper.owner_user_id))
        .where(Room.is_active == True)  # noqa: E712
        .order_by(Room.created_at, Room.id))).all()
    return [HubRoom(id=room.id, name=room.name, xmtp_group_id=room.xmtp_group_id, role=perm.role)
            for room, perm in rows]


async def create_seat(db: AsyncSession, helper: HelperDevice, req: CreateSeatRequest) -> SeatGrant:
    """
    1. via=ticket: consume a kind='join' code bound to this helper; room_id/agent_key come from the code.
       via=local: room_id from the body; owner role checked.
    2. Get or create the owner's agent User for agent_key.
    3. Ensure RoomPermission(role='member', invited_by=owner).
    4. Upsert AgentSeat (helper_id, agent_key, room_id): new xmtp_address, group_status='pending', removed_at=None.
    5. allowed_senders = [owner_xmtp_address] when via=ticket, else []. Other room members are
       accepted by the member process through XMTP_ALLOW_GROUP_MEMBERS (see plan, decision D3).
    6. agent_token = create_access_token(agent_user_id, "agent").
    """
    # Snapshot helper fields: the IntegrityError recovery below rolls the session
    # back, which expires every ORM row loaded so far.
    helper_id = helper.id
    helper_owner_id = helper.owner_user_id
    if isinstance(req, CreateSeatViaTicket):
        presented = req.ticket.get_secret_value()
        code_row = await _find_code(db, presented, JOIN_TICKET_PREFIX, "join")
        if code_row is None or code_row.helper_id != helper_id:
            _reject_join()
        # Snapshot the code's fields before any rollback can expire the ORM row.
        code_id = code_row.id
        room_id = code_row.room_id
        agent_key = code_row.agent_key
        owner_id = code_row.owner_user_id
        owner_xmtp = code_row.owner_xmtp_address
        if agent_key != req.agent_key:
            _reject_join()
    else:
        code_id = None
        room_id = req.room_id
        agent_key = req.agent_key
        owner_id = helper_owner_id
        owner_xmtp = None

    owner = await db.get(User, owner_id, populate_existing=True)
    if owner is None or owner.user_type != "human" or not owner.is_active:
        raise HTTPException(403, "Seat owner unavailable")
    room = await db.get(Room, room_id)
    if room is None or not room.is_active:
        raise HTTPException(404, "Room not found")
    room_name = room.name
    room_group_id = room.xmtp_group_id
    owner_perm = await _room_permission(db, room_id, owner_id)
    if owner_perm is None or owner_perm.role not in ("owner", "member"):
        raise HTTPException(403, "Requires owner or member role")

    agent = await _get_or_create_agent_user(db, owner_id, agent_key, req.display_name)
    agent_user_id = agent.id
    agent_username = agent.username

    if code_id is not None:
        now = _now()
        consumed = await db.execute(update(HelperCode).where(
            HelperCode.id == code_id,
            HelperCode.kind == "join",
            HelperCode.consumed_at.is_(None),
            HelperCode.expires_at > now,
        ).values(consumed_at=now).execution_options(synchronize_session=False))
        if consumed.rowcount != 1:
            await db.rollback()
            _reject_join()
        await db.commit()

    if (await _room_permission(db, room_id, agent_user_id)) is None:
        db.add(RoomPermission(room_id=room_id, user_id=agent_user_id,
                              role="member", invited_by=owner_id))

    now = _now()
    seat = (await db.execute(select(AgentSeat).where(
        AgentSeat.helper_id == helper_id,
        AgentSeat.agent_key == agent_key,
        AgentSeat.room_id == room_id))).scalar_one_or_none()
    if seat is None:
        seat = AgentSeat(helper_id=helper_id, agent_user_id=agent_user_id, room_id=room_id,
                         agent_key=agent_key, kind=req.kind, xmtp_address=req.xmtp_address,
                         group_status="pending", created_at=now)
        db.add(seat)
    else:
        seat.agent_user_id = agent_user_id
        seat.kind = req.kind
        seat.xmtp_address = req.xmtp_address
        seat.group_status = "pending"
        seat.group_added_at = None
        seat.removed_at = None
    try:
        await db.commit()
    except IntegrityError:
        # A concurrent request created the same (helper, agent_key, room) seat
        # first; fold this request's data into the winner's row. The rollback
        # also dropped our uncommitted agent User row, so the winning account
        # is re-read rather than trusting the dead id.
        await db.rollback()
        agent = await _get_or_create_agent_user(db, owner_id, agent_key, req.display_name)
        agent_user_id = agent.id
        agent_username = agent.username
        seat = (await db.execute(select(AgentSeat).where(
            AgentSeat.helper_id == helper_id,
            AgentSeat.agent_key == agent_key,
            AgentSeat.room_id == room_id))).scalar_one_or_none()
        if seat is None:
            raise HTTPException(503, "Seat storage temporarily unavailable") from None
        seat.agent_user_id = agent_user_id
        seat.kind = req.kind
        seat.xmtp_address = req.xmtp_address
        seat.group_status = "pending"
        seat.group_added_at = None
        seat.removed_at = None
        if (await _room_permission(db, room_id, agent_user_id)) is None:
            db.add(RoomPermission(room_id=room_id, user_id=agent_user_id,
                                  role="member", invited_by=owner_id))
        await db.commit()
    return SeatGrant(
        seat_id=seat.id, room_id=room_id, room_name=room_name,
        agent_user_id=agent_user_id, agent_username=agent_username,
        agent_token=create_access_token(agent_user_id, "agent"),
        xmtp_group_id=room_group_id,
        allowed_senders=[owner_xmtp] if owner_xmtp else [])


async def get_seat(db: AsyncSession, helper: HelperDevice, seat_id: str) -> SeatStatusResponse:
    seat = await db.get(AgentSeat, seat_id)
    if seat is None or seat.helper_id != helper.id:
        raise HTTPException(404, "Seat not found")
    room = await db.get(Room, seat.room_id)
    return SeatStatusResponse(
        xmtp_group_id=room.xmtp_group_id if room is not None else None,
        group_status="removed" if seat.removed_at is not None else seat.group_status)


async def refresh_agent_token(db: AsyncSession, helper: HelperDevice, seat_id: str) -> str:
    seat = await db.get(AgentSeat, seat_id)
    if seat is None or seat.helper_id != helper.id:
        raise HTTPException(404, "Seat not found")
    if seat.removed_at is not None:
        raise HTTPException(409, "Seat removed")
    if seat.paused_at is not None:
        raise HTTPException(409, "Seat paused")
    return create_access_token(seat.agent_user_id, "agent")


async def delete_seat_by_helper(db: AsyncSession, helper: HelperDevice, seat_id: str) -> None:
    seat = await db.get(AgentSeat, seat_id)
    if seat is None or seat.helper_id != helper.id:
        raise HTTPException(404, "Seat not found")
    await _retire_seat(db, seat)
    await db.commit()


async def heartbeat(db: AsyncSession, helper: HelperDevice, req: HeartbeatRequest) -> HeartbeatResponse:
    """seats_to_stop = seats of this helper with removed_at set.

    seats_to_pause is a SEPARATE list (paused_at set, not removed): the helper
    must stop the member process but keep all local seat data — reusing
    seats_to_stop would trigger local cleanup. rooms carries the owner's room
    metadata versions so workers can re-pull settings_json on change.
    """
    rows = (await db.execute(select(AgentSeat.id).where(
        AgentSeat.helper_id == helper.id,
        AgentSeat.removed_at.isnot(None)).order_by(AgentSeat.id))).scalars().all()
    paused = (await db.execute(select(AgentSeat.id).where(
        AgentSeat.helper_id == helper.id,
        AgentSeat.paused_at.isnot(None),
        AgentSeat.removed_at.is_(None)).order_by(AgentSeat.id))).scalars().all()
    room_rows = (await db.execute(
        select(Room.id, Room.settings_version, Room.settings_json)
        .join(RoomPermission, (RoomPermission.room_id == Room.id)
              & (RoomPermission.user_id == helper.owner_user_id))
        .where(Room.is_active == True)  # noqa: E712
        .order_by(Room.created_at, Room.id))).all()
    return HeartbeatResponse(
        revoked=helper.revoked_at is not None,
        seats_to_stop=list(rows),
        seats_to_pause=list(paused),
        rooms=[HeartbeatRoom(id=room_id, settings_version=version, settings_json=settings)
               for room_id, version, settings in room_rows])
