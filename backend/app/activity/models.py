"""Activity stream ORM models (m2 migration m30c20261120).

REDLINE: no column here may carry message bodies, action parameters, email
content or guessable digests (no payload/content/params_hash/digest columns).
``ActivityEvent.id`` is the uploader-generated idempotency key;
``ActivityCheckpoint`` only anchors ``(stream_id, head_seq, head_hash,
entry_count)`` plus its EIP-191 signature.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.timestamps import as_utc


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ActivityEvent(Base):
    """One safe-metadata event reported by a helper or a cloud agent."""

    __tablename__ = "activity_events"
    __table_args__ = (
        CheckConstraint(
            "actor_kind IN ('human','agent','helper','system')",
            name="ck_activity_events_actor_kind",
        ),
        Index("ix_activity_events_room_time", "room_id", text("created_at DESC")),
        Index(
            "ix_activity_events_room_actor_time",
            "room_id",
            "actor_id",
            text("created_at DESC"),
        ),
        Index("ix_activity_events_room_kind_status", "room_id", "kind", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    room_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False
    )
    actor_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(128), nullable=False)
    kind: Mapped[str] = mapped_column(String(48), nullable=False)
    app: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    status: Mapped[Optional[str]] = mapped_column(String(24), nullable=True)
    subject_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    stream_seq: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    reported_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    def same_payload(self, other: "ActivityEvent") -> bool:
        """Idempotency check: same id must mean identical safe metadata."""
        return (
            self.room_id == other.room_id
            and self.actor_kind == other.actor_kind
            and self.actor_id == other.actor_id
            and self.kind == other.kind
            and self.app == other.app
            and self.status == other.status
            and self.subject_id == other.subject_id
            and self.stream_seq == other.stream_seq
            and as_utc(self.created_at) == as_utc(other.created_at)
        )


class ActivityCheckpoint(Base):
    """Signed anchor of a worker ledger chain head — metadata, not content."""

    __tablename__ = "activity_checkpoints"
    __table_args__ = (
        CheckConstraint("head_seq >= 0", name="ck_activity_checkpoints_head_seq"),
        CheckConstraint("entry_count >= 0", name="ck_activity_checkpoints_entry_count"),
        UniqueConstraint(
            "room_id", "stream_id", "head_seq", name="uq_activity_checkpoints_stream_seq"
        ),
        Index(
            "ix_activity_checkpoints_stream_head",
            "room_id",
            "stream_id",
            text("head_seq DESC"),
        ),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    room_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False
    )
    stream_id: Mapped[str] = mapped_column(String(64), nullable=False)
    signer_address: Mapped[str] = mapped_column(String(42), nullable=False)
    head_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    head_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    entry_count: Mapped[int] = mapped_column(Integer, nullable=False)
    signature: Mapped[str] = mapped_column(String(132), nullable=False)
    reported_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    checkpoint_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now
    )
