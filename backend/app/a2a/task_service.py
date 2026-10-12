from __future__ import annotations
"""A2A Unified Task Service — handles state transitions, CAS concurrency, and audit events."""

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.a2a.models import A2ATask, TaskEvent

logger = logging.getLogger(__name__)

ACTIVE_STATUSES = ("submitted", "working", "input_required", "queued")
TERMINAL_STATUSES = ("completed", "failed", "canceled")
VALID_STATUSES = ACTIVE_STATUSES + TERMINAL_STATUSES

SENSITIVE_KEY_PATTERNS = (
    "token",
    "password",
    "secret",
    "authorization",
    "auth_token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "enrollment_key",
    "private_key",
    "signature",
)

JWT_PATTERN = re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")
BEARER_PATTERN = re.compile(r"(bearer\s+)[A-Za-z0-9_\-\.]+", re.IGNORECASE)
API_KEY_PATTERN = re.compile(r"\b(?:sk|pk|token|api|key)[-_][A-Za-z0-9_\-]{16,}\b", re.IGNORECASE)
PRIVATE_KEY_PATTERN = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----")


def sanitize_payload(payload: Any) -> Any:
    """Recursively scrub sensitive keys and token-like strings from audit event payloads."""
    if isinstance(payload, dict):
        sanitized: dict[str, Any] = {}
        for k, v in payload.items():
            lower_k = str(k).lower()
            if any(pat in lower_k for pat in SENSITIVE_KEY_PATTERNS):
                sanitized[str(k)] = "[REDACTED]"
            else:
                sanitized[str(k)] = sanitize_payload(v)
        return sanitized
    if isinstance(payload, (list, tuple)):
        return [sanitize_payload(item) for item in payload]
    if isinstance(payload, str):
        val = payload
        if "bearer " in val.lower() or "authorization:" in val.lower():
            val = BEARER_PATTERN.sub(r"\1[REDACTED]", val)
        if "-----BEGIN" in val and "PRIVATE KEY-----" in val:
            val = PRIVATE_KEY_PATTERN.sub("[REDACTED_PRIVATE_KEY]", val)
        if "eyJ" in val:
            val = JWT_PATTERN.sub("[REDACTED_JWT]", val)
        if API_KEY_PATTERN.search(val):
            val = API_KEY_PATTERN.sub("[REDACTED_KEY]", val)
        return val
    if isinstance(payload, (int, float, bool)) or payload is None:
        return payload
    return str(payload)


async def notify_task(session, task_id):
    """Signal the task's authorized room through the ONE shared PG wakeup bus."""
    from app.chat.pg_wakeup import signal_in_transaction
    room_id = (await session.execute(select(A2ATask.room_id).where(A2ATask.id == task_id))).scalar_one_or_none()
    if room_id:
        await signal_in_transaction(session, "room", room_id)


async def _append_event(
    session: AsyncSession,
    task_id: str,
    event_type: str,
    payload: Optional[dict] = None,
    explicit_seq: Optional[int] = None,
) -> TaskEvent:
    """Append an immutable audit event for a task with strictly monotonic event_seq.

    Uses atomic increment on parent task row (event_seq = event_seq + 1 RETURNING event_seq)
    to serialize concurrent transactions and prevent sequence collisions.
    """
    clean_payload = sanitize_payload(payload) if payload is not None else None

    if explicit_seq is not None:
        next_seq = explicit_seq
    else:
        # Atomic CAS increment on parent task row with RETURNING
        stmt = (
            update(A2ATask)
            .where(A2ATask.id == task_id)
            .values(event_seq=A2ATask.event_seq + 1)
            .returning(A2ATask.event_seq)
        )
        res = await session.execute(stmt)
        seq_val = res.scalar()
        if seq_val is not None:
            next_seq = seq_val
        else:
            # Fallback if parent task row is not found or not yet flushed
            seq_stmt = select(func.coalesce(func.max(TaskEvent.event_seq), 0)).where(
                TaskEvent.task_id == task_id
            )
            next_seq = ((await session.execute(seq_stmt)).scalar() or 0) + 1

    event = TaskEvent(
        id=str(uuid.uuid4()),
        task_id=task_id,
        event_seq=next_seq,
        event_type=event_type,
        payload=clean_payload,
        created_at=datetime.now(timezone.utc),
    )
    session.add(event)
    await session.flush()
    await notify_task(session, task_id)
    return event


