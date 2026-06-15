"""Chat REST API: message history and room listing."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.chat import service as chat_service
from app.models.room import Room

router = APIRouter(prefix="/api/v1/rooms", tags=["chat"])


@router.get("/{room_id}/messages")
async def list_messages(
    room_id: str,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Get paginated messages for a room (newest last)."""
    room = await db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    messages = await chat_service.list_messages(db, room_id, page=page, limit=limit)
    return {"messages": [m.to_dict() for m in messages]}
