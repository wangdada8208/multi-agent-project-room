from __future__ import annotations
"""Chat service: message persistence and retrieval."""

from datetime import datetime, timedelta, timezone
from typing import Literal

import logging
from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from app.chat.models import Message
from app.config import get_settings
from app.models.room import Room
from app.models.user import User

settings = get_settings()

MessageType = Literal[
    "text", "system", "task", "proposal", "report", "approval_request"
]


def retention_cutoff() -> datetime:
    """Messages older than this UTC timestamp are expired."""
    return datetime.now(timezone.utc) - timedelta(days=settings.message_retention_days)


async def cleanup_expired_messages(db: AsyncSession) -> int:
    """Delete messages older than the configured retention period with safe FK nullification."""
    try:
        cutoff = retention_cutoff()
        expired_subquery = select(Message.id).where(Message.created_at < cutoff)

        # 1. Nullify tasks referencing expired messages
        from app.a2a.models import A2ATask
        await db.execute(
            update(A2ATask)
            .where(A2ATask.source_message_id.in_(expired_subquery))
            .values(source_message_id=None)
        )

        # 2. Nullify replies referencing expired parent messages
        await db.execute(
            update(Message)
            .where(Message.parent_id.in_(expired_subquery))
            .values(parent_id=None)
        )

        stmt = (
            delete(Message)
            .where(Message.created_at < cutoff)
            .execution_options(synchronize_session=False)
        )
        result = await db.execute(stmt)
        await db.commit()
        return result.rowcount or 0
    except Exception as err:
        logger.warning("Failed to cleanup expired messages: %s", err)
        await db.rollback()
        return 0


async def save_message(
    db: AsyncSession,
    room_id: str,
    sender_id: str,
    sender_type: str = "human",
    sender_name: str | None = None,
    content: str = "",
    msg_type: MessageType = "text",
    parent_id: str | None = None,
) -> Message:
    """Persist a message and return it."""
    await cleanup_expired_messages(db)

    user = await db.get(User, sender_id)
    if user is None:
        display_name = sender_name or sender_id[:128]
        db.add(
            User(
                id=sender_id,
                username=sender_id[:64],
                display_name=display_name[:128],
                user_type=sender_type if sender_type in {"human", "agent"} else "human",
            )
        )
    elif sender_name:
        # Update display_name if provided
        user.display_name = sender_name[:128]

    await db.flush()

    message = Message(
        room_id=room_id,
        sender_id=sender_id,
        sender_type=sender_type,
        sender_name=sender_name,
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
    """Get retained messages for a room.

    Page 1 returns the newest retained messages, ordered oldest → newest for
    chat display. Older pages walk backward through history.
    """
    await cleanup_expired_messages(db)

    stmt = (
        select(Message)
        .where(
            Message.room_id == room_id,
            Message.created_at >= retention_cutoff(),
        )
        .order_by(Message.created_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(reversed(result.scalars().all()))


async def resolve_room(db: AsyncSession, identifier: str) -> Room | None:
    """Resolve a room by exact ID first, or fallback to exact name match."""
    room = await db.get(Room, identifier)
    if room:
        return room
    stmt = select(Room).where(Room.name == identifier, Room.is_active == True)
    result = await db.execute(stmt)
    return result.scalars().first()


async def get_or_create_room(
    db: AsyncSession,
    room_id: str,
    name: str = "Default Room",
    description: str = "",
) -> Room:
    """Get room by id or name, or create if not exists (for bootstrapping)."""
    room = await resolve_room(db, room_id)
    if room:
        return room
    # Agent channels are hidden from room listings
    is_agent_channel = room_id.startswith("_agent_")
    room = Room(
        id=room_id,
        name=name,
        description=description,
        is_active=not is_agent_channel,
    )
    db.add(room)
    await db.commit()
    await db.refresh(room)
    return room


async def delete_room_messages(db: AsyncSession, room_id: str) -> None:
    """Delete all messages in a room."""
    stmt = delete(Message).where(Message.room_id == room_id)
    await db.execute(stmt)
    await db.commit()
