"""One-time ownership invitations. Never persist the bearer code."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base


class AgentBindingInvite(Base):
    __tablename__ = "agent_binding_invites"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    token_salt: Mapped[str] = mapped_column(String(32), nullable=False)
    issuer_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    target_agent_user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    claimed_agent_user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False,
                                               default=lambda: datetime.now(timezone.utc))
