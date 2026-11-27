"""Wire projection for the room owner's create/list invitation responses."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_serializer, field_validator


class RoomInviteView(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    token: str
    room_id: str
    created_by: str
    proposed_scopes: list[str]
    expires_at: datetime | None
    used_at: datetime | None
    redeemed_by_address: str | None
    max_uses: int
    use_count: int
    requires_approval: bool
    role: Literal["member", "viewer"]
    revoked_at: datetime | None
    created_at: datetime | None

    @field_validator("proposed_scopes", mode="before")
    @classmethod
    def default_scopes(cls, value: list[str] | None) -> list[str]:
        return value or []

    @field_serializer("expires_at", "used_at", "revoked_at", "created_at")
    def serialize_timestamp(self, value: datetime | None) -> str | None:
        return value.isoformat() if value else None
