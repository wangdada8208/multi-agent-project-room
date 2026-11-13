"""Knowledge document model."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class KnowledgeDoc(Base):
    __tablename__ = "knowledge_docs"

    # The migrated DB has a composite (room_id, updated_at) index named
    # ix_knowledge_docs_room_updated, not a standalone updated_at index.
    # Declaring index=True on updated_at would make alembic check see drift.
    __table_args__ = (Index("ix_knowledge_docs_room_updated", "room_id", "updated_at"),)

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    room_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("rooms.id"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    author_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    def to_dict(self, include_content: bool = True) -> dict:
        data = {
            "id": self.id,
            "room_id": self.room_id,
            "title": self.title,
            "updated_at": self.updated_at.isoformat(),
            "created_at": self.created_at.isoformat(),
        }
        if include_content:
            data["content"] = self.content
            data["author_id"] = self.author_id
        return data
