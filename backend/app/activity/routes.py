"""WP4/m2 activity HTTP API.

Endpoints
---------
* ``POST /api/v1/helpers/me/activity`` — helper token; safe-metadata event
  batch (<=100), idempotent on event ``id``.
* ``POST /api/v1/helpers/me/activity/checkpoints`` — helper token; EIP-191
  signed ledger-head anchors for rooms the helper's owner belongs to.
* ``POST /api/v1/rooms/{room_id}/activity`` — agent JWT; same batch for a
  cloud/agent seat in that room.
* ``POST /api/v1/rooms/{room_id}/activity/checkpoints`` — agent JWT; same
  anchors scoped to the path room.
* ``GET  /api/v1/rooms/{room_id}/activity`` — any member (viewer+); merged
  safe-metadata feed (m2 events + Hub task events + approvals + latest
  signed checkpoints per stream).
"""
from __future__ import annotations

from datetime import datetime
from functools import wraps
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.activity import service
from app.activity.schemas import (
    ActivityEventBatchIn,
    ActivityFeed,
    CheckpointBatchIn,
    IngestResult,
    MAX_LIMIT,
)
from app.core.database import get_db
from app.core.security import get_current_user
from app.helper.models import HelperDevice
from app.helper.routes import get_current_helper
from app.models.user import User

router = APIRouter(tags=["activity"])


def _database_errors(handler):
    """Do not expose SQL parameter values through the global handler."""
    @wraps(handler)
    async def guarded(*args, **kwargs):
        try:
            return await handler(*args, **kwargs)
        except SQLAlchemyError:
            try:
                await kwargs["db"].rollback()
            except SQLAlchemyError:
                pass
            raise HTTPException(503, "Activity storage temporarily unavailable") from None
    return guarded


async def _current_agent(user: User = Depends(get_current_user)) -> User:
    """Agent-JWT guard for the room-scoped ingest endpoints."""
    if user.user_type != "agent":
        raise HTTPException(403, "Agent account required")
    return user


# ── helper-reported ingest ──────────────────────────────────────────────

@router.post("/api/v1/helpers/me/activity", response_model=IngestResult, status_code=200)
@_database_errors
async def helper_report_activity(
    payload: ActivityEventBatchIn,
    db: AsyncSession = Depends(get_db),
    helper: HelperDevice = Depends(get_current_helper),
):
    accepted, duplicates = await service.ingest_events_for_helper(
        db, helper, payload.events
    )
    return IngestResult(accepted=accepted, duplicates=duplicates)


@router.post(
    "/api/v1/helpers/me/activity/checkpoints",
    response_model=IngestResult,
    status_code=200,
)
@_database_errors
async def helper_report_checkpoints(
    payload: CheckpointBatchIn,
    db: AsyncSession = Depends(get_db),
    helper: HelperDevice = Depends(get_current_helper),
):
    accepted, duplicates = await service.ingest_checkpoints_for_helper(
        db, helper, payload.checkpoints
    )
    return IngestResult(accepted=accepted, duplicates=duplicates)


# ── agent-reported ingest ───────────────────────────────────────────────

@router.post("/api/v1/rooms/{room_id}/activity", response_model=IngestResult, status_code=200)
@_database_errors
async def agent_report_activity(
    room_id: str,
    payload: ActivityEventBatchIn,
    db: AsyncSession = Depends(get_db),
    agent: User = Depends(_current_agent),
):
    accepted, duplicates = await service.ingest_events_for_agent(
        db, agent, room_id, payload.events
    )
    return IngestResult(accepted=accepted, duplicates=duplicates)


@router.post(
    "/api/v1/rooms/{room_id}/activity/checkpoints",
    response_model=IngestResult,
    status_code=200,
)
@_database_errors
async def agent_report_checkpoints(
    room_id: str,
    payload: CheckpointBatchIn,
    db: AsyncSession = Depends(get_db),
    agent: User = Depends(_current_agent),
):
    accepted, duplicates = await service.ingest_checkpoints_for_agent(
        db, agent, room_id, payload.checkpoints
    )
    return IngestResult(accepted=accepted, duplicates=duplicates)


# ── merged member read ──────────────────────────────────────────────────

@router.get("/api/v1/rooms/{room_id}/activity", response_model=ActivityFeed)
@_database_errors
async def room_activity_feed(
    room_id: str,
    actor: Optional[str] = Query(default=None, max_length=128),
    app: Optional[str] = Query(default=None, max_length=32),
    kind: Optional[str] = Query(default=None, max_length=200),
    status: Optional[str] = Query(default=None, max_length=200),
    since: Optional[datetime] = Query(default=None),
    until: Optional[datetime] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=MAX_LIMIT),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Merged safe-metadata feed. For ``transport="xmtp"`` rooms the output
    carries zero title/description/query/payload — encrypted-room content
    never enters the Hub activity stream."""
    return await service.merged_activity_feed(
        db,
        user,
        room_id,
        actor=actor,
        app=app,
        kinds=service._split_filter(kind),
        statuses=service._split_filter(status),
        since=since,
        until=until,
        limit=limit,
    )
