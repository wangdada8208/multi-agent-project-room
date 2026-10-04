"""Room invite token model for agent onboarding and invite redemption."""
from __future__ import annotations
import secrets
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import String, DateTime, ForeignKey, JSON
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base


class RoomInvite(Base):
    __tablename__ = "room_invites"

    token: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: secrets.token_urlsafe(32)
    )
    room_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("rooms.id"), nullable=False
    )
    created_by: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=False
    )
    proposed_scopes: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    redeemed_by_address: Mapped[Optional[str]] = mapped_column(String(42), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    def to_dict(self) -> dict:
        return {
            "token": self.token,
            "room_id": self.room_id,
            "created_by": self.created_by,
            "proposed_scopes": self.proposed_scopes or [],
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "used_at": self.used_at.isoformat() if self.used_at else None,
            "redeemed_by_address": self.redeemed_by_address,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
