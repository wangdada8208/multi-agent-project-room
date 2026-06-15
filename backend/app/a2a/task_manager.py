from __future__ import annotations
"""A2A Task Manager — handles task lifecycle and routing.

State machine:
  submitted → working → completed
                      → failed
                      → canceled
                      → input_required
"""

import uuid
from datetime import datetime, timezone
from sqlalchemy import select
from app.core.database import async_session
from app.a2a.models import A2ATask
from app.a2a.client import A2AClientPool
from app.a2a.discovery import AgentDiscovery

client_pool = A2AClientPool()


async def submit_task(
    query: str,
    target_agent: str | None = None,
    source_agent: str = "hub",
    task_id: str | None = None,
) -> dict:
    """Submit a task. Routes to remote agent if target is specified."""
    tid = task_id or str(uuid.uuid4())

    # Persist initial state
    async with async_session() as db:
        db_task = A2ATask(
            id=tid,
            source_agent=source_agent,
            target_agent=target_agent,
            query=query,
            status="submitted",
        )
        db.add(db_task)
        await db.commit()

    # Route to remote agent
    if target_agent and target_agent != "local":
        agents = await AgentDiscovery.list_available()
        target = next((a for a in agents if a["name"] == target_agent), None)
        if target and target.get("url"):
            client = client_pool.get(target["name"], target["url"])
            result = await client.send_task(tid, query)
            # Update from remote result
            async with async_session() as db:
                db_task = await db.get(A2ATask, tid)
                if db_task:
                    db_task.status = result.get("status", "completed")
                    db_task.result = result.get("artifacts", [])
                    if db_task.status == "completed":
                        db_task.completed_at = datetime.now(timezone.utc)
                    await db.commit()
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
    return {"id": task_id, "status": "failed", "error": error}


async def get_task(task_id: str) -> dict | None:
    """Get task status and result."""
    async with async_session() as db:
        db_task = await db.get(A2ATask, task_id)
        return db_task.to_dict() if db_task else None


async def list_tasks(
    page: int = 1, limit: int = 50, status: str | None = None
) -> list[dict]:
    """List tasks, optionally filtered by status."""
    async with async_session() as db:
        stmt = select(A2ATask).order_by(A2ATask.created_at.desc())
        if status:
            stmt = stmt.where(A2ATask.status == status)
        stmt = stmt.offset((page - 1) * limit).limit(limit)
        result = await db.execute(stmt)
        return [t.to_dict() for t in result.scalars().all()]


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
    return {"id": task_id, "status": "canceled"}
