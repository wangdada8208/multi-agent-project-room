"""Room API: create and list rooms, backed by PostgreSQL."""

from __future__ import annotations

from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.permissions import require_role
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.room import Room
from app.models.user import User
from app.models.room_permission import RoomPermission

router = APIRouter(prefix="/api/v1/rooms", tags=["rooms"])


class CreateRoomRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    transport: Literal["xmtp"] = "xmtp"


@router.get("")
async def list_rooms(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """List rooms the current user has permission to access."""
    # Get rooms where user has any permission
    perm_stmt = select(RoomPermission.room_id).where(
        RoomPermission.user_id == current_user.id,
        RoomPermission.role.in_(("viewer", "member", "owner")),
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
        transport=payload.transport,
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
    if room is None or not room.is_active:
        raise HTTPException(status_code=404, detail="Room not found")
    await require_role(room.id, current_user, db)
    return {"room": room.to_dict()}


@router.delete("/{room_id}")
async def deactivate_room(room_id: str, db: AsyncSession = Depends(get_db),
                          current_user: User = Depends(get_current_user)) -> dict:
    """Owner-only soft deletion; retain FK history, revoke all live subscriptions."""
    room = await db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    permission = (await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == room_id, RoomPermission.user_id == current_user.id))).scalar_one_or_none()
    if not permission or permission.role != "owner":
        raise HTTPException(status_code=403, detail="Requires owner role")
    room.is_active = False
    await db.commit()  # ORM hook queues room-only hint in this transaction.
    return {"ok": True}


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

    # End-to-end encrypted rooms have no body on the Hub, so a read-only share
    # link is meaningless there. Refuse it outright instead of handing out a
    # token that only ever resolves to an empty list: an entry point that must
    # never exist should not be creatable at all.
    if room.transport == "xmtp":
        raise HTTPException(
            status_code=409,
            detail="Encrypted rooms cannot be shared through a read-only link",
        )

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
        raise HTTPException(status_code=404, detail="Share link expired or not found")

    creator = await db.get(User, share.created_by)
    if creator is None or getattr(creator, "is_active", True) is False:
        raise HTTPException(status_code=404, detail="Share link expired or not found")

    creator_perm = (await db.execute(
        select(RoomPermission).where(
            RoomPermission.room_id == share.room_id,
            RoomPermission.user_id == share.created_by,
        )
    )).scalar_one_or_none()
    if not creator_perm or creator_perm.role not in ("owner", "member"):
        raise HTTPException(status_code=404, detail="Share link expired or not found")

    from app.chat.service import list_messages
    room = await db.get(Room, share.room_id)
    if room is None or not room.is_active:
        raise HTTPException(status_code=404, detail="Room not found")
    messages = [] if room.transport == "xmtp" else await list_messages(db, share.room_id, page=1, limit=100)
    return {
        "room_name": room.name if room else "Room",
        "messages": [m.to_dict() for m in messages],
    }


@router.delete("/{room_id}/share/{token}")
async def revoke_share_token(
    room_id: str,
    token: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    from app.api.permissions import require_role
    from app.models.room_share import RoomShareToken

    await require_role(room_id, current_user, db, min_role="owner")
    stmt = select(RoomShareToken).where(
        RoomShareToken.room_id == room_id,
        RoomShareToken.token == token,
    )
    share = (await db.execute(stmt)).scalar_one_or_none()
    if share is None:
        raise HTTPException(status_code=404, detail="Share token not found")
    await db.delete(share)
    await db.commit()
    return {"revoked": True, "token": token}


@router.delete("/{room_id}/share")
async def revoke_all_share_tokens(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    from app.api.permissions import require_role
    from app.models.room_share import RoomShareToken

    await require_role(room_id, current_user, db, min_role="owner")
    stmt = select(RoomShareToken).where(RoomShareToken.room_id == room_id)
    tokens = (await db.execute(stmt)).scalars().all()
    count = len(tokens)
    for t in tokens:
        await db.delete(t)
    await db.commit()
    return {"revoked": True, "count": count}


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

    await require_role(room_id, current_user, db, min_role="owner")

    room = await db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.transport != "xmtp":
        raise HTTPException(status_code=409, detail="Only xmtp rooms can be bound")
    if room.xmtp_group_id:
        if room.xmtp_group_id == payload.xmtp_group_id:
            return room.to_dict()
        raise HTTPException(status_code=409, detail="Room is already bound to another group")

    room.transport = "xmtp"
    room.xmtp_group_id = payload.xmtp_group_id
    db.add(room)
    await db.commit()
    await db.refresh(room)
    return room.to_dict()

