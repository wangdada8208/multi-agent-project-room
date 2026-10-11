from __future__ import annotations
"""A2A Task Manager — handles task lifecycle, remote dispatch, and WS broadcasting.

Delegates all transaction boundaries, CAS atomic updates, and audit logging to TaskService.
"""

import logging
import uuid
from typing import Any, Optional

from app.config import get_settings
from app.core.database import async_session
from app.a2a.models import A2ATask
from app.a2a.task_service import TaskService
from app.a2a.client import A2AClientPool
from app.a2a.discovery import AgentDiscovery
from app.ws.connection_manager import connection_manager

client_pool = A2AClientPool()
logger = logging.getLogger(__name__)
settings = get_settings()
ACTIVE_TASK_STATUSES = ("submitted", "working")


async def submit_task(
    query: str,
    target_agent: Optional[str] = None,
    source_agent: str = "hub",
    task_id: Optional[str] = None,
    room_id: Optional[str] = None,
    source_message_id: Optional[str] = None,
    requestor_id: Optional[str] = None,
    route_remote: bool = True,
    context_id: Optional[str] = None,
) -> dict:
    """Submit a task via TaskService. Routes to remote agent if target is specified."""
    tid = task_id or str(uuid.uuid4())
    logger.info("task submitted id=%s target=%s room=%s", tid, target_agent, room_id)

    # Persist initial state atomically with initial audit event
    async with async_session() as db:
        db_task, _ = await TaskService.create_task(
            db,
            query=query,
            target_agent=target_agent,
            source_agent=source_agent,
            task_id=tid,
            room_id=room_id,
            source_message_id=source_message_id,
            context_id=context_id,
            initial_status="submitted",
        )
        await db.commit()
        await db.refresh(db_task)
        await _broadcast_task_update(db_task)

    # Route to remote agent if requested
    if route_remote and target_agent and target_agent != "local":
        agents = await AgentDiscovery.list_available()
        target = next((a for a in agents if a["name"] == target_agent), None)
        if not target or not target.get("url"):
            error = f"Target agent '{target_agent}' is unavailable"
            return await fail_task(tid, error)

        try:
            client = client_pool.get(target["name"], target["url"])
            result = await client.send_task(query, task_id=tid)
        except Exception as e:
            error = f"Target agent '{target_agent}' delivery failed: {e}"
            return await fail_task(tid, error)

        # Update from remote result using TaskService CAS
        remote_status = result.get("status", "completed")
        remote_artifacts = result.get("artifacts", [])
        async with async_session() as db:
            if remote_status == "completed":
                db_task, _, _ = await TaskService.complete_task(
                    db, tid, remote_artifacts
                )
            elif remote_status == "failed":
                db_task, _, _ = await TaskService.fail_task(
                    db, tid, str(remote_artifacts or "Remote task failed")
                )
            else:
                db_task = await TaskService.get_task(db, tid)
            await db.commit()
            if db_task:
                await db.refresh(db_task)
                await _broadcast_task_update(db_task)
        return {
            "id": tid,
            "status": db_task.status if db_task else "submitted",
            "result": db_task.result if db_task else None,
        }

    # Local processing (mark as working, caller completes it)
    async with async_session() as db:
        db_task, _, _ = await TaskService.start_task(db, tid)
        await db.commit()
        if db_task:
            await db.refresh(db_task)
            await _broadcast_task_update(db_task)

    return {"id": tid, "status": "working", "result": None}


async def complete_task(task_id: str, result_data: Any) -> dict:
    """Mark a task as completed with artifacts using TaskService CAS."""
    async with async_session() as db:
        db_task, _, res_code = await TaskService.complete_task(
            db, task_id, result_data
        )
        await db.commit()
        if not db_task:
            return {"error": "Task not found"}

        if res_code == "canceled_overridden_rejected":
            logger.warning(
                "Rejecting completion for finalized task id=%s status=%s",
                task_id,
                db_task.status,
            )
            return {
                "id": task_id,
                "status": db_task.status,
                "info": f"Task already finalized as {db_task.status}; late result discarded",
            }
        if res_code in ("already_completed", "failed_overridden_rejected"):
            logger.warning(
                "Task id=%s already finalized as %s", task_id, db_task.status
            )
            return {
                "id": task_id,
                "status": db_task.status,
                "info": f"Task already finalized as {db_task.status}",
            }

        await db.refresh(db_task)
        await _broadcast_task_update(db_task)
        logger.info("task completed id=%s", task_id)
    return {"id": task_id, "status": "completed", "result": result_data}


