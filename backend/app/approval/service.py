from __future__ import annotations
"""Approval service — create, list, approve, reject."""

import logging
from datetime import datetime, timezone, timedelta
import hashlib
import json
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.approval.models import Approval, ActionGrant
from app.a2a import task_manager as tm
from app.ws.connection_manager import connection_manager

logger = logging.getLogger(__name__)


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
        approval_meta=metadata,
    )
    db.add(approval)
    await db.commit()
    await db.refresh(approval)
    logger.info("approval created id=%s room=%s requestor=%s", approval.id, room_id, requestor_id)

    # Broadcast approval_update event
    approval_data = approval.to_dict()
    await connection_manager.broadcast(
        room_id,
        {'type': 'approval_update', 'approval': approval_data},
    )
    # Broadcast system message for human readability
    await connection_manager.broadcast(
        room_id,
        {'type': 'system', 'content': f'📋 审批请求: {title} ({risk_level})'},
    )
    task_id = (metadata or {}).get("task_id")
    if task_id:
        await tm.link_approval(str(task_id), approval.id)

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

    # Verify decider permission in room if permission records exist
    from app.models.room_permission import RoomPermission
    any_perms_stmt = select(RoomPermission).where(RoomPermission.room_id == approval.room_id)
    any_perms = (await db.execute(any_perms_stmt)).scalars().all()
    if any_perms:
        perm_stmt = select(RoomPermission).where(
            RoomPermission.room_id == approval.room_id,
            RoomPermission.user_id == decider_id,
        )
        perm = (await db.execute(perm_stmt)).scalars().first()
        if perm is None or perm.role not in ("owner", "member"):
            raise ValueError("Decider has insufficient role to decide approval")

    approval.status = decision
    approval.decided_by = decider_id
    approval.decided_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(approval)
    logger.info("approval decided id=%s decision=%s decider=%s", approval_id, decision, decider_id)

    # Broadcast approval_update event
    approval_data = approval.to_dict()
    room_id_local = approval.room_id
    await connection_manager.broadcast(
        room_id_local,
        {'type': 'approval_update', 'approval': approval_data},
    )
    # Broadcast system message for human readability
    emoji = '✅' if decision == 'approved' else '❌'
    status_text = '审批已批准' if decision == 'approved' else '审批已拒绝'
    await connection_manager.broadcast(
        room_id_local,
        {'type': 'system', 'content': f'{emoji} {status_text}: {approval.title}'},
    )
    # If approved and metadata defines an action, issue ActionGrant
    action_grant = None
    if decision == "approved":
        meta = approval.approval_meta or {}
        scope = meta.get("scope") or meta.get("action_type") or "default"
        params = meta.get("params") or meta.get("action_params")
        agent_name = meta.get("agent_name") or "agent"
        action_grant = await issue_action_grant(
            db=db,
            approval=approval,
            scope=scope,
            params=params,
            granted_to_agent=agent_name,
        )
        # Include grant details in approval broadcast
        approval_data["grant"] = action_grant.to_dict()

    task_id = (approval.approval_meta or {}).get("task_id")
    if task_id:
        if decision == "approved":
            await tm.link_approval(str(task_id), approval.id, status="working")
        else:
            await tm.cancel_task(str(task_id))

    return approval


def compute_params_hash(params: dict | list | str | None) -> str:
    """Compute deterministic SHA-256 hash of parameters."""
    if params is None:
        raw = ""
    elif isinstance(params, str):
        raw = params
    else:
        raw = json.dumps(params, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def issue_action_grant(
    db: AsyncSession,
    approval: Approval,
    scope: str = "default",
    params: dict | list | str | None = None,
    granted_to_agent: str = "agent",
    expires_in_seconds: int = 300,
) -> ActionGrant:
    """Issue a single-use ActionGrant cryptographically linked to an approved approval."""
    p_hash = compute_params_hash(params)
    now = datetime.now(timezone.utc)
    grant = ActionGrant(
        approval_id=approval.id,
        task_id=(approval.approval_meta or {}).get("task_id"),
        room_id=approval.room_id,
        granted_to_agent=granted_to_agent,
        scope=scope,
        params_hash=p_hash,
        expires_at=now + timedelta(seconds=expires_in_seconds),
        consumed_at=None,
    )
    db.add(grant)
    await db.commit()
    await db.refresh(grant)
    logger.info("action grant issued id=%s approval_id=%s scope=%s", grant.id, approval.id, scope)
    return grant


async def verify_and_consume_grant(
    db: AsyncSession,
    grant_id: str,
    scope: str,
    params: dict | list | str | None = None,
    agent_name: str | None = None,
) -> ActionGrant:
    """Verify grant validity, single-use, scope, expiration, and parameter integrity, then consume."""
    grant = await db.get(ActionGrant, grant_id)
    if not grant:
        raise ValueError("Action grant not found")
    if grant.consumed_at is not None:
        raise ValueError("Action grant has already been consumed")

    now = datetime.now(timezone.utc)
    expires_at = grant.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if now > expires_at:
        raise ValueError("Action grant has expired")

    if grant.scope != scope:
        raise ValueError(f"Action grant scope mismatch: expected {grant.scope}, got {scope}")

    if agent_name and grant.granted_to_agent.lower() != agent_name.lower():
        raise ValueError(f"Action grant recipient mismatch: expected {grant.granted_to_agent}, got {agent_name}")

    expected_hash = compute_params_hash(params)
    if grant.params_hash != expected_hash:
        raise ValueError("Action grant parameter hash mismatch: arguments have been tampered with")

    grant.consumed_at = now
    await db.commit()
    await db.refresh(grant)
    logger.info("action grant consumed id=%s scope=%s", grant.id, scope)
    return grant
