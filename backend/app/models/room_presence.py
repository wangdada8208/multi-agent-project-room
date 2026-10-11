"""Per-connection owner-fenced leases; DB clock is the global presence authority."""
from sqlalchemy import String, DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime
from app.core.database import Base


class RoomPresence(Base):
    __tablename__ = "room_presences"
    __table_args__ = (Index("ix_presence_room_user", "room_id", "user_id"),
                      Index("ix_presence_expiry", "lease_until"))
    connection_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    room_id: Mapped[str] = mapped_column(String(36), ForeignKey("rooms.id", ondelete="CASCADE"))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    hub_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    lease_until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
