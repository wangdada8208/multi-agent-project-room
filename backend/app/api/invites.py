"""Room invite API: reusable invite links, per-redemption approval, cloud agents.

m1/WP6 contract (plan distant-timber-bull §3 + plan-4ec92a5b revisions):

- Invites carry max_uses/use_count/requires_approval/role/revoked_at. Role is
  restricted to member|viewer — a link can never mint an owner.
- ``redeem`` and ``agent-register`` require an EIP-191 signature over a
  domain-separated single-use server nonce (``POST /api/v1/invites/nonce``).
  Address-only squatting is rejected.
- Capacity is consumed by ONE conditional UPDATE
  ``use_count < max_uses AND revoked_at IS NULL AND expires_at > now`` checked
  by rowcount, inside the same transaction as the redemption/seat rows.
  Pending (awaiting-approval) redemptions never consume capacity; approval
  performs the same conditional UPDATE.
- Revocation sets revoked_at (no physical delete) and cascades pending
  redemptions to 'revoked' in the same transaction.
- approved_scopes is always a subset of proposed_scopes and never crosses the
  hard-forbidden scope list, enforced at create, redeem and approve time.
"""
from __future__ import annotations

import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.identity import comparison_identity
from app.api.permissions import get_room_permission, require_role

from app.core.database import get_db
from app.core.eip191 import (
    ACTION_AGENT_REGISTER,
    ACTION_INVITE_REDEEM,
    issue_nonce,
    normalize_address,
    require_signed_nonce,
)
from app.core.security import bearer_scheme, create_access_token, decode_access_token, get_current_user
from app.helper.models import AgentSeat
from app.models.room import Room
from app.models.room_invite import RoomInvite
from app.models.room_invite_redemption import RoomInviteRedemption
from app.models.room_permission import RoomPermission
from app.models.user import User

router = APIRouter(tags=["invites"])

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_SCOPE_RE = re.compile(r"^[a-z][a-z0-9_.]{0,63}$")

# Hard-forbidden scopes — same list as workers/xmtp-member rulesEngine. An
# invite that even *proposes* these is a 422, and approval can never grant
# them back.
FORBIDDEN_SCOPE_PREFIXES = ("payment.", "banking.", "credentials.", "password.", "card.", "wallet.")
FORBIDDEN_SCOPES = frozenset({"data.export_all"})

MAX_PENDING_REDEMPTIONS_PER_TOKEN = 64
PENDING_REDEMPTION_TTL = timedelta(days=7)


def _as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def scope_is_forbidden(scope: str) -> bool:
    s = (scope or "").strip().lower()
    return s in FORBIDDEN_SCOPES or any(s.startswith(p) for p in FORBIDDEN_SCOPE_PREFIXES)


def validate_scope_list(scopes: List[str], *, field: str = "proposed_scopes") -> List[str]:
    """Normalize + vet a scope list. 422 on bad shape or hard-forbidden entries."""
    if len(scopes) > 64:
        raise HTTPException(status_code=422, detail=f"{field} is too large")
    cleaned: list[str] = []
    for raw in scopes:
        s = (raw or "").strip().lower()
        if not _SCOPE_RE.match(s):
            raise HTTPException(status_code=422, detail=f"Invalid scope: {raw!r}")
        if scope_is_forbidden(s):
            raise HTTPException(status_code=422, detail=f"Scope is not allowed: {s}")
        if s not in cleaned:
            cleaned.append(s)
    return cleaned


def _scopes_within(approved: List[str], proposed: List[str]) -> None:
    """approved ⊆ proposed, no forbidden entries (defense in depth)."""
    cleaned = validate_scope_list(approved, field="approved_scopes")
    proposed_set = set(proposed or [])
    extra = [s for s in cleaned if s not in proposed_set]
    if extra:
        raise HTTPException(
            status_code=422, detail="approved_scopes must be a subset of proposed_scopes"
        )


async def _optional_human_user(
    credentials: HTTPAuthorizationCredentials | None,
    db: AsyncSession,
) -> User | None:
    if credentials is None or not credentials.credentials:
        return None
    try:
        payload = decode_access_token(credentials.credentials)
    except HTTPException:
        return None
    if payload.get("typ") != "human":
        return None
    user = await db.get(User, payload["sub"])
    if user is None or user.user_type != "human" or not getattr(user, "is_active", True):
        return None
    return user


async def _ensure_member_permission(
    db: AsyncSession,
    room_id: str,
    user: User,
    invited_by: Optional[str],
    role: str = "member",
    xmtp_address: Optional[str] = None,
) -> RoomPermission:
    existing = await get_room_permission(room_id, user, db)
    if existing is not None:
        if xmtp_address and not existing.xmtp_address:
            existing.xmtp_address = xmtp_address
            await db.flush()
        return existing
    perm = RoomPermission(
        room_id=room_id,
        user_id=user.id,
        role=role if role in ("member", "viewer") else "member",
        invited_by=invited_by,
        xmtp_address=xmtp_address,
    )
    db.add(perm)
    await db.flush()
    return perm


async def _get_invite_or_404(db: AsyncSession, token: str) -> RoomInvite:
    invite = await db.get(RoomInvite, token)
    if invite is None:
        raise HTTPException(status_code=404, detail="Invite token not found")
    return invite


