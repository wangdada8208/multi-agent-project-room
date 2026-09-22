"""Room API: create and list rooms, backed by PostgreSQL."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.room import Room
from app.models.user import User
from app.models.room_permission import RoomPermission

router = APIRouter(prefix="/api/v1/rooms", tags=["rooms"])


class CreateRoomRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""


@router.get("")
async def list_rooms(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """List rooms the current user has permission to access."""
    # Get rooms where user has any permission
    perm_stmt = select(RoomPermission.room_id).where(
        RoomPermission.user_id == current_user.id
    )
    perm_result = await db.execute(perm_stmt)
    accessible_room_ids = [row[0] for row in perm_result.all()]

    if not accessible_room_ids:
        return {"rooms": []}

    result = await db.execute(
        select(Room).where(
            Room.is_active == True,
            Room.id.in_(accessible_room_ids),
        ).order_by(Room.created_at.desc())
    )
    rooms = result.scalars().all()
    return {"rooms": [r.to_dict() for r in rooms]}


@router.post("")
async def create_room(
    payload: CreateRoomRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    room = Room(
        name=payload.name,
        description=payload.description,
        created_by=current_user.id,
    )
    db.add(room)
    await db.flush()

    # Creator gets owner role
    perm = RoomPermission(
        room_id=room.id,
        user_id=current_user.id,
        role="owner",
    )
    db.add(perm)
    await db.commit()
    await db.refresh(room)
    return {"room": room.to_dict()}


@router.get("/{room_id}")
async def get_room(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    from app.chat.service import resolve_room
    room = await resolve_room(db, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return {"room": room.to_dict()}


class ShareLinkRequest(BaseModel):
    expires_hours: int = Field(default=72, ge=1, le=720)


import secrets as _secrets


@router.post("/{room_id}/share")
async def create_share_link(
    room_id: str,
    payload: ShareLinkRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Generate a shareable read-only link for a room."""
    from app.api.permissions import require_role

    await require_role(room_id, current_user, db, min_role="owner")

    room = await db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    # Generate a unique share token
    token = _secrets.token_urlsafe(32)
    from datetime import datetime, timedelta, timezone as tz
    expires_at = datetime.now(tz.utc) + timedelta(hours=payload.expires_hours)

    # Store the share token on the room (simple approach)
    room.description = f"{room.description or ''}".strip()
    db.add(room)

    from app.models.room_share import RoomShareToken
    share_token = RoomShareToken(
        room_id=room_id,
        token=token,
        created_by=current_user.id,
        expires_at=expires_at,
    )
    db.add(share_token)
    await db.commit()

    return {
        "share_url": f"/shared/{token}",
        "token": token,
        "expires_at": expires_at.isoformat(),
    }


@router.get("/shared/{token}/messages", include_in_schema=False)
async def get_shared_room_messages(
    token: str,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Public endpoint for shared room read access. No auth required."""
    from sqlalchemy import select
    from app.models.room_share import RoomShareToken
    from app.chat.models import Message
    from datetime import datetime, timezone

    stmt = select(RoomShareToken).where(
        RoomShareToken.token == token,
        RoomShareToken.expires_at > datetime.now(timezone.utc),
    )
    result = await db.execute(stmt)
    share = result.scalars().first()
    if share is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Share link expired or not found")

    from app.chat.service import list_messages
    messages = await list_messages(db, share.room_id, page=1, limit=100)
    room = await db.get(Room, share.room_id)
    return {
        "room_name": room.name if room else "Room",
        "messages": [m.to_dict() for m in messages],
    }


class XmtpBindingRequest(BaseModel):
    model_config = {"extra": "forbid"}
    xmtp_group_id: str = Field(min_length=1, max_length=128)


@router.post("/{room_id}/xmtp-binding")
async def bind_xmtp_group(
    room_id: str,
    payload: XmtpBindingRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    from app.api.permissions import require_role

    await require_role(room_id, current_user, db, min_role="member")

    room = await db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    room.transport = "xmtp"
    room.xmtp_group_id = payload.xmtp_group_id
    db.add(room)
    await db.commit()
    await db.refresh(room)
    return room.to_dict()

