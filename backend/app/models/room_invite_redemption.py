"""Per-redemption audit records for reusable room invites (m1 / WP6).

One row per redemption attempt against a ``room_invites`` token. The unique
index on ``(token, redeemer_address)`` makes a retry from the same address
idempotent; humans that only ever call ``/accept`` (no wallet) are keyed by
``redeemer_user_id`` instead and keep ``redeemer_address`` NULL until they
bind an address.

Status machine (plan §C m1):
    pending -> approved -> consumed   (owner approved; agent token delivered)
    pending -> denied                 (owner denied, or capacity/invite closed at approve time)
    pending -> expired                (redemption TTL or invite expiry reached)
    pending -> revoked                (invite revoked; cascaded in the same txn)
Single-use invites with requires_approval=False skip 'pending': the row is
written directly as 'consumed'.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, JSON, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

REDEMPTION_KINDS = ("human", "agent")
REDEMPTION_STATUSES = ("pending", "approved", "consumed", "denied", "expired", "revoked")


class RoomInviteRedemption(Base):
    __tablename__ = "room_invite_redemptions"
    __table_args__ = (
        Index("uq_redemption_token_address", "token", "redeemer_address", unique=True),
        Index(
            "uq_redemption_token_user_pending",
            "token",
            "redeemer_user_id",
            unique=True,
            postgresql_where=text("status = 'pending' AND redeemer_user_id IS NOT NULL"),
            sqlite_where=text("status = 'pending' AND redeemer_user_id IS NOT NULL"),
        ),
        Index("ix_redemptions_token_status", "token", "status"),
    )

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    token: Mapped[str] = mapped_column(
        String(64), ForeignKey("room_invites.token"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(8), nullable=False)  # 'human' | 'agent'
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    redeemer_user_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=True
    )
    redeemer_address: Mapped[Optional[str]] = mapped_column(String(42), nullable=True)
    agent_user_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=True
    )
    seat_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("agent_seats.id"), nullable=True
    )
    approved_scopes: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    decided_by: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=True
    )
    decided_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    deny_reason: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )

    def to_dict(self) -> dict:
        def _iso(dt: Optional[datetime]) -> Optional[str]:
            return dt.isoformat() if dt else None

        return {
            "id": self.id,
            "token": self.token,
            "kind": self.kind,
            "status": self.status,
            "redeemer_user_id": self.redeemer_user_id,
            "redeemer_address": self.redeemer_address,
            "agent_user_id": self.agent_user_id,
            "seat_id": self.seat_id,
            "approved_scopes": self.approved_scopes,
            "decided_by": self.decided_by,
            "decided_at": _iso(self.decided_at),
            "deny_reason": self.deny_reason,
            "expires_at": _iso(self.expires_at),
            "created_at": _iso(self.created_at),
        }