def _invite_state(invite: RoomInvite, now: datetime) -> str:
    """'open' | 'revoked' | 'expired' | 'exhausted'."""
    if invite.revoked_at is not None:
        return "revoked"
    if _as_utc(invite.expires_at) <= now:
        return "expired"
    if (invite.use_count or 0) >= (invite.max_uses or 1):
        return "exhausted"
    # H1 defense in depth: pre-m1 single-use invite redeemed via legacy used_at.
    if (invite.max_uses or 1) == 1 and invite.used_at is not None:
        return "exhausted"
    return "open"


async def _find_redemption(
    db: AsyncSession, token: str, address: Optional[str] = None, user_id: Optional[str] = None
) -> RoomInviteRedemption | None:
    stmt = select(RoomInviteRedemption).where(RoomInviteRedemption.token == token)
    if address is not None:
        stmt = stmt.where(RoomInviteRedemption.redeemer_address == address)
    elif user_id is not None:
        stmt = stmt.where(RoomInviteRedemption.redeemer_user_id == user_id)
    else:
        return None
    stmt = stmt.order_by(RoomInviteRedemption.created_at.desc())
    return (await db.execute(stmt)).scalars().first()


async def _pending_redemption_guard(db: AsyncSession, token: str) -> None:
    """Bounded pending queue per invite (DoS guard); pending never consumes capacity."""
    pending = await db.scalar(
        select(func.count()).select_from(RoomInviteRedemption).where(
            RoomInviteRedemption.token == token,
            RoomInviteRedemption.status == "pending",
        )
    )
    if (pending or 0) >= MAX_PENDING_REDEMPTIONS_PER_TOKEN:
        raise HTTPException(status_code=429, detail="Too many pending redemptions for this invite")


