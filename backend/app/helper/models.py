"""Local helper (本机助手) tables.

Approved 2026-11-17 (plan decision D6); created by migration j00c20261117
and imported by alembic/env.py and app.main.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class HelperDevice(Base):
    """One paired local helper on one computer. The bearer token itself is never stored."""

    __tablename__ = "helper_devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    device_name: Mapped[str] = mapped_column(String(64), nullable=False)
    platform: Mapped[str] = mapped_column(String(16), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    token_salt: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class HelperCode(Base):
    """Single-use codes issued by a human: kind='pair' (pairing) or kind='join' (join ticket)."""

    __tablename__ = "helper_codes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    owner_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    code_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    code_salt: Mapped[str] = mapped_column(String(32), nullable=False)
    helper_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("helper_devices.id"), nullable=True)
    room_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("rooms.id"), nullable=True)
    agent_key: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    owner_xmtp_address: Mapped[Optional[str]] = mapped_column(String(42), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)


class AgentSeat(Base):
    """One agent's identity inside one room. Re-joining reuses the row (idempotent).

    m1 (l20c20261120): helper_id is nullable so a cloud agent that registers
    through a reusable room invite can hold a seat without a paired helper.
    source='helper' keeps the per-helper uniqueness below; source='invite'
    seats are deduplicated by the partial unique index
    uq_agent_seat_invite on (room_id, agent_user_id) WHERE helper_id IS NULL.
    """

    __tablename__ = "agent_seats"
    __table_args__ = (
        UniqueConstraint("helper_id", "agent_key", "room_id", name="uq_agent_seat_helper_agent_room"),
        Index("ix_agent_seats_room_id", "room_id"),
        Index(
            "uq_agent_seat_invite",
            "room_id",
            "agent_user_id",
            unique=True,
            postgresql_where=text("helper_id IS NULL"),
            sqlite_where=text("helper_id IS NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    helper_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("helper_devices.id"), nullable=True)
    agent_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    room_id: Mapped[str] = mapped_column(String(36), ForeignKey("rooms.id"), nullable=False)
    agent_key: Mapped[str] = mapped_column(String(64), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    xmtp_address: Mapped[str] = mapped_column(String(42), nullable=False)
    group_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    # 'helper' = seat owned by a paired local helper; 'invite' = cloud agent
    # self-registered through a reusable room invite.
    source: Mapped[str] = mapped_column(String(8), nullable=False, default="helper", server_default="helper")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    group_added_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    # Owner-controlled pause: process must stop but the seat row (and its
    # audit/history) stays. Distinct from removed_at — pause never frees the
    # seat's identity.
    paused_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    removed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
