"""Analytics API: track events and query stats."""
from __future__ import annotations
import json
from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.analytics import AnalyticsEvent
from app.models.user import User
from app.models.room import Room
from app.chat.models import Message
from app.models.agent_card import AgentCardRecord

router = APIRouter(prefix="/api/v1/analytics", tags=["analytics"])


class TrackEventRequest(BaseModel):
    event_type: str = Field(min_length=1, max_length=64)
    room_id: Optional[str] = None
    metadata: Optional[dict] = None


@router.post("/track")
async def track_event(
    payload: TrackEventRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Record a product analytics event."""
    event = AnalyticsEvent(
        event_type=payload.event_type,
        user_id=current_user.id,
        room_id=payload.room_id,
        metadata_json=json.dumps(payload.metadata) if payload.metadata else None,
    )
    db.add(event)
    await db.commit()
    return {"ok": True}


@router.get("/stats")
async def get_stats(
    days: int = Query(default=7, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Get aggregated product stats for a time period."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    total_rooms = (await db.execute(select(func.count(Room.id)).where(Room.is_active == True))).scalar() or 0
    total_users = (await db.execute(select(func.count(User.id)))).scalar() or 0
    total_messages = (await db.execute(select(func.count(Message.id)).where(Message.created_at >= cutoff))).scalar() or 0
    total_agents = (await db.execute(select(func.count(AgentCardRecord.id)))).scalar() or 0

    # Events by type in period
    event_rows = await db.execute(
        select(AnalyticsEvent.event_type, func.count(AnalyticsEvent.id))
        .where(AnalyticsEvent.created_at >= cutoff)
        .group_by(AnalyticsEvent.event_type)
    )
    events_by_type = {row[0]: row[1] for row in event_rows.all()}

    # Active users (distinct users who sent messages in period)
    active_users_result = await db.execute(
        select(func.count(func.distinct(Message.sender_id)))
        .where(Message.created_at >= cutoff, Message.sender_type == "human")
    )
    active_users = active_users_result.scalar() or 0

    return {
        "period_days": days,
        "total_rooms": total_rooms,
        "total_users": total_users,
        "total_messages": total_messages,
        "total_agents": total_agents,
        "active_users": active_users,
        "events_by_type": events_by_type,
    }
