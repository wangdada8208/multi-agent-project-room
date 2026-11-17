"""Wire format between Hub, website and local helper.

Field names must match workers/xmtp-member/src/helper/types.ts and frontend/src/lib/localHelper.ts.
"""
from __future__ import annotations

import re
from typing import Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

AgentKind = Literal["claude-code", "codex", "gemini-cli", "openai-compatible", "webhook", "http-model"]
GroupStatus = Literal["pending", "added", "removed"]
SeatStatus = Literal["starting", "running", "crashed", "stopped", "revoked"]

_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_AGENT_KEY = re.compile(r"^(claude-code|codex|gemini-cli|manual:[0-9a-f-]{36})$")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _address(value: str) -> str:
    if not _ADDRESS.match(value):
        raise ValueError("invalid address")
    return value.lower()


def _agent_key(value: str) -> str:
    if not _AGENT_KEY.match(value):
        raise ValueError("invalid agent_key")
    return value


# ── human (logged-in website user) ──

class PairingCodeResponse(_Strict):
    code: str
    expires_at: str
    install_command: str


class JoinTicketRequest(_Strict):
    room_id: str = Field(min_length=1, max_length=36)
    agent_key: str = Field(max_length=64)
    owner_xmtp_address: str

    _check_key = field_validator("agent_key")(_agent_key)
    _check_address = field_validator("owner_xmtp_address")(_address)


class JoinTicketResponse(_Strict):
    ticket: str
    expires_at: str


class HelperDeviceView(_Strict):
    id: str
    device_name: str
    platform: str
    created_at: str
    last_seen_at: Optional[str]
    revoked: bool


class SeatView(_Strict):
    seat_id: str
    room_id: str
    agent_user_id: str
    agent_display_name: str
    owner_user_id: str
    kind: AgentKind
    xmtp_address: str
    group_status: GroupStatus


# ── helper (Bearer helper token) ──

class PairRequest(_Strict):
    code: SecretStr
    device_name: str = Field(min_length=1, max_length=64)
    platform: Literal["darwin", "linux", "win32"]


class PairResponse(_Strict):
    helper_id: str
    helper_token: str
    owner_user_id: str
    owner_display_name: str


class HubRoom(_Strict):
    id: str
    name: str
    xmtp_group_id: Optional[str]
    role: Literal["owner", "member", "viewer"]


class _SeatCommon(_Strict):
    agent_key: str = Field(max_length=64)
    kind: AgentKind
    display_name: str = Field(min_length=1, max_length=64)
    xmtp_address: str

    _check_key = field_validator("agent_key")(_agent_key)
    _check_address = field_validator("xmtp_address")(_address)


class CreateSeatViaTicket(_SeatCommon):
    via: Literal["ticket"]
    ticket: SecretStr


class CreateSeatViaLocal(_SeatCommon):
    via: Literal["local"]
    room_id: str = Field(min_length=1, max_length=36)


CreateSeatRequest = Union[CreateSeatViaTicket, CreateSeatViaLocal]


class SeatGrant(_Strict):
    seat_id: str
    room_id: str
    room_name: str
    agent_user_id: str
    agent_username: str
    agent_token: str
    xmtp_group_id: Optional[str]
    allowed_senders: list[str]


class SeatStatusResponse(_Strict):
    xmtp_group_id: Optional[str]
    group_status: GroupStatus


class HeartbeatAgent(_Strict):
    key: str = Field(max_length=64)
    kind: str = Field(max_length=32)
    version: Optional[str] = Field(default=None, max_length=64)


class HeartbeatSeat(_Strict):
    seat_id: str
    status: SeatStatus


class HeartbeatRequest(_Strict):
    agents: list[HeartbeatAgent] = Field(default_factory=list, max_length=32)
    seats: list[HeartbeatSeat] = Field(default_factory=list, max_length=256)


class HeartbeatResponse(_Strict):
    revoked: bool
    seats_to_stop: list[str]