async def _consume_invite_use(db: AsyncSession, token: str) -> bool:
    """The ONE capacity check: conditional UPDATE judged by rowcount."""
    now = datetime.now(timezone.utc)
    result = await db.execute(
        update(RoomInvite)
        .where(
            RoomInvite.token == token,
            RoomInvite.use_count < RoomInvite.max_uses,
            or_(RoomInvite.max_uses > 1, RoomInvite.used_at.is_(None)),
            RoomInvite.revoked_at.is_(None),
            RoomInvite.expires_at > now,
        )
        .values(use_count=RoomInvite.use_count + 1)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


async def _touch_legacy_redeem_fields(
    db: AsyncSession, token: str, address: str, now: datetime
) -> None:
    """Keep used_at/redeemed_by_address populated for the legacy single-use
    group-sync path until the frontend moves to redemption rows."""
    await db.execute(
        update(RoomInvite)
        .where(RoomInvite.token == token, RoomInvite.used_at.is_(None))
        .values(used_at=now, redeemed_by_address=address)
        .execution_options(synchronize_session=False)
    )


def _agent_username_for_address(address: str) -> str:
    # 11 + 42 = 53 chars, inside users.username's 64 and the account-name
    # charset ([\w.-]); comparison_identity folds '-' and '.' together, which
    # is safe here because the tail is pure hex.
    return f"agent-xmtp-{address}"


async def _get_or_create_xmtp_agent(
    db: AsyncSession, owner_id: str, address: str, display_name: str
) -> User:
    """One cloud-agent account per verified XMTP address; invite.created_by is
    recorded as its owner_user_id so seat management has a human principal."""
    username = _agent_username_for_address(address)
    existing = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if existing is not None:
        if existing.user_type != "agent":
            raise HTTPException(409, "Agent identity conflict")
        return existing
    agent = User(
        username=username,
        comparison_username=comparison_identity(username),
        display_name=display_name[:128],
        user_type="agent",
        owner_user_id=owner_id,
        owner_bound_at=datetime.now(timezone.utc),
        password_hash=None,
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(agent)
    try:
        async with db.begin_nested():  # savepoint: a lost username race must
            await db.flush()         # not roll back the caller's capacity UPDATE
    except IntegrityError:
        existing = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if existing is None or existing.user_type != "agent":
            raise HTTPException(409, "Agent identity conflict") from None
        return existing
    return agent


async def _upsert_invite_seat(
    db: AsyncSession, *, room_id: str, agent_user_id: str, address: str, redemption_id: str
) -> AgentSeat:
    """Create or revive the cloud seat. The partial unique index
    uq_agent_seat_invite guarantees at most one invite seat per (room, agent)."""
    seat = (await db.execute(select(AgentSeat).where(
        AgentSeat.room_id == room_id,
        AgentSeat.agent_user_id == agent_user_id,
        AgentSeat.helper_id.is_(None),
    ))).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if seat is None:
        seat = AgentSeat(
            helper_id=None,
            agent_user_id=agent_user_id,
            room_id=room_id,
            agent_key=f"ext:{redemption_id}",
            kind="cloud-agent",
            xmtp_address=address,
            group_status="pending",
            source="invite",
            created_at=now,
        )
        db.add(seat)
        await db.flush()
        return seat
    seat.agent_key = f"ext:{redemption_id}"
    seat.kind = "cloud-agent"
    seat.xmtp_address = address
    seat.source = "invite"
    seat.group_status = "pending"
    seat.group_added_at = None
    seat.paused_at = None
    seat.removed_at = None
    await db.flush()
    return seat


async def _grant_agent_seat(
    db: AsyncSession,
    *,
    invite: RoomInvite,
    redemption: RoomInviteRedemption,
    approved_scopes: List[str],
    display_name: Optional[str],
) -> AgentSeat:
    """Create the agent account, permission row and invite seat in the caller's
    transaction. Caller must have consumed invite capacity already."""
    address = redemption.redeemer_address
    agent = await _get_or_create_xmtp_agent(
        db, invite.created_by, address, display_name or f"Agent {address[:10]}"
    )
    await _ensure_member_permission(
        db, invite.room_id, agent, invite.created_by, role="member", xmtp_address=address
    )
    seat = await _upsert_invite_seat(
        db, room_id=invite.room_id, agent_user_id=agent.id, address=address,
        redemption_id=redemption.id,
    )
    redemption.agent_user_id = agent.id
    redemption.seat_id = seat.id
    redemption.approved_scopes = list(approved_scopes)
    await db.flush()
    return seat


class CreateInviteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposed_scopes: List[str] = Field(default_factory=list)
    expires_hours: int = Field(default=24, ge=1, le=720)
    max_uses: int = Field(default=1, ge=1, le=32)
    requires_approval: bool = False
    role: Literal["member", "viewer"] = "member"


class SignedProof(BaseModel):
    model_config = ConfigDict(extra="forbid")

    nonce: str = Field(min_length=1, max_length=128)
    signature: str = Field(min_length=10, max_length=200)


class RedeemInviteRequest(SignedProof):
    xmtp_address: str = Field(min_length=42, max_length=42)


class AgentRegisterRequest(SignedProof):
    xmtp_address: str = Field(min_length=42, max_length=42)
    display_name: Optional[str] = Field(default=None, max_length=128)


class NonceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["invite-redeem", "invite-agent-register", "bind-address"]
    resource: str = Field(min_length=1, max_length=128)
    address: str = Field(min_length=42, max_length=42)


class ApproveRedemptionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    approved_scopes: Optional[List[str]] = None
    display_name: Optional[str] = Field(default=None, max_length=128)


class DenyRedemptionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Optional[str] = Field(default=None, max_length=64)


@router.post("/api/v1/rooms/{room_id}/invites")
async def create_room_invite(
    room_id: str,
    payload: CreateInviteRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Generate an invite token for an agent to join the room. Owner only."""
    await require_role(room_id, current_user, db, min_role="owner")

    room = await db.get(Room, room_id)
    if room is None or not room.is_active:
        raise HTTPException(status_code=404, detail="Room not found")

    scopes = validate_scope_list(payload.proposed_scopes)

    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=payload.expires_hours)

    invite = RoomInvite(
        token=token,
        room_id=room_id,
        created_by=current_user.id,
        proposed_scopes=scopes,
        expires_at=expires_at,
        max_uses=payload.max_uses,
        requires_approval=payload.requires_approval,
        role=payload.role,
        created_at=now,
    )
    db.add(invite)
    await db.commit()
    await db.refresh(invite)

    return {"invite": invite.to_dict()}


@router.get("/api/v1/rooms/{room_id}/invites")
async def list_room_invites(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """List all invite tokens for a room. Owner only."""
    await require_role(room_id, current_user, db, min_role="owner")

    stmt = select(RoomInvite).where(
        RoomInvite.room_id == room_id
    ).order_by(RoomInvite.created_at.desc())
    result = await db.execute(stmt)
    invites = result.scalars().all()
    return {"invites": [inv.to_dict() for inv in invites]}


@router.delete("/api/v1/rooms/{room_id}/invites/{token}")
async def revoke_room_invite(
    room_id: str,
    token: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Revoke an invite link. Owner only.

    Revocation sets ``revoked_at`` — the row and its redemption audit trail
    are never physically deleted. Pending redemptions cascade to 'revoked' in
    the same transaction. A single-use invite that was already consumed keeps
    its audit record and returns 409.
    """
    await require_role(room_id, current_user, db, min_role="owner")

    invite = await db.get(RoomInvite, token)
    if invite is None or invite.room_id != room_id:
        raise HTTPException(status_code=404, detail="Invite token not found")

    if invite.revoked_at is not None:
        raise HTTPException(status_code=409, detail="Invite already revoked")

    # Preserve the pre-m1 audit semantic: a consumed single-use invite may not
    # be revoked (the redemption is the record of use). Multi-use invites with
    # remaining capacity CAN be revoked — that is their point.
    if invite.max_uses <= 1 and ((invite.use_count or 0) > 0 or invite.used_at is not None):
        raise HTTPException(status_code=409, detail="Invite already redeemed")

    now = datetime.now(timezone.utc)
    invite.revoked_at = now
    await db.execute(
        update(RoomInviteRedemption)
        .where(
            RoomInviteRedemption.token == token,
            RoomInviteRedemption.status == "pending",
        )
        .values(status="revoked", decided_at=now, deny_reason="invite_revoked")
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    return {"ok": True, "revoked_at": now.isoformat()}


@router.get("/api/v1/invites/{token}")
async def get_invite_info(
    token: str,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Public read endpoint to check invite status (multi-use semantics)."""
    invite = await _get_invite_or_404(db, token)

    now = datetime.now(timezone.utc)
    if invite.revoked_at is not None:
        raise HTTPException(status_code=410, detail="Invite token revoked")
    if _as_utc(invite.expires_at) <= now:
        raise HTTPException(status_code=410, detail="Invite token expired")

    max_uses = invite.max_uses or 1
    use_count = invite.use_count or 0
    if max_uses == 1 and invite.used_at is not None and use_count == 0:
        use_count = 1
    return {
        "token": invite.token,
        "room_id": invite.room_id,
        "proposed_scopes": invite.proposed_scopes or [],
        "expires_at": invite.expires_at.isoformat(),
        "max_uses": max_uses,
        "use_count": use_count,
        "remaining_uses": max(max_uses - use_count, 0),
        "requires_approval": bool(invite.requires_approval),
        "role": invite.role,
        "revoked_at": invite.revoked_at.isoformat() if invite.revoked_at else None,
    }


@router.post("/api/v1/invites/nonce", status_code=201)
async def issue_signature_nonce(
    payload: NonceRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Issue a single-use EIP-191 challenge bound to action+resource+address.

    The returned ``message`` is the exact text the wallet must sign; the
    protected endpoint rebuilds it from the stored row at verify time.
    Abuse is bounded per (action, address) inside ``issue_nonce`` — the
    global auth rate limiter is deliberately not reused: its 5-per-5-min
    quota would lock out legitimate concurrent redemptions.
    """
    nonce, message, expires_at = await issue_nonce(
        db, action=payload.action, resource=payload.resource, address=payload.address
    )
    await db.commit()
    return {"nonce": nonce, "message": message, "expires_at": expires_at.isoformat()}


@router.post("/api/v1/invites/{token}/accept")
async def accept_room_invite(
    token: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Grant authenticated user access to the invited room.

    On a requires_approval invite this does NOT grant membership — it files a
    pending human redemption so the approval gate cannot be bypassed through
    /accept. Approval grants the invite's role (member|viewer).
    """
    invite = await _get_invite_or_404(db, token)

    now = datetime.now(timezone.utc)
    if _as_utc(invite.expires_at) < now:
        raise HTTPException(status_code=410, detail="Invite token expired")
    if invite.revoked_at is not None:
        raise HTTPException(status_code=410, detail="Invite token revoked")

    existing_perm = await get_room_permission(invite.room_id, current_user, db)
    if existing_perm is not None:
        room = await db.get(Room, invite.room_id)
        if room is None or not room.is_active:
            raise HTTPException(status_code=404, detail="Room not found")
        return {"room_id": invite.room_id, "role": existing_perm.role}

    if invite.requires_approval:
        existing_redemption = await _find_redemption(
            db, token, user_id=current_user.id
        )
        if existing_redemption is not None:
            if existing_redemption.status == "pending":
                return {"status": "pending", "redemption_id": existing_redemption.id}
            if existing_redemption.status in ("denied", "revoked"):
                raise HTTPException(status_code=409, detail="Redemption request was denied")
            if existing_redemption.status == "expired":
                raise HTTPException(status_code=410, detail="Redemption request expired")
            raise HTTPException(status_code=409, detail="Redemption already decided")
        await _pending_redemption_guard(db, token)
        redemption = RoomInviteRedemption(
            id=str(uuid.uuid4()),
            token=token,
            kind="human",
            status="pending",
            redeemer_user_id=current_user.id,
            expires_at=min(_as_utc(invite.expires_at), now + PENDING_REDEMPTION_TTL),
        )
        db.add(redemption)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            existing_redemption = await _find_redemption(
                db, token, user_id=current_user.id
            )
            if existing_redemption is not None and existing_redemption.status == "pending":
                return {"status": "pending", "redemption_id": existing_redemption.id}
            raise HTTPException(status_code=409, detail="Redemption already exists") from None
        return {"status": "pending", "redemption_id": redemption.id}

    if not await _consume_invite_use(db, token):
        fresh = await db.get(RoomInvite, token)
        if fresh is None:
            raise HTTPException(status_code=404, detail="Invite token not found")
        if fresh.revoked_at is not None:
            raise HTTPException(status_code=410, detail="Invite token revoked")
        if _as_utc(fresh.expires_at) <= now:
            raise HTTPException(status_code=410, detail="Invite token expired")
        raise HTTPException(status_code=409, detail="Invite token already redeemed")

    room = await db.get(Room, invite.room_id)
    if room is None or not room.is_active:
        await db.rollback()
        raise HTTPException(status_code=404, detail="Room not found")

    perm = RoomPermission(
        room_id=invite.room_id,
        user_id=current_user.id,
        role=invite.role if invite.role in ("member", "viewer") else "member",
        invited_by=invite.created_by,
    )
    db.add(perm)
    try:
        db.add(RoomInviteRedemption(
            id=str(uuid.uuid4()),
            token=token,
            kind="human",
            status="consumed",
            redeemer_user_id=current_user.id,
            redeemer_address=perm.xmtp_address,
            decided_at=now,
        ))
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing_perm = await get_room_permission(invite.room_id, current_user, db)
        if existing_perm is None:
            raise HTTPException(status_code=409, detail="Invite acceptance conflict") from None
        return {"room_id": invite.room_id, "role": existing_perm.role}

    return {"room_id": invite.room_id, "role": perm.role}


@router.post("/api/v1/invites/{token}/redeem")
async def redeem_room_invite(
    token: str,
    payload: RedeemInviteRequest,
    db: AsyncSession = Depends(get_db),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict:
    """Redeem an invite for an XMTP address (EIP-191 proof required).

    Multi-use invites consume one slot per successful redemption; pending
    redemptions on a requires_approval invite consume nothing until the owner
    approves.
    """
    normalized_address = normalize_address(payload.xmtp_address)
    await require_signed_nonce(
        db,
        action=ACTION_INVITE_REDEEM,
        resource=token,
        address=normalized_address,
        nonce=payload.nonce,
        signature=payload.signature,
    )

    invite = await _get_invite_or_404(db, token)
    now = datetime.now(timezone.utc)
    expires_at_utc = _as_utc(invite.expires_at)
    room_id = invite.room_id
    proposed_scopes = list(invite.proposed_scopes or [])
    human_user = await _optional_human_user(credentials, db)
    kind = "human" if human_user is not None else "agent"

    existing = await _find_redemption(db, token, address=normalized_address)
    if existing is not None:
        if existing.status == "consumed":
            room = await db.get(Room, room_id)
            if room is None or not room.is_active:
                raise HTTPException(status_code=404, detail="Room not found")
            if human_user is not None:
                try:
                    await _ensure_member_permission(
                        db, room_id, human_user, invite.created_by,
                        role=invite.role, xmtp_address=normalized_address,
                    )
                except IntegrityError:
                    await db.rollback()
            await db.commit()  # persist the consumed nonce on every success path
            return {
                "room_id": room_id,
                "xmtp_group_id": room.xmtp_group_id,
                "proposed_scopes": proposed_scopes,
                "redeemed_at": _as_utc(existing.decided_at or existing.created_at).isoformat(),
                "redemption_id": existing.id,
                "status": "consumed",
            }
        if existing.status == "pending":
            await db.commit()  # the consumed nonce above must survive
            return {"status": "pending", "redemption_id": existing.id}
        if existing.status == "approved":
            await db.commit()
            return {"status": "approved", "redemption_id": existing.id}
        if existing.status in ("denied", "revoked"):
            raise HTTPException(status_code=409, detail="Redemption request was denied")
        raise HTTPException(status_code=410, detail="Redemption request expired")

    # A human who already paid capacity through /accept only needs to bind the
    # verified address to their redemption — no second slot is consumed.
    human_prior = (
        await _find_redemption(db, token, user_id=human_user.id)
        if human_user is not None
        else None
    )
    if human_prior is not None and human_prior.status == "consumed":
        room = await db.get(Room, room_id)
        if room is None or not room.is_active:
            raise HTTPException(status_code=404, detail="Room not found")
        if human_prior.redeemer_address is None:
            human_prior.redeemer_address = normalized_address
        await _ensure_member_permission(
            db, room_id, human_user, invite.created_by,
            role=invite.role, xmtp_address=normalized_address,
        )
        await _touch_legacy_redeem_fields(db, token, normalized_address, now)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(status_code=409, detail="Address already bound elsewhere") from None
        return {
            "room_id": room_id,
            "xmtp_group_id": room.xmtp_group_id,
            "proposed_scopes": proposed_scopes,
            "redeemed_at": _as_utc(human_prior.decided_at or human_prior.created_at).isoformat(),
            "redemption_id": human_prior.id,
            "status": "consumed",
        }

    if invite.requires_approval:
        if invite.revoked_at is not None:
            raise HTTPException(status_code=410, detail="Invite token revoked")
        if _as_utc(invite.expires_at) <= now:
            raise HTTPException(status_code=410, detail="Invite token expired")
        if human_prior is not None and human_prior.status == "pending":
            # Attach the now-verified address to the pending request instead
            # of filing a duplicate keyed by address.
            if human_prior.redeemer_address is None:
                human_prior.redeemer_address = normalized_address
                try:
                    await db.commit()
                except IntegrityError:
                    await db.rollback()
                    raise HTTPException(status_code=409, detail="Address already bound elsewhere") from None
            else:
                await db.commit()
            return {"status": "pending", "redemption_id": human_prior.id}
        await _pending_redemption_guard(db, token)
        redemption = RoomInviteRedemption(
            id=str(uuid.uuid4()),
            token=token,
            kind=kind,
            status="pending",
            redeemer_user_id=human_user.id if human_user else None,
            redeemer_address=normalized_address,
            expires_at=min(expires_at_utc, now + PENDING_REDEMPTION_TTL),
        )
        db.add(redemption)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            existing_pending = await _find_redemption(db, token, address=normalized_address)
            if existing_pending is None and human_user is not None:
                existing_pending = await _find_redemption(db, token, user_id=human_user.id)
            if existing_pending is not None and existing_pending.status == "pending":
                return {"status": "pending", "redemption_id": existing_pending.id}
            raise HTTPException(status_code=409, detail="Pending redemption conflict") from None
        return {"status": "pending", "redemption_id": redemption.id}

    if not await _consume_invite_use(db, token):
        await db.rollback()
        fresh = await db.get(RoomInvite, token)
        if fresh is None:
            raise HTTPException(status_code=404, detail="Invite token not found")
        if fresh.revoked_at is not None:
            raise HTTPException(status_code=410, detail="Invite token revoked")
        if _as_utc(fresh.expires_at) <= now:
            raise HTTPException(status_code=410, detail="Invite token expired")
        raise HTTPException(status_code=409, detail="Invite token already redeemed")

    room = await db.get(Room, room_id)
    if room is None or not room.is_active:
        await db.rollback()
        raise HTTPException(status_code=404, detail="Room not found")

    redemption = RoomInviteRedemption(
        id=str(uuid.uuid4()),
        token=token,
        kind=kind,
        status="consumed",
        redeemer_user_id=human_user.id if human_user else None,
        redeemer_address=normalized_address,
        approved_scopes=proposed_scopes,
        decided_at=now,
    )
    db.add(redemption)
    if human_user is not None:
        await _ensure_member_permission(
            db, room_id, human_user, invite.created_by,
            role=invite.role, xmtp_address=normalized_address,
        )
    await _touch_legacy_redeem_fields(db, token, normalized_address, now)
    try:
        await db.commit()
    except IntegrityError:
        # Lost the (token, address) race to a concurrent redemption — answer
        # with whatever the winner recorded instead of a 500.
        await db.rollback()
        winner = await _find_redemption(db, token, address=normalized_address)
        if winner is not None and winner.status == "consumed":
            return {
                "room_id": room_id,
                "xmtp_group_id": room.xmtp_group_id,
                "proposed_scopes": proposed_scopes,
                "redeemed_at": _as_utc(winner.decided_at or winner.created_at).isoformat(),
                "redemption_id": winner.id,
                "status": "consumed",
            }
        raise HTTPException(status_code=409, detail="Invite redemption conflict") from None

    return {
        "room_id": room_id,
        "xmtp_group_id": room.xmtp_group_id,
        "proposed_scopes": proposed_scopes,
        "redeemed_at": now.isoformat(),
        "redemption_id": redemption.id,
        "status": "consumed",
    }


# ── cloud agent self-registration (WP6) ──

def _redemption_public(redemption: RoomInviteRedemption, *, agent_token: Optional[str] = None,
                       seat: Optional[AgentSeat] = None, room: Optional[Room] = None) -> dict:
    out = {
        "status": redemption.status,
        "redemption_id": redemption.id,
        "approved_scopes": redemption.approved_scopes,
    }
    if redemption.deny_reason:
        out["deny_reason"] = redemption.deny_reason
    if agent_token is not None:
        out["agent_token"] = agent_token
    if seat is not None:
        out["seat_id"] = seat.id
        out["room_id"] = seat.room_id
    if room is not None:
        out["room_id"] = room.id
        out["xmtp_group_id"] = room.xmtp_group_id
    if redemption.agent_user_id:
        out["agent_user_id"] = redemption.agent_user_id
    return out


async def _deliver_or_raise(
    db: AsyncSession, invite: RoomInvite, redemption: RoomInviteRedemption
) -> dict:
    """Map an existing redemption to the agent-register response."""
    status = redemption.status
    if status == "pending":
        if redemption.expires_at and _as_utc(redemption.expires_at) <= datetime.now(timezone.utc):
            redemption.status = "expired"
            await db.commit()
            raise HTTPException(status_code=410, detail="Redemption request expired")
        await db.commit()  # persist the consumed nonce
        return {"status": "pending", "redemption_id": redemption.id}
    if status == "denied":
        raise HTTPException(status_code=409, detail="Redemption request was denied")
    if status == "revoked":
        raise HTTPException(status_code=410, detail="Invite token revoked")
    if status == "expired":
        raise HTTPException(status_code=410, detail="Redemption request expired")
    # approved | consumed → the seat must still be live
    seat = await db.get(AgentSeat, redemption.seat_id) if redemption.seat_id else None
    if seat is not None and seat.removed_at is not None:
        raise HTTPException(status_code=409, detail="Registration revoked")
    if status == "approved":
        redemption.status = "consumed"
        redemption.decided_at = redemption.decided_at or datetime.now(timezone.utc)
    room = await db.get(Room, invite.room_id)
    await db.commit()
    return _redemption_public(
        redemption,
        agent_token=create_access_token(redemption.agent_user_id, "agent"),
        seat=seat,
        room=room,
    )


async def _agent_register(
    db: AsyncSession,
    token: str,
    address: str,
    display_name: Optional[str],
) -> dict:
    invite = await _get_invite_or_404(db, token)
    now = datetime.now(timezone.utc)

    existing = await _find_redemption(db, token, address=address)
    if existing is not None:
        return await _deliver_or_raise(db, invite, existing)

    state = _invite_state(invite, now)
    if state == "revoked":
        raise HTTPException(status_code=410, detail="Invite token revoked")
    if state == "expired":
        raise HTTPException(status_code=410, detail="Invite token expired")

    if invite.requires_approval:
        await _pending_redemption_guard(db, token)
        redemption = RoomInviteRedemption(
            id=str(uuid.uuid4()),
            token=token,
            kind="agent",
            status="pending",
            redeemer_address=address,
            expires_at=min(_as_utc(invite.expires_at), now + PENDING_REDEMPTION_TTL),
        )
        db.add(redemption)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            existing = await _find_redemption(db, token, address=address)
            if existing is not None:
                return await _deliver_or_raise(db, invite, existing)
            raise
        return {"status": "pending", "redemption_id": redemption.id}

    if not await _consume_invite_use(db, token):
        await db.rollback()
        fresh = await db.get(RoomInvite, token)
        if fresh is None:
            raise HTTPException(status_code=404, detail="Invite token not found")
        if fresh.revoked_at is not None:
            raise HTTPException(status_code=410, detail="Invite token revoked")
        if _as_utc(fresh.expires_at) <= now:
            raise HTTPException(status_code=410, detail="Invite token expired")
        raise HTTPException(status_code=409, detail="Invite token exhausted")

    redemption = RoomInviteRedemption(
        id=str(uuid.uuid4()),
        token=token,
        kind="agent",
        status="consumed",
        redeemer_address=address,
        approved_scopes=list(invite.proposed_scopes or []),
        decided_at=now,
    )
    db.add(redemption)
    await db.flush()
    seat = await _grant_agent_seat(
        db, invite=invite, redemption=redemption,
        approved_scopes=redemption.approved_scopes, display_name=display_name,
    )
    await _touch_legacy_redeem_fields(db, token, address, now)
    room = await db.get(Room, invite.room_id)
    try:
        await db.commit()
    except IntegrityError:
        # Lost the (token, address) race; replay the winner's outcome.
        await db.rollback()
        winner = await _find_redemption(db, token, address=address)
        if winner is not None:
            return await _deliver_or_raise(db, invite, winner)
        raise HTTPException(status_code=409, detail="Agent registration conflict") from None
    return _redemption_public(
        redemption,
        agent_token=create_access_token(redemption.agent_user_id, "agent"),
        seat=seat,
        room=room,
    )


@router.post("/api/v1/invites/{token}/agent-register")
async def agent_register(
    token: str,
    payload: AgentRegisterRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Cloud agent self-registration through a signed invite redemption."""
    normalized_address = normalize_address(payload.xmtp_address)
    await require_signed_nonce(
        db,
        action=ACTION_AGENT_REGISTER,
        resource=token,
        address=normalized_address,
        nonce=payload.nonce,
        signature=payload.signature,
    )
    return await _agent_register(db, token, normalized_address, payload.display_name)


@router.get("/api/v1/invites/{token}/agent-register")
async def agent_register_status(
    token: str,
    address: Optional[str] = Query(default=None, min_length=42, max_length=42),
    nonce: Optional[str] = Query(default=None, min_length=1, max_length=128),
    signature: Optional[str] = Query(default=None, min_length=10, max_length=200),
    x_mapr_address: Optional[str] = Header(default=None, alias="X-MAPR-Address"),
    x_mapr_nonce: Optional[str] = Header(default=None, alias="X-MAPR-Nonce"),
    x_mapr_signature: Optional[str] = Header(default=None, alias="X-MAPR-Signature"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Poll a pending registration; delivers the first agent_token on approval.

    Signed like the POST — accepts X-MAPR-Address / X-MAPR-Nonce /
    X-MAPR-Signature headers (preferred so proofs stay out of URL logs) or
    query parameters for backward compatibility.
    """
    raw_address = x_mapr_address if x_mapr_address is not None else address
    raw_nonce = x_mapr_nonce if x_mapr_nonce is not None else nonce
    raw_signature = x_mapr_signature if x_mapr_signature is not None else signature
    if not raw_address or not raw_nonce or len(raw_nonce) > 128 or not raw_signature or len(raw_signature) < 10 or len(raw_signature) > 200:
        raise HTTPException(status_code=422, detail="Missing or malformed signed proof")
    normalized_address = normalize_address(raw_address)
    await require_signed_nonce(
        db,
        action=ACTION_AGENT_REGISTER,
        resource=token,
        address=normalized_address,
        nonce=raw_nonce,
        signature=raw_signature,
    )
    return await _agent_register(db, token, normalized_address, None)


# ── owner approval queue ──

@router.get("/api/v1/rooms/{room_id}/redemptions")
async def list_redemptions(
    room_id: str,
    status: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Owner views the redemption queue (default all; ?status=pending etc.)."""
    await require_role(room_id, current_user, db, min_role="owner")
    stmt = (
        select(RoomInviteRedemption)
        .join(RoomInvite, RoomInviteRedemption.token == RoomInvite.token)
        .where(RoomInvite.room_id == room_id)
        .order_by(RoomInviteRedemption.created_at.desc())
    )
    if status:
        stmt = stmt.where(RoomInviteRedemption.status == status)
    rows = (await db.execute(stmt)).scalars().all()
    return {"redemptions": [r.to_dict() for r in rows]}


@router.post("/api/v1/rooms/{room_id}/redemptions/{redemption_id}/approve")
async def approve_redemption(
    room_id: str,
    redemption_id: str,
    payload: ApproveRedemptionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Approve one pending redemption.

    Consumes invite capacity atomically and flips redemption status via a
    conditional UPDATE (WHERE status='pending' AND unexpired) so concurrent
    approve/deny/revoke races can neither burn orphan slots nor overwrite a
    terminal decision.
    """
    await require_role(room_id, current_user, db, min_role="owner")

    redemption = await db.get(RoomInviteRedemption, redemption_id)
    if redemption is None:
        raise HTTPException(status_code=404, detail="Redemption not found")
    invite = await db.get(RoomInvite, redemption.token)
    if invite is None or invite.room_id != room_id:
        raise HTTPException(status_code=404, detail="Redemption not found")
    if redemption.status != "pending":
        raise HTTPException(status_code=409, detail="Redemption already decided")

    now = datetime.now(timezone.utc)
    if redemption.expires_at is not None and _as_utc(redemption.expires_at) <= now:
        await db.execute(
            update(RoomInviteRedemption)
            .where(
                RoomInviteRedemption.id == redemption_id,
                RoomInviteRedemption.status == "pending",
            )
            .values(status="expired", decided_at=now)
            .execution_options(synchronize_session=False)
        )
        await db.commit()
        raise HTTPException(status_code=410, detail="Redemption request expired")

    scopes = (
        list(invite.proposed_scopes or [])
        if payload.approved_scopes is None
        else validate_scope_list(payload.approved_scopes, field="approved_scopes")
    )
    _scopes_within(scopes, invite.proposed_scopes or [])
    invite_token = invite.token

    # For human redemptions, a dead redeemer should not burn a capacity slot —
    # conditionally flip pending -> denied before touching invite capacity.
    human_grantee = None
    if redemption.kind == "human":
        human_grantee = (
            await db.get(User, redemption.redeemer_user_id)
            if redemption.redeemer_user_id
            else None
        )
        if human_grantee is None or not human_grantee.is_active:
            unavailable = await db.execute(
                update(RoomInviteRedemption)
                .where(
                    RoomInviteRedemption.id == redemption_id,
                    RoomInviteRedemption.status == "pending",
                )
                .values(
                    status="denied",
                    deny_reason="redeemer_unavailable",
                    decided_by=current_user.id,
                    decided_at=now,
                )
                .execution_options(synchronize_session=False)
            )
            if unavailable.rowcount != 1:
                await db.rollback()
                raise HTTPException(status_code=409, detail="Redemption already decided")
            await db.commit()
            raise HTTPException(status_code=409, detail="Redeemer account unavailable")

    # Lock room_invites BEFORE room_invite_redemptions (matches revoke order).
    if not await _consume_invite_use(db, invite_token):
        closed = await db.execute(
            update(RoomInviteRedemption)
            .where(
                RoomInviteRedemption.id == redemption_id,
                RoomInviteRedemption.status == "pending",
            )
            .values(
                status="denied",
                deny_reason="invite_closed",
                decided_by=current_user.id,
                decided_at=now,
            )
            .execution_options(synchronize_session=False)
        )
        if closed.rowcount != 1:
            await db.rollback()
            raise HTTPException(status_code=409, detail="Redemption already decided")
        await db.commit()
        raise HTTPException(status_code=409, detail="Invite has no remaining capacity")

    target_status = "consumed" if redemption.kind == "human" else "approved"
    claimed = await db.execute(
        update(RoomInviteRedemption)
        .where(
            RoomInviteRedemption.id == redemption_id,
            RoomInviteRedemption.status == "pending",
            or_(
                RoomInviteRedemption.expires_at.is_(None),
                RoomInviteRedemption.expires_at > now,
            ),
        )
        .values(
            status=target_status,
            decided_by=current_user.id,
            decided_at=now,
            approved_scopes=scopes,
        )
        .execution_options(synchronize_session=False)
    )
    if claimed.rowcount != 1:
        # Roll back the capacity consumption above atomically.
        await db.rollback()
        fresh = await db.get(RoomInviteRedemption, redemption_id, populate_existing=True)
        if (
            fresh is not None
            and fresh.status == "pending"
            and fresh.expires_at is not None
            and _as_utc(fresh.expires_at) <= now
        ):
            await db.execute(
                update(RoomInviteRedemption)
                .where(
                    RoomInviteRedemption.id == redemption_id,
                    RoomInviteRedemption.status == "pending",
                )
                .values(status="expired", decided_at=now)
                .execution_options(synchronize_session=False)
            )
            await db.commit()
            raise HTTPException(status_code=410, detail="Redemption request expired")
        raise HTTPException(status_code=409, detail="Redemption already decided")

    await db.refresh(redemption)
    if redemption.kind == "human":
        await _ensure_member_permission(
            db, invite.room_id, human_grantee, invite.created_by,
            role=invite.role, xmtp_address=redemption.redeemer_address,
        )
    else:
        await _grant_agent_seat(
            db, invite=invite, redemption=redemption,
            approved_scopes=scopes, display_name=payload.display_name,
        )
    if redemption.redeemer_address:
        await _touch_legacy_redeem_fields(db, invite_token, redemption.redeemer_address, now)
    await db.commit()
    await db.refresh(redemption)
    return {"redemption": redemption.to_dict()}


@router.post("/api/v1/rooms/{room_id}/redemptions/{redemption_id}/deny")
async def deny_redemption(
    room_id: str,
    redemption_id: str,
    payload: DenyRedemptionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Deny one pending redemption; the requester sees the denial on its next poll."""
    await require_role(room_id, current_user, db, min_role="owner")

    redemption = await db.get(RoomInviteRedemption, redemption_id)
    if redemption is None:
        raise HTTPException(status_code=404, detail="Redemption not found")
    invite = await db.get(RoomInvite, redemption.token)
    if invite is None or invite.room_id != room_id:
        raise HTTPException(status_code=404, detail="Redemption not found")
    if redemption.status != "pending":
        raise HTTPException(status_code=409, detail="Redemption already decided")

    now = datetime.now(timezone.utc)
    denied = await db.execute(
        update(RoomInviteRedemption)
        .where(
            RoomInviteRedemption.id == redemption_id,
            RoomInviteRedemption.status == "pending",
        )
        .values(
            status="denied",
            deny_reason=(payload.reason or "denied")[:64],
            decided_by=current_user.id,
            decided_at=now,
        )
        .execution_options(synchronize_session=False)
    )
    if denied.rowcount != 1:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Redemption already decided")
    await db.commit()
    await db.refresh(redemption)
    return {"redemption": redemption.to_dict()}
