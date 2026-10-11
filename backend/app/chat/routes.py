"""Chat REST API: message history and room listing."""

from datetime import datetime
from sqlalchemy import select
from app.chat.models import Message
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.core.security import get_current_user
from app.api.permissions import require_role
from app.chat import service as chat_service
from app.models.room import Room
from app.models.user import User

router = APIRouter(prefix="/api/v1/rooms", tags=["chat"])


@router.get("/{room_id}/messages")
async def list_messages(
    room_id: str,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    after_seq: int | None = Query(None, ge=0, le=2**63 - 1),
    after: str | None = Query(None, max_length=64),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Get paginated messages for a room (newest last)."""
    room = await chat_service.resolve_room(db, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    await require_role(room.id, current_user, db, min_role="viewer")

    if not room.is_active:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.transport == "xmtp":
        return {"messages": [], "next_cursor": after_seq or 0, "has_more": False,
                "retention_days": chat_service.settings.message_retention_days}
    if after is not None:
        try:
            parsed = datetime.fromisoformat(after.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError()
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid after timestamp") from None
    if after_seq is not None:
        if after_seq > room.message_seq:
            raise HTTPException(status_code=400, detail="Invalid message cursor")
        rows = list((await db.execute(select(Message).where(Message.room_id == room.id,
            Message.room_seq > after_seq, Message.created_at >= chat_service.retention_cutoff())
            .order_by(Message.room_seq).limit(limit + 1))).scalars())
        messages = rows[:limit]
        return {"messages": [m.to_dict() for m in messages],
                "next_cursor": messages[-1].room_seq if messages else after_seq,
                "has_more": len(rows) > limit, "retention_days": chat_service.settings.message_retention_days}
    # ISO is a conservative overlap snapshot, not a commit cursor: an arbitrarily
    # late transaction can have an old created_at. WS replay supplies all retained
    # messages for legacy clients; new clients paginate with after_seq.
    messages = await chat_service.list_messages(db, room.id, page=page, limit=limit)
    return {
        "messages": [m.to_dict() for m in messages],
        "replay_mode": "legacy_snapshot" if after is not None else "history",
        "next_cursor": max((m.room_seq for m in messages), default=0),
        "retention_days": chat_service.settings.message_retention_days,
    }
