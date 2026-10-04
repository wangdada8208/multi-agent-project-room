"""Room invite API: create and redeem agent invitation tokens."""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.permissions import require_role
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.room import Room
from app.models.room_invite import RoomInvite
from app.models.user import User

router = APIRouter(tags=["invites"])

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


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


@router.post("/api/v1/invites/{token}/redeem")
async def redeem_room_invite(
    token: str,
    payload: RedeemInviteRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Public endpoint: redeem invite token by submitting XMTP wallet address."""
    if not ADDRESS_RE.match(payload.xmtp_address):
        raise HTTPException(status_code=422, detail="Invalid Ethereum/XMTP address")

    invite = await db.get(RoomInvite, token)
    if invite is None:
        raise HTTPException(status_code=404, detail="Invite token not found")

    now = datetime.now(timezone.utc)
    if _as_utc(invite.expires_at) < now:
        raise HTTPException(status_code=410, detail="Invite token expired")
    if invite.used_at is not None:
        raise HTTPException(status_code=409, detail="Invite token already redeemed")

    room = await db.get(Room, invite.room_id)
    if room is None or not room.is_active:
        raise HTTPException(status_code=404, detail="Room not found")

    invite.used_at = now
    invite.redeemed_by_address = payload.xmtp_address.lower()
    db.add(invite)
    await db.commit()

    return {
        "room_id": invite.room_id,
        "xmtp_group_id": room.xmtp_group_id,
        "proposed_scopes": invite.proposed_scopes or [],
        "redeemed_at": now.isoformat(),
    }
