"""Search API: full-text message search within a room."""
from __future__ import annotations
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.chat.models import Message
from app.models.user import User

router = APIRouter(prefix="/api/v1/rooms", tags=["search"])


@router.get("/{room_id}/messages/search")
async def search_messages(
    room_id: str,
    q: str = Query(min_length=1, max_length=256),
    limit: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Full-text search messages in a room."""
    from app.models.room import Room

    room = await db.get(Room, room_id)
    if room is not None and room.transport == "xmtp":
        return {
            "results": [],
            "reason": "body_not_on_hub",
            "query": q,
            "total": 0,
        }

    pattern = f"%{q}%"
    stmt = (
        select(Message)
        .where(
            Message.room_id == room_id,
            or_(
                Message.content.ilike(pattern),
                Message.sender_name.ilike(pattern),
            ),
        )
        .order_by(Message.created_at.desc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    messages = result.scalars().all()
    return {
        "results": [m.to_dict() for m in messages],
        "query": q,
        "total": len(messages),
    }