class TaskService:
    """Core transaction and CAS operations for A2A tasks and audit events."""

    @staticmethod
    async def pause_task(session: AsyncSession, task_id: str, reason: str) -> None:
        """Interrupt active work for owner review without claiming an execution outcome."""
        changed = await session.execute(update(A2ATask).where(
            A2ATask.id == task_id,
            A2ATask.status.in_(("submitted", "queued", "working")),
        ).values(status="input_required"))
        if changed.rowcount == 1:
            await _append_event(session, task_id, "status_changed", {
                "to_status": "input_required", "reason": reason})

    @staticmethod
    async def create_task(
        session: AsyncSession,
        *,
        query: str,
        target_agent: Optional[str] = None,
        source_agent: str = "hub",
        task_id: Optional[str] = None,
        room_id: Optional[str] = None,
        source_message_id: Optional[str] = None,
        approval_id: Optional[str] = None,
        context_id: Optional[str] = None,
        initial_status: str = "submitted",
        metadata: Optional[dict] = None,
    ) -> tuple[A2ATask, TaskEvent]:
        """Create a new task and record its initial task_created event."""
        if initial_status not in VALID_STATUSES:
            raise ValueError(f"Invalid initial task status: {initial_status}")

        tid = task_id or str(uuid.uuid4())
        now = datetime.now(timezone.utc)

        task = A2ATask(
            id=tid,
            context_id=context_id,
            source_agent=source_agent,
            target_agent=target_agent,
            query=query,
            status=initial_status,
            room_id=room_id,
            source_message_id=source_message_id,
            approval_id=approval_id,
            event_seq=1,
            created_at=now,
        )
        session.add(task)
        await session.flush()

        event_payload = {
            "status": initial_status,
            "target_agent": target_agent,
            "source_agent": source_agent,
            "room_id": room_id,
        }
        if metadata:
            event_payload.update(metadata)

        event = await _append_event(
            session,
            task_id=tid,
            event_type="task_created",
            payload=event_payload,
            explicit_seq=1,
        )
        return task, event

    @staticmethod
    async def start_task(
        session: AsyncSession,
        task_id: str,
    ) -> tuple[Optional[A2ATask], Optional[TaskEvent], str]:
        """CAS transition: move submitted/queued/input_required task to working."""
        stmt = (
            update(A2ATask)
            .where(
                A2ATask.id == task_id,
                A2ATask.status.in_(("submitted", "queued", "input_required")),
            )
            .values(status="working")
        )
        res = await session.execute(stmt)
        if res.rowcount == 1:
            await session.flush()
            task = await session.get(A2ATask, task_id)
            if task:
                await session.refresh(task)
            event = await _append_event(
                session,
                task_id=task_id,
                event_type="status_changed",
                payload={"to_status": "working"},
            )
            return task, event, "working"

        # Check existing state
        task = await session.get(A2ATask, task_id)
        if not task:
            return None, None, "not_found"
        if task.status == "working":
            return task, None, "already_working"
        return task, None, f"terminal_{task.status}"

    @staticmethod
    async def complete_task(
        session: AsyncSession,
        task_id: str,
        result_data: Any,
    ) -> tuple[Optional[A2ATask], Optional[TaskEvent], str]:
        """CAS transition: complete a task. Strictly rejects late completion if task was canceled."""
        now = datetime.now(timezone.utc)
        stmt = (
            update(A2ATask)
            .where(
                A2ATask.id == task_id,
                A2ATask.status.in_(ACTIVE_STATUSES),
            )
            .values(
                status="completed",
                result=result_data,
                completed_at=now,
            )
        )
        res = await session.execute(stmt)
        if res.rowcount == 1:
            await session.flush()
            task = await session.get(A2ATask, task_id)
            if task:
                await session.refresh(task)
            event = await _append_event(
                session,
                task_id=task_id,
                event_type="task_completed",
                payload={"status": "completed"},
            )
            return task, event, "completed"

        task = await session.get(A2ATask, task_id)
        if not task:
            return None, None, "not_found"

        if task.status == "canceled":
            # Late result discarded! Do not overwrite canceled status
            event = await _append_event(
                session,
                task_id=task_id,
                event_type="late_result_discarded",
                payload={
                    "attempted_status": "completed",
                    "current_status": "canceled",
                    "info": "Late completion discarded because task is already canceled",
                },
            )
            logger.warning(
                "Late completion discarded for canceled task id=%s", task_id
            )
            return task, event, "canceled_overridden_rejected"

        if task.status == "completed":
            return task, None, "already_completed"

        if task.status == "failed":
            event = await _append_event(
                session,
                task_id=task_id,
                event_type="late_result_discarded",
                payload={
                    "attempted_status": "completed",
                    "current_status": "failed",
                },
            )
            return task, event, "failed_overridden_rejected"

        return task, None, f"invalid_state_{task.status}"

    @staticmethod
    async def fail_task(
        session: AsyncSession,
        task_id: str,
        error: str,
    ) -> tuple[Optional[A2ATask], Optional[TaskEvent], str]:
        """CAS transition: mark task as failed. Rejects late failure if task was already canceled."""
        now = datetime.now(timezone.utc)
        stmt = (
            update(A2ATask)
            .where(
                A2ATask.id == task_id,
                A2ATask.status.in_(ACTIVE_STATUSES),
            )
            .values(
                status="failed",
                result={"error": error},
                completed_at=now,
            )
        )
        res = await session.execute(stmt)
        if res.rowcount == 1:
            await session.flush()
            task = await session.get(A2ATask, task_id)
            if task:
                await session.refresh(task)
            event = await _append_event(
                session,
                task_id=task_id,
                event_type="task_failed",
                payload={"status": "failed", "error": error[:500]},
            )
            return task, event, "failed"

        task = await session.get(A2ATask, task_id)
        if not task:
            return None, None, "not_found"

        if task.status == "canceled":
            event = await _append_event(
                session,
                task_id=task_id,
                event_type="late_failure_discarded",
                payload={
                    "attempted_status": "failed",
                    "current_status": "canceled",
                },
            )
            return task, event, "canceled_overridden_rejected"

        if task.status == "failed":
            return task, None, "already_failed"

        if task.status == "completed":
            return task, None, "already_completed"

        return task, None, f"invalid_state_{task.status}"

    @staticmethod
    async def cancel_task(
        session: AsyncSession,
        task_id: str,
        reason: str = "canceled",
    ) -> tuple[Optional[A2ATask], Optional[TaskEvent], str]:
        """CAS transition: cancel a task. Completed/failed tasks cannot be canceled."""
        now = datetime.now(timezone.utc)
        stmt = (
            update(A2ATask)
            .where(
                A2ATask.id == task_id,
                A2ATask.status.in_(ACTIVE_STATUSES),
            )
            .values(
                status="canceled",
                completed_at=now,
            )
        )
        res = await session.execute(stmt)
        if res.rowcount == 1:
            await session.flush()
            task = await session.get(A2ATask, task_id)
            if task:
                await session.refresh(task)
            event = await _append_event(
                session,
                task_id=task_id,
                event_type="task_canceled",
                payload={"status": "canceled", "reason": reason},
            )
            return task, event, "canceled"

        task = await session.get(A2ATask, task_id)
        if not task:
            return None, None, "not_found"
        if task.status == "canceled":
            return task, None, "already_canceled"
        if task.status == "completed":
            return task, None, "already_completed"
        if task.status == "failed":
            return task, None, "already_failed"

        return task, None, f"invalid_state_{task.status}"

    @staticmethod
    async def link_approval(
        session: AsyncSession,
        task_id: str,
        approval_id: str,
        status: str = "input_required",
    ) -> tuple[Optional[A2ATask], Optional[TaskEvent]]:
        """Link approval ID and move status to input_required."""
        stmt = (
            update(A2ATask)
            .where(
                A2ATask.id == task_id,
                A2ATask.status.in_(("submitted", "working")),
            )
            .values(
                approval_id=approval_id,
                status=status,
            )
        )
        res = await session.execute(stmt)
        if res.rowcount == 1:
            await session.flush()
            task = await session.get(A2ATask, task_id)
            event = await _append_event(
                session,
                task_id=task_id,
                event_type="approval_linked",
                payload={"approval_id": approval_id, "status": status},
            )
            return task, event

        task = await session.get(A2ATask, task_id)
        return task, None

    @staticmethod
    async def get_task(session: AsyncSession, task_id: str) -> Optional[A2ATask]:
        """Fetch a task by ID."""
        return await session.get(A2ATask, task_id)

    @staticmethod
    async def get_task_events(
        session: AsyncSession,
        task_id: str,
        after_seq: int = 0,
        limit: int = 100,
    ) -> list[TaskEvent]:
        """Fetch audit events for a task ordered by event_seq strictly ascending."""
        stmt = (
            select(TaskEvent)
            .where(
                TaskEvent.task_id == task_id,
                TaskEvent.event_seq > after_seq,
            )
            .order_by(TaskEvent.event_seq.asc()).limit(min(max(limit, 1), 100))
        )
        res = await session.execute(stmt)
        return list(res.scalars().all())

    @staticmethod
    async def list_tasks(
        session: AsyncSession,
        page: int = 1,
        limit: int = 50,
        status: Optional[str] = None,
    ) -> list[A2ATask]:
        """List tasks with optional status filter."""
        stmt = select(A2ATask).order_by(A2ATask.created_at.desc())
        if status:
            stmt = stmt.where(A2ATask.status == status)
        stmt = stmt.offset((page - 1) * limit).limit(limit)
        res = await session.execute(stmt)
        return list(res.scalars().all())

    @staticmethod
    async def list_room_tasks(
        session: AsyncSession,
        room_id: str,
        page: int = 1,
        limit: int = 50,
        status: Optional[str] = None,
    ) -> list[A2ATask]:
        """List tasks for a room with optional status filter."""
        stmt = (
            select(A2ATask)
            .where(A2ATask.room_id == room_id)
            .order_by(A2ATask.created_at.desc())
        )
        if status:
            stmt = stmt.where(A2ATask.status == status)
        stmt = stmt.offset((page - 1) * limit).limit(limit)
        res = await session.execute(stmt)
        return list(res.scalars().all())

    @staticmethod
    async def expire_stale_tasks(
        session: AsyncSession,
        timeout_seconds: int,
    ) -> list[A2ATask]:
        """Expire stale active tasks beyond timeout cutoff."""
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=timeout_seconds)
        stmt = select(A2ATask).where(
            A2ATask.status.in_(("submitted", "working")),
            A2ATask.created_at < cutoff,
        )
        res = await session.execute(stmt)
        stale_tasks = list(res.scalars().all())

        expired: list[A2ATask] = []
        for task in stale_tasks:
            t, _, res_code = await TaskService.fail_task(
                session,
                task.id,
                error=f"Task timed out after {timeout_seconds} seconds",
            )
            if res_code == "failed" and t:
                expired.append(t)
        return expired
