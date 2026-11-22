"""Single-use EIP-191 challenge nonces (m1 / WP6).

``redeem``, ``agent-register`` and ``members/me/xmtp-address`` all prove
ownership of an XMTP/EVM address by signing a domain-separated server message.
The nonce row makes that proof single-use and restart-safe: consumption is one
conditional ``UPDATE ... WHERE consumed_at IS NULL AND expires_at > now``
checked by rowcount, never a read-then-write.

The signed message itself is rebuilt from THIS row at verify time, so every
field an attacker could vary (action, resource, address, expiry) is bound
server-side before the signature is recovered.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

NONCE_ACTIONS = ("invite-redeem", "invite-agent-register", "bind-address")


class XmtpAuthNonce(Base):
    __tablename__ = "xmtp_auth_nonces"
    __table_args__ = (
        Index("ix_xmtp_auth_nonces_expires", "expires_at"),
    )

    nonce: Mapped[str] = mapped_column(String(64), primary_key=True)
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    # The object the proof binds to: invite token for invite actions, room id
    # for bind-address.
    resource: Mapped[str] = mapped_column(String(128), nullable=False)
    address: Mapped[str] = mapped_column(String(42), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
