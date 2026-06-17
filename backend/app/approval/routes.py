"""Approval REST API — create, list, approve, reject."""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from app.core.database import get_db
from app.core.security import get_current_user
from app.approval import service as approval_service
from app.models.room import Room
from app.models.user import User

router = APIRouter(prefix="/api/v1", tags=["approval"])


# ── Schemas ───────────────────────────────────────────


class CreateApprovalRequest(BaseModel):
    title: str = Field(min_length=1, max_length=256)
    description: str = ""
    risk_level: str = Field(default="low", pattern="^(low|medium|high)$")
    task_id: Optional[str] = None
    requested_action: Optional[str] = None
    risk_summary: Optional[str] = None
    metadata: Optional[dict] = None


class DecideRequest(BaseModel):
    decision: str = Field(pattern="^(approved|rejected)$")


# ── Routes ────────────────────────────────────────────


@router.post("/rooms/{room_id}/approvals")
async def create_approval(
    room_id: str,
    payload: CreateApprovalRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Create a new approval request."""
    room = await db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    approval = await approval_service.create_approval(
        db=db,
        room_id=room_id,
        requestor_id=current_user.id,
        title=payload.title,
        description=payload.description,
        risk_level=payload.risk_level,
        metadata={
            **(payload.metadata or {}),
            **({"task_id": payload.task_id} if payload.task_id else {}),
            **({"requested_action": payload.requested_action} if payload.requested_action else {}),
            **({"risk_summary": payload.risk_summary} if payload.risk_summary else {}),
        } or None,
    )
    return {"approval": approval.to_dict()}


@router.get("/rooms/{room_id}/approvals")
async def list_approvals(
    room_id: str,
    status: Optional[str] = Query(None, pattern="^(pending|approved|rejected)$"),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """List approvals with optional status filter."""
    room = await db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    approvals = await approval_service.list_approvals(
        db=db, room_id=room_id, status=status, page=page, limit=limit
    )
    return {"approvals": [a.to_dict() for a in approvals]}


@router.post("/approvals/{approval_id}/approve")
async def approve_approval(
    approval_id: str,
    payload: DecideRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """Approve or reject an approval request."""
    result = await approval_service.decide_approval(
        db=db, approval_id=approval_id, decider_id=current_user.id,
        decision=payload.decision,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    return {"approval": result.to_dict()}
