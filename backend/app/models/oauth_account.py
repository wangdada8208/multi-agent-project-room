"""OAuth identity link table for external SSO providers (e.g. Google)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class UserOAuthAccount(Base):
    """Links an external provider subject (immutable ``sub``) to a local human user.

    Only verified identity claims (never provider access/refresh tokens) are stored here.
    """

    __tablename__ = "user_oauth_accounts"
    __table_args__ = (
        UniqueConstraint("provider", "provider_subject", name="uq_user_oauth_provider_subject"),
        UniqueConstraint("user_id", "provider", name="uq_user_oauth_user_provider"),
        Index("ix_user_oauth_accounts_user_id", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", name="fk_user_oauth_accounts_user_id", ondelete="CASCADE"),
        nullable=False,
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    provider_subject: Mapped[str] = mapped_column(String(255), nullable=False)
    provider_email: Mapped[Optional[str]] = mapped_column(String(254), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
