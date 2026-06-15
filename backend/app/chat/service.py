from __future__ import annotations
"""Chat service: message persistence and retrieval."""

from typing import Literal

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.models import Message
from app.models.room import Room
from app.models.user import User


MessageType = Literal[
    "text", "system", "task", "proposal", "report", "approval_request"
]


async def save_message(
    db: AsyncSession,
    room_id: str,
    sender_id: str,
    sender_type: str = "human",
    content: str = "",
    msg_type: MessageType = "text",
    parent_id: str | None = None,
) -> Message:
    """Persist a message and return it."""
    user = await db.get(User, sender_id)
    if user is None:
        db.add(
            User(
                id=sender_id,
                username=sender_id[:64],
                display_name=sender_id[:128],
                user_type=sender_type if sender_type in {"human", "agent"} else "human",
            )
        )
        await db.flush()

    message = Message(
        room_id=room_id,
        sender_id=sender_id,
        sender_type=sender_type,
        content=content,
        msg_type=msg_type,
        parent_id=parent_id,
    )
    db.add(message)
    await db.commit()
    await db.refresh(message)
    return message


async def list_messages(
    db: AsyncSession,
    room_id: str,
    page: int = 1,
    limit: int = 50,
) -> list[Message]:
    """Get paginated messages for a room, newest last."""
    stmt = (
        select(Message)
        .where(Message.room_id == room_id)
        .order_by(Message.created_at.asc())
        .offset((page - 1) * limit)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_or_create_room(
    db: AsyncSession,
    room_id: str,
    name: str = "Default Room",
    description: str = "",
) -> Room:
    """Get room by id, or create if not exists (for bootstrapping)."""
    room = await db.get(Room, room_id)
    if room:
        return room
    room = Room(id=room_id, name=name, description=description)
    db.add(room)
    await db.commit()
    await db.refresh(room)
    return room


async def delete_room_messages(db: AsyncSession, room_id: str) -> None:
    """Delete all messages in a room."""
    stmt = delete(Message).where(Message.room_id == room_id)
    await db.execute(stmt)
    await db.commit()
