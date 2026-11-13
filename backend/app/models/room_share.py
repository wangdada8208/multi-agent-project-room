"""Room share token model for public read-only links."""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import String, DateTime, ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base


class RoomShareToken(Base):
    __tablename__ = "room_share_tokens"

    # Migration d40c20261010 creates a *named* UNIQUE constraint on token and an
    # explicit index on room_id. A bare `unique=True` on the column would emit an
    # unnamed constraint and omit the room_id index, which `alembic check` sees
    # as drift. These names are the DB's names; only ORM metadata changes here.
    __table_args__ = (
        UniqueConstraint("token", name="uq_room_share_tokens_token"),
        Index("ix_room_share_tokens_room_id", "room_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    room_id: Mapped[str] = mapped_column(String(36), ForeignKey("rooms.id"), nullable=False)
    token: Mapped[str] = mapped_column(String(128), nullable=False)
    created_by: Mapped[str] = mapped_column(String(36), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
