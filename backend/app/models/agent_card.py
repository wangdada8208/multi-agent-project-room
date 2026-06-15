"""AgentCard record — tracks registered agents and their capabilities."""

from datetime import datetime, timezone
from sqlalchemy import String, Boolean, DateTime, JSON
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base


class AgentCardRecord(Base):
    """Registered remote agent record for A2A discovery."""

    __tablename__ = "agent_card_records"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True
    )
    agent_name: Mapped[str] = mapped_column(String(128), nullable=False)
    agent_card_url: Mapped[str] = mapped_column(String(512), nullable=False)
    capabilities: Mapped[list | None] = mapped_column(JSON, nullable=True)
    skills: Mapped[list | None] = mapped_column(JSON, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
