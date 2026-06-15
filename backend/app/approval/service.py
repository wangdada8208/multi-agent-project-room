"""Approval service — create, list, approve, reject."""

from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.approval.models import Approval


async def create_approval(
    db: AsyncSession,
    room_id: str,
    requestor_id: str,
    title: str,
    description: str = "",
    risk_level: str = "low",
    metadata: dict | None = None,
) -> Approval:
    """Create a new approval request."""
    approval = Approval(
        room_id=room_id,
        requestor_id=requestor_id,
        title=title,
        description=description,
        risk_level=risk_level,
        status="pending",
        metadata=metadata,
    )
    db.add(approval)
    await db.commit()
    await db.refresh(approval)
    return approval


async def list_approvals(
    db: AsyncSession,
    room_id: str,
    status: str | None = None,
    page: int = 1,
    limit: int = 50,
) -> list[Approval]:
    """List approvals for a room, with optional status filter."""
    stmt = (
        select(Approval)
        .where(Approval.room_id == room_id)
        .order_by(Approval.created_at.desc())
    )
    if status:
        stmt = stmt.where(Approval.status == status)
    stmt = stmt.offset((page - 1) * limit).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def decide_approval(
    db: AsyncSession,
    approval_id: str,
    decider_id: str,
    decision: str,  # "approved" | "rejected"
) -> Approval | None:
    """Approve or reject a pending approval."""
    if decision not in ("approved", "rejected"):
        raise ValueError("decision must be 'approved' or 'rejected'")

    approval = await db.get(Approval, approval_id)
    if approval is None:
        return None
    if approval.status != "pending":
        return approval  # Already decided, return current state

    approval.status = decision
    approval.decided_by = decider_id
    approval.decided_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(approval)
    return approval
