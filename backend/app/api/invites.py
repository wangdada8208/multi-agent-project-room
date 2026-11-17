"""Room invite API: create and redeem agent invitation tokens."""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.permissions import get_room_permission, require_role
from app.core.database import get_db
from app.core.security import bearer_scheme, decode_access_token, get_current_user
from app.models.room import Room
from app.models.room_invite import RoomInvite
from app.models.room_permission import RoomPermission
from app.models.user import User

router = APIRouter(tags=["invites"])

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


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
) -> RoomPermission:
    existing = await get_room_permission(room_id, user, db)
    if existing is not None:
        return existing
    perm = RoomPermission(
        room_id=room_id,
        user_id=user.id,
        role="member",
        invited_by=invited_by,
    )
    db.add(perm)
    await db.flush()
    return perm


class CreateInviteRequest(BaseModel):
    proposed_scopes: List[str] = Field(default_factory=list)
    expires_hours: int = Field(default=24, ge=1, le=720)


class RedeemInviteRequest(BaseModel):
    xmtp_address: str = Field(min_length=42, max_length=42)


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

    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=payload.expires_hours)

    invite = RoomInvite(
        token=token,
        room_id=room_id,
        created_by=current_user.id,
        proposed_scopes=payload.proposed_scopes,
        expires_at=expires_at,
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


@router.get("/api/v1/invites/{token}")
async def get_invite_info(
    token: str,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Public read endpoint to check invite status."""
    invite = await db.get(RoomInvite, token)
    if invite is None:
        raise HTTPException(status_code=404, detail="Invite token not found")

    now = datetime.now(timezone.utc)
    if _as_utc(invite.expires_at) < now:
        raise HTTPException(status_code=410, detail="Invite token expired")
    if invite.used_at is not None:
        raise HTTPException(status_code=409, detail="Invite token already redeemed")

    return {
        "token": invite.token,
        "room_id": invite.room_id,
        "proposed_scopes": invite.proposed_scopes or [],
        "expires_at": invite.expires_at.isoformat(),
    }


@router.post("/api/v1/invites/{token}/accept")
async def accept_room_invite(
    token: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Grant authenticated user member access to the invited room without consuming XMTP redeem."""
    invite = await db.get(RoomInvite, token)
    if invite is None:
        raise HTTPException(status_code=404, detail="Invite token not found")

    now = datetime.now(timezone.utc)
    if _as_utc(invite.expires_at) < now:
        raise HTTPException(status_code=410, detail="Invite token expired")

    existing_perm = await get_room_permission(invite.room_id, current_user, db)
    if existing_perm is not None:
        room = await db.get(Room, invite.room_id)
        if room is None or not room.is_active:
            raise HTTPException(status_code=404, detail="Room not found")
        return {"room_id": invite.room_id, "role": existing_perm.role}

    if invite.used_at is not None:
        raise HTTPException(status_code=409, detail="Invite token already redeemed")

    room = await db.get(Room, invite.room_id)
    if room is None or not room.is_active:
        raise HTTPException(status_code=404, detail="Room not found")

    perm = RoomPermission(
        room_id=invite.room_id,
        user_id=current_user.id,
        role="member",
        invited_by=invite.created_by,
    )
    db.add(perm)
    try:
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
    """Public endpoint: redeem invite token by submitting XMTP wallet address."""
    if not ADDRESS_RE.match(payload.xmtp_address):
        raise HTTPException(status_code=422, detail="Invalid Ethereum/XMTP address")

    normalized_address = payload.xmtp_address.lower()
    invite = await db.get(RoomInvite, token)
    if invite is None:
        raise HTTPException(status_code=404, detail="Invite token not found")

    now = datetime.now(timezone.utc)
    # Snapshot before the atomic claim: a rollback expires the ORM object and
    # lazy re-load is not safe to trigger on the error path.
    expires_at_utc = _as_utc(invite.expires_at)
    room_id = invite.room_id
    created_by = invite.created_by
    proposed_scopes = list(invite.proposed_scopes or [])
    # Single-use claim: only the first concurrent redeem wins this update.
    claim = await db.execute(
        update(RoomInvite)
        .where(
            RoomInvite.token == token,
            RoomInvite.used_at.is_(None),
            RoomInvite.expires_at > now,
        )
        .values(used_at=now, redeemed_by_address=normalized_address)
        # The WHERE is evaluated by the database, not against the loaded ORM
        # object: SQLite returns naive datetimes, which cannot be compared
        # with the tz-aware `now` in a session-synchronize pass.
        .execution_options(synchronize_session=False)
    )
    if claim.rowcount != 1:
        await db.rollback()
        if expires_at_utc < now:
            raise HTTPException(status_code=410, detail="Invite token expired")
        fresh = await db.get(RoomInvite, token)
        if fresh is None:
            raise HTTPException(status_code=404, detail="Invite token not found")
        if _as_utc(fresh.expires_at) < now:
            raise HTTPException(status_code=410, detail="Invite token expired")
        if (fresh.redeemed_by_address or "").lower() != normalized_address:
            raise HTTPException(status_code=409, detail="Invite token already redeemed")
        room = await db.get(Room, fresh.room_id)
        if room is None or not room.is_active:
            raise HTTPException(status_code=404, detail="Room not found")
        human_user = await _optional_human_user(credentials, db)
        if human_user is not None:
            try:
                await _ensure_member_permission(db, fresh.room_id, human_user, fresh.created_by)
                await db.commit()
            except IntegrityError:
                await db.rollback()
        redeemed_dt = _as_utc(fresh.used_at) if fresh.used_at else now
        return {
            "room_id": fresh.room_id,
            "xmtp_group_id": room.xmtp_group_id,
            "proposed_scopes": fresh.proposed_scopes or [],
            "redeemed_at": redeemed_dt.isoformat(),
        }

    room = await db.get(Room, room_id)
    if room is None or not room.is_active:
        await db.rollback()
        raise HTTPException(status_code=404, detail="Room not found")

    human_user = await _optional_human_user(credentials, db)
    if human_user is not None:
        await _ensure_member_permission(db, room_id, human_user, created_by)

    await db.commit()

    return {
        "room_id": room_id,
        "xmtp_group_id": room.xmtp_group_id,
        "proposed_scopes": proposed_scopes,
        "redeemed_at": now.isoformat(),
    }