async def fail_task(task_id: str, error: str) -> dict:
    """Mark a task as failed using TaskService CAS."""
    async with async_session() as db:
        db_task, _, res_code = await TaskService.fail_task(db, task_id, error)
        await db.commit()
        if not db_task:
            return {"error": "Task not found"}

        if res_code in ("canceled_overridden_rejected", "already_failed", "already_completed"):
            logger.warning(
                "Rejecting failure for finalized task id=%s status=%s",
                task_id,
                db_task.status,
            )
            return {
                "id": task_id,
                "status": db_task.status,
                "info": f"Task already finalized as {db_task.status}",
            }

        await db.refresh(db_task)
        await _broadcast_task_update(db_task)
        logger.info("task failed id=%s", task_id)
    return {"id": task_id, "status": "failed", "error": error}


async def get_task(task_id: str) -> dict | None:
    """Get task status and result."""
    await expire_stale_tasks()
    async with async_session() as db:
        db_task = await TaskService.get_task(db, task_id)
        return db_task.to_dict() if db_task else None


async def get_task_events(task_id: str, after_seq: int = 0, limit: int = 100) -> list[dict]:
    """Get immutable audit events for a task ordered by event_seq strictly ascending."""
    async with async_session() as db:
        events = await TaskService.get_task_events(db, task_id, after_seq=after_seq, limit=limit)
        return [e.to_dict() for e in events]


async def list_tasks(
    page: int = 1, limit: int = 50, status: str | None = None
) -> list[dict]:
    """List tasks, optionally filtered by status."""
    await expire_stale_tasks()
    async with async_session() as db:
        tasks = await TaskService.list_tasks(
            db, page=page, limit=limit, status=status
        )
        return [t.to_dict() for t in tasks]


async def list_room_tasks(
    room_id: str,
    page: int = 1,
    limit: int = 50,
    status: str | None = None,
) -> list[dict]:
    """List tasks for a room, optionally filtered by status."""
    await expire_stale_tasks()
    async with async_session() as db:
        tasks = await TaskService.list_room_tasks(
            db, room_id=room_id, page=page, limit=limit, status=status
        )
        return [t.to_dict() for t in tasks]


async def link_approval(
    task_id: str, approval_id: str, status: str = "input_required"
) -> dict | None:
    """Attach an approval to a task and optionally move it to input_required."""
    async with async_session() as db:
        db_task, _ = await TaskService.link_approval(
            db, task_id, approval_id, status
        )
        if not db_task:
            return None
        await db.commit()
        await db.refresh(db_task)
        await _broadcast_task_update(db_task)
        return db_task.to_dict()


async def cancel_task(task_id: str) -> dict:
    """Cancel a running task using TaskService CAS."""
    async with async_session() as db:
        db_task, _, res_code = await TaskService.cancel_task(db, task_id)
        from app.chat.delivery_service import cancel_deliveries
        cancel_frames = await cancel_deliveries(db, task_id) if db_task and db_task.status == "canceled" else []
        await db.commit()
        # Send control to the private executor channel before room notifications.
        for channel, frame in cancel_frames:
            await connection_manager.broadcast(channel, frame)
        if not db_task:
            return {"error": "Task not found"}

        if res_code in ("already_completed", "already_failed", "already_canceled"):
            return {
                "id": task_id,
                "status": db_task.status,
                "info": "Already finalized",
            }

        await db.refresh(db_task)
        await _broadcast_task_update(db_task)
        if db_task.room_id:
            await connection_manager.broadcast(
                db_task.room_id,
                {
                    "type": "task_canceled",
                    "task_id": task_id,
                    "room_id": db_task.room_id,
                    "agent_id": db_task.target_agent or "",
                },
            )
        logger.info("task canceled id=%s", task_id)
    return {"id": task_id, "status": "canceled"}


async def expire_stale_tasks(timeout_seconds: int | None = None) -> dict:
    """Mark submitted/working tasks as failed after the configured timeout."""
    timeout = timeout_seconds or settings.a2a_task_timeout_seconds
    async with async_session() as db:
        expired = await TaskService.expire_stale_tasks(db, timeout)
        await db.commit()
        for db_task in expired:
            await _broadcast_task_update(db_task)

    return {"count": len(expired), "task_ids": [task.id for task in expired]}


async def _broadcast_task_update(task: A2ATask) -> None:
    if not task.room_id:
        return
    await connection_manager.broadcast(
        task.room_id,
        {"type": "task_update", "task": task.to_dict()},
    )
