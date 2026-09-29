"""Room permission API: role-based access control."""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.models.user import User

router = APIRouter(prefix="/api/v1/rooms", tags=["permissions"])


class InviteRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    role: str = Field(default="member", pattern="^(owner|member|viewer)$")


class UpdateRoleRequest(BaseModel):
    user_id: str = Field(min_length=1)
    role: str = Field(pattern="^(owner|member|viewer)$")


async def get_room_permission(
    room_id: str,
    user: User,
    db: AsyncSession,
) -> RoomPermission | None:
    """Get the permission record for a user in a room."""
    stmt = select(RoomPermission).where(
        RoomPermission.room_id == room_id,
        RoomPermission.user_id == user.id,
    )
    result = await db.execute(stmt)
    return result.scalars().first()


async def require_role(room_id: str, user: User, db: AsyncSession, min_role: str = "viewer") -> RoomPermission:
    """Require at least the specified role in a room. Raises 403 if insufficient."""
    perm = await get_room_permission(room_id, user, db)
    hierarchy = {"viewer": 0, "member": 1, "owner": 2}
    if perm is None:
        raise HTTPException(status_code=403, detail="No access to this room")
    if hierarchy.get(perm.role, 0) < hierarchy.get(min_role, 0):
        raise HTTPException(status_code=403, detail=f"Requires {min_role} role")
    return perm


@router.get("/{room_id}/permissions")
async def list_permissions(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """List all members and their roles in a room."""
    await require_role(room_id, current_user, db, min_role="viewer")
    stmt = (
        select(RoomPermission, User)
        .join(User, RoomPermission.user_id == User.id)
        .where(RoomPermission.room_id == room_id)
    )
    result = await db.execute(stmt)
    members = []
    for perm, user in result.all():
        members.append({
            **perm.to_dict(),
            "username": user.username,
            "display_name": user.display_name,
            "avatar_url": user.avatar_url,
            "user_type": user.user_type,
        })
    return {"members": members}


@router.post("/{room_id}/invite")
async def invite_member(
    room_id: str,
    payload: InviteRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Invite a user to a room with a specific role."""
    await require_role(room_id, current_user, db, min_role="owner")

    # Find target user by username
    stmt = select(User).where(User.username == payload.username)
    result = await db.execute(stmt)
    target_user = result.scalars().first()
    if target_user is None:
        raise HTTPException(status_code=404, detail=f"User '{payload.username}' not found")

    # Check not already in room
    existing = await get_room_permission(room_id, target_user, db)
    if existing:
        raise HTTPException(status_code=409, detail="User already in room")

    perm = RoomPermission(
        room_id=room_id,
        user_id=target_user.id,
        role=payload.role,
        invited_by=current_user.id,
    )
    db.add(perm)
    await db.commit()
    await db.refresh(perm)
    return {"permission": perm.to_dict()}


@router.put("/{room_id}/role")
async def update_role(
    room_id: str,
    payload: UpdateRoleRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Update a member's role in a room."""
    await require_role(room_id, current_user, db, min_role="owner")

    stmt = select(RoomPermission).where(
        RoomPermission.room_id == room_id,
        RoomPermission.user_id == payload.user_id,
    )
    result = await db.execute(stmt)
    perm = result.scalars().first()
    if perm is None:
        raise HTTPException(status_code=404, detail="Member not found")

    perm.role = payload.role
    await db.commit()
    await db.refresh(perm)
    return {"permission": perm.to_dict()}


@router.delete("/{room_id}/members/{user_id}")
async def remove_member(
    room_id: str,
    user_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Remove a member from a room."""
    await require_role(room_id, current_user, db, min_role="owner")

    stmt = select(RoomPermission).where(
        RoomPermission.room_id == room_id,
        RoomPermission.user_id == user_id,
    )
    result = await db.execute(stmt)
    perm = result.scalars().first()
    if perm is None:
        raise HTTPException(status_code=404, detail="Member not found")

    if perm.role == "owner":
        # Count owners — must keep at least one
        owners_stmt = select(func.count(RoomPermission.id)).where(
            RoomPermission.room_id == room_id, RoomPermission.role == "owner"
        )
        owner_count = (await db.execute(owners_stmt)).scalar() or 0
        if owner_count <= 1:
            raise HTTPException(status_code=400, detail="Cannot remove the only owner")

    await db.delete(perm)
    await db.commit()
    return {"ok": True}
