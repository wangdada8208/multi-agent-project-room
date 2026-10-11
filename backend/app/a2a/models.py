from __future__ import annotations
"""A2A task ORM model — tracks task lifecycle across agents."""

import uuid
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import String, Text, DateTime, JSON, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base


class A2ATask(Base):
    """A2A task: tracks a unit of work delegated between agents."""

    __tablename__ = "a2a_tasks"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    context_id: Mapped[Optional[str]] = mapped_column(
        String(36), nullable=True, index=True
    )
    source_agent: Mapped[str] = mapped_column(
        String(64), nullable=False, default="hub"
    )
    target_agent: Mapped[str] = mapped_column(String(64), nullable=True)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="submitted"
    )
    # submitted | working | completed | failed | canceled | input_required
    result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    room_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("rooms.id"), nullable=True, index=True
    )
    source_message_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )
    approval_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("approvals.id"), nullable=True
    )
    event_seq: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "context_id": self.context_id,
            "source_agent": self.source_agent,
            "target_agent": self.target_agent,
            "query": self.query,
            "status": self.status,
            "result": self.result,
            "room_id": self.room_id,
            "source_message_id": self.source_message_id,
            "approval_id": self.approval_id,
            "event_seq": self.event_seq,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class TaskEvent(Base):
    """Append-only audit event log for A2A tasks."""

    __tablename__ = "task_events"
    __table_args__ = (
        UniqueConstraint("task_id", "event_seq", name="uq_task_event_seq"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    task_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("a2a_tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "event_seq": self.event_seq,
            "event_type": self.event_type,
            "payload": self.payload,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
