"""Analytics event model for product metrics."""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import String, DateTime, Text, Index
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base


class AnalyticsEvent(Base):
    __tablename__ = "analytics_events"
    __table_args__ = (
        Index("ix_analytics_room_type", "room_id", "event_type"),
        Index("ix_analytics_user_time", "user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    room_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    metadata_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "event_type": self.event_type,
            "user_id": self.user_id,
            "room_id": self.room_id,
            "metadata": self.metadata_json,
            "created_at": self.created_at.isoformat(),
        }
