"""Room invite token model for agent onboarding and invite redemption."""
from __future__ import annotations
import secrets
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import String, DateTime, ForeignKey, JSON, Index, CheckConstraint, Boolean, Integer
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base


class RoomInvite(Base):
    __tablename__ = "room_invites"

    # f9a1c2d3e4b5 creates this index explicitly; declare it in metadata so
    # autogenerate does not propose dropping it.
    __table_args__ = (
        Index("ix_room_invites_room_id", "room_id"),
        CheckConstraint("role IN ('member','viewer')", name="ck_room_invites_role"),
        CheckConstraint("use_count >= 0 AND use_count <= max_uses", name="ck_room_invites_uses"),
    )

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
    # m1 (l20c20261120): multi-use invites, per-redemption approval and soft
    # revocation. role is the human role granted by /accept and by approved
    # human redemptions; agent seats are always 'member' regardless.
    max_uses: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    use_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    requires_approval: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="member", server_default="member")
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
