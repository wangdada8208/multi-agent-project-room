from __future__ import annotations
"""A2A Task Manager — handles task lifecycle and routing.

State machine:
  submitted → working → completed
                      → failed
                      → canceled
                      → input_required
"""

import uuid
import logging
from datetime import datetime, timedelta, timezone
from sqlalchemy import select
from app.config import get_settings
from app.core.database import async_session
from app.a2a.models import A2ATask
from app.a2a.client import A2AClientPool
from app.a2a.discovery import AgentDiscovery
from app.ws.connection_manager import connection_manager

client_pool = A2AClientPool()
logger = logging.getLogger(__name__)
settings = get_settings()
ACTIVE_TASK_STATUSES = ("submitted", "working")


async def submit_task(
    query: str,
    target_agent: str | None = None,
    source_agent: str = "hub",
    task_id: str | None = None,
    room_id: str | None = None,
    source_message_id: str | None = None,
    requestor_id: str | None = None,
    route_remote: bool = True,
) -> dict:
    """Submit a task. Routes to remote agent if target is specified."""
    tid = task_id or str(uuid.uuid4())
    logger.info("task submitted id=%s target=%s room=%s", tid, target_agent, room_id)

    # Persist initial state
    async with async_session() as db:
        db_task = A2ATask(
            id=tid,
            source_agent=source_agent,
            target_agent=target_agent,
            query=query,
            status="submitted",
            room_id=room_id,
            source_message_id=source_message_id,
        )
        db.add(db_task)
        await db.commit()
        await db.refresh(db_task)
        await _broadcast_task_update(db_task)

    # Route to remote agent
    if route_remote and target_agent and target_agent != "local":
        agents = await AgentDiscovery.list_available()
        target = next((a for a in agents if a["name"] == target_agent), None)
        if not target or not target.get("url"):
            error = f"Target agent '{target_agent}' is unavailable"
            return await fail_task(tid, error)

        try:
            client = client_pool.get(target["name"], target["url"])
            result = await client.send_task(tid, query)
        except Exception as e:
            error = f"Target agent '{target_agent}' delivery failed: {e}"
            return await fail_task(tid, error)

        # Update from remote result
        async with async_session() as db:
            db_task = await db.get(A2ATask, tid)
            if db_task:
                db_task.status = result.get("status", "completed")
                db_task.result = result.get("artifacts", [])
                if db_task.status == "completed":
                    db_task.completed_at = datetime.now(timezone.utc)
                await db.commit()
                await db.refresh(db_task)
                await _broadcast_task_update(db_task)
        return {
            "id": tid,
            "status": db_task.status if hasattr(locals(), 'db_task') else "submitted",
            "result": db_task.result if hasattr(locals(), 'db_task') else None,
        }

    # Local processing (mark as working, caller completes it)
    async with async_session() as db:
        db_task = await db.get(A2ATask, tid)
        if db_task:
            db_task.status = "working"
            await db.commit()
            await db.refresh(db_task)
            await _broadcast_task_update(db_task)

    return {"id": tid, "status": "working", "result": None}


async def complete_task(task_id: str, result_data: list[dict]) -> dict:
    """Mark a task as completed with artifacts."""
    async with async_session() as db:
        db_task = await db.get(A2ATask, task_id)
        if not db_task:
            return {"error": "Task not found"}
        db_task.status = "completed"
        db_task.result = result_data
        db_task.completed_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(db_task)
        await _broadcast_task_update(db_task)
        logger.info("task completed id=%s", task_id)
    return {"id": task_id, "status": "completed", "result": result_data}


async def fail_task(task_id: str, error: str) -> dict:
    """Mark a task as failed."""
    async with async_session() as db:
        db_task = await db.get(A2ATask, task_id)
        if not db_task:
            return {"error": "Task not found"}
        db_task.status = "failed"
        db_task.result = {"error": error}
        db_task.completed_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(db_task)
        await _broadcast_task_update(db_task)
        logger.info("task failed id=%s error=%s", task_id, error)
    return {"id": task_id, "status": "failed", "error": error}


async def get_task(task_id: str) -> dict | None:
    """Get task status and result."""
    await expire_stale_tasks()
    async with async_session() as db:
        db_task = await db.get(A2ATask, task_id)
        return db_task.to_dict() if db_task else None


async def list_tasks(
    page: int = 1, limit: int = 50, status: str | None = None
) -> list[dict]:
    """List tasks, optionally filtered by status."""
    await expire_stale_tasks()
    async with async_session() as db:
        stmt = select(A2ATask).order_by(A2ATask.created_at.desc())
        if status:
            stmt = stmt.where(A2ATask.status == status)
        stmt = stmt.offset((page - 1) * limit).limit(limit)
        result = await db.execute(stmt)
        return [t.to_dict() for t in result.scalars().all()]


async def list_room_tasks(
    room_id: str,
    page: int = 1,
    limit: int = 50,
    status: str | None = None,
) -> list[dict]:
    """List tasks for a room, optionally filtered by status."""
    await expire_stale_tasks()
    async with async_session() as db:
        stmt = (
            select(A2ATask)
            .where(A2ATask.room_id == room_id)
            .order_by(A2ATask.created_at.desc())
        )
        if status:
            stmt = stmt.where(A2ATask.status == status)
        stmt = stmt.offset((page - 1) * limit).limit(limit)
        result = await db.execute(stmt)
        return [t.to_dict() for t in result.scalars().all()]


async def link_approval(task_id: str, approval_id: str, status: str = "input_required") -> dict | None:
    """Attach an approval to a task and optionally move it to input_required."""
    async with async_session() as db:
        db_task = await db.get(A2ATask, task_id)
        if not db_task:
            return None
        db_task.approval_id = approval_id
        db_task.status = status
        await db.commit()
        await db.refresh(db_task)
        await _broadcast_task_update(db_task)
        return db_task.to_dict()


async def cancel_task(task_id: str) -> dict:
    """Cancel a running task."""
    async with async_session() as db:
        db_task = await db.get(A2ATask, task_id)
        if not db_task:
            return {"error": "Task not found"}
        if db_task.status in ("completed", "failed", "canceled"):
            return {"id": task_id, "status": db_task.status, "info": "Already finalized"}
        db_task.status = "canceled"
        db_task.completed_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(db_task)
        await _broadcast_task_update(db_task)
        logger.info("task canceled id=%s", task_id)
    return {"id": task_id, "status": "canceled"}


async def expire_stale_tasks(timeout_seconds: int | None = None) -> dict:
    """Mark submitted/working tasks as failed after the configured timeout."""
    timeout = timeout_seconds or settings.a2a_task_timeout_seconds
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=timeout)
    expired: list[A2ATask] = []

    async with async_session() as db:
        result = await db.execute(
            select(A2ATask).where(
                A2ATask.status.in_(ACTIVE_TASK_STATUSES),
                A2ATask.created_at < cutoff,
            )
        )
        expired = list(result.scalars().all())
        for db_task in expired:
            db_task.status = "failed"
            db_task.result = {
                "error": f"Task timed out after {timeout} seconds",
            }
            db_task.completed_at = datetime.now(timezone.utc)
        await db.commit()

        for db_task in expired:
            await db.refresh(db_task)
            await _broadcast_task_update(db_task)

    return {"count": len(expired), "task_ids": [task.id for task in expired]}


async def _broadcast_task_update(task: A2ATask) -> None:
    if not task.room_id:
        return
    await connection_manager.broadcast(
        task.room_id,
        {"type": "task_update", "task": task.to_dict()},
    )
