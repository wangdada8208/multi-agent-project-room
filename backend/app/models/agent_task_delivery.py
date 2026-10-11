"""Delivery metadata only. A task ID always references an actual A2ATask."""
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Integer, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base

class AgentTaskDelivery(Base):
    __tablename__ = "agent_task_deliveries"
    __table_args__ = (UniqueConstraint("task_id", name="uq_agent_delivery_task"),)
    delivery_id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    task_id: Mapped[str] = mapped_column(String(36), ForeignKey("a2a_tasks.id", ondelete="CASCADE"), nullable=False)
    message_id: Mapped[str] = mapped_column(String(36), nullable=False)
    agent_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    target_room: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[str] = mapped_column(String(24), nullable=False, default="pending", index=True)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lease_owner: Mapped[str | None] = mapped_column(String(36), nullable=True)
    ack_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    canceled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
