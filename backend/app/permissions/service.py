"""Room membership lookup and role policy."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.models.user import User


class PermissionDenied(Exception):
    """The current user cannot access a room or perform the requested action."""


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
    """Require at least the specified role in a room. Raises PermissionDenied if insufficient."""
    perm = await get_room_permission(room_id, user, db)
    hierarchy = {"viewer": 0, "member": 1, "owner": 2}
    room = await db.get(Room, room_id)
    if perm is None or perm.role not in hierarchy or not room or not room.is_active:
        raise PermissionDenied("No access to this room")
    if hierarchy.get(perm.role, 0) < hierarchy.get(min_role, 0):
        raise PermissionDenied(f"Requires {min_role} role")
    return perm
