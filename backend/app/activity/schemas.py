"""Wire schemas for the WP4 activity API.

Every inbound model is ``extra="forbid"``: any unexpected key — including
body-carrying fields like ``payload``, ``content``, ``params``,
``params_hash``, ``digest``, ``body``, ``to``, ``subject``, ``text`` or
``message`` — is rejected with 422. The worker's outbound allowlist is
generated from these OpenAPI models.

Checkpoint ``created_at`` stays a raw string: the EIP-191 message
(``"MAPR1-LEDGER-CHECKPOINT " + canonicalJson(payload)``) covers the exact
ISO text the worker emitted, so re-serializing a parsed datetime would
break signature verification whenever the sender used a different
precision.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


_HEAD_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_SIGNATURE_RE = re.compile(r"^0x[0-9a-fA-F]{130}$")

MAX_BATCH = 100
MAX_LIMIT = 200


def parse_iso_datetime(value: str, *, field: str = "created_at") -> datetime:
    """Parse an ISO-8601 timestamp; naive values are treated as UTC."""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        raise ValueError(f"{field} must be an ISO-8601 timestamp") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


class SafeActivityEventIn(_Strict):
    """Whitelist mirror of ``SafeActivityEvent`` in workers activity.ts
    (plus the Hub-only ``app``/``stream_seq`` metadata fields)."""

    id: str = Field(min_length=1, max_length=36)
    room_id: str = Field(min_length=1, max_length=36)
    actor_kind: Literal["human", "agent", "helper", "system"]
    actor_id: str = Field(min_length=1, max_length=128)
    kind: str = Field(min_length=1, max_length=48)
    app: Optional[str] = Field(default=None, max_length=32)
    status: Optional[str] = Field(default=None, max_length=24)
    subject_id: Optional[str] = Field(default=None, max_length=64)
    stream_seq: Optional[int] = Field(default=None, ge=0)
    created_at: datetime


class ActivityEventBatchIn(_Strict):
    events: list[SafeActivityEventIn] = Field(default_factory=list, max_length=MAX_BATCH)


class SignedCheckpointIn(_Strict):
    """Mirror of ``SignedLedgerCheckpoint`` in workers activity.ts.

    ``signer`` is the EIP-191 signer address; ``created_at`` is kept as the
    verbatim signed string so the canonical message can be rebuilt exactly.
    """

    version: Literal[1]
    room_id: str = Field(min_length=1, max_length=36)
    stream_id: str = Field(min_length=1, max_length=64)
    head_seq: int = Field(ge=0)
    head_hash: str
    entry_count: int = Field(ge=0)
    created_at: str = Field(min_length=1, max_length=64)
    signer: str = Field(min_length=42, max_length=42)
    signature: str = Field(min_length=132, max_length=132)

    @field_validator("head_hash")
    @classmethod
    def _check_hash(cls, v: str) -> str:
        if not _HEAD_HASH_RE.match(v):
            raise ValueError("head_hash must be 64 lowercase hex chars")
        return v

    @field_validator("signer")
    @classmethod
    def _check_signer(cls, v: str) -> str:
        if not _ADDRESS_RE.match(v):
            raise ValueError("signer must be a 0x-prefixed address")
        return v

    @field_validator("signature")
    @classmethod
    def _check_signature(cls, v: str) -> str:
        if not _SIGNATURE_RE.match(v):
            raise ValueError("signature must be 0x-prefixed 65-byte hex")
        return v

    @field_validator("created_at")
    @classmethod
    def _check_created_at(cls, v: str) -> str:
        parse_iso_datetime(v)
        return v

    def signed_payload(self) -> dict:
        """The exact object the worker canonicalized before signing."""
        return {
            "version": self.version,
            "room_id": self.room_id,
            "stream_id": self.stream_id,
            "head_seq": self.head_seq,
            "head_hash": self.head_hash,
            "entry_count": self.entry_count,
            "created_at": self.created_at,
        }

    def checkpoint_at(self) -> datetime:
        return parse_iso_datetime(self.created_at)


class CheckpointBatchIn(_Strict):
    checkpoints: list[SignedCheckpointIn] = Field(
        default_factory=list, max_length=MAX_BATCH
    )


class IngestResult(_Strict):
    accepted: int
    duplicates: int


class ActivityItem(_Strict):
    id: str
    source: str  # "activity" | "task_event" | "approval"
    actor_kind: Optional[str]
    actor_id: Optional[str]
    kind: str
    app: Optional[str] = None
    status: Optional[str] = None
    subject_id: Optional[str] = None
    stream_seq: Optional[int] = None
    reported_by: Optional[str] = None
    created_at: Optional[str] = None
    # Only populated for Hub-cleartext (non-XMTP) rooms — see service.py.
    title: Optional[str] = None


class CheckpointView(_Strict):
    id: str
    stream_id: str
    signer_address: str
    head_seq: int
    head_hash: str
    entry_count: int
    signature: str
    reported_by: Optional[str] = None
    checkpoint_at: str
    created_at: str


class ActivityFeed(_Strict):
    room_id: str
    items: list[ActivityItem]
    checkpoints: list[CheckpointView]
    count: int
