"""Room permission model for role-based access control."""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import String, DateTime, ForeignKey, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base


class RoomPermission(Base):
    __tablename__ = "room_permissions"
    __table_args__ = (
        UniqueConstraint("room_id", "user_id", name="uq_room_user"),
        Index("ix_room_permissions_xmtp", "room_id", "xmtp_address"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    room_id: Mapped[str] = mapped_column(String(36), ForeignKey("rooms.id"), nullable=False)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="member")  # "owner" | "member" | "viewer"
    invited_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    # EIP-191 verified XMTP/EVM address of this member (m1). Lets the room
    # owner remove the address from the XMTP group BEFORE deleting this row.
    xmtp_address: Mapped[Optional[str]] = mapped_column(String(42), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "room_id": self.room_id,
            "user_id": self.user_id,
            "role": self.role,
            "invited_by": self.invited_by,
            "xmtp_address": self.xmtp_address,
            "created_at": self.created_at.isoformat(),
        }
