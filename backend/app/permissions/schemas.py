"""Wire projections for the existing room-permission responses."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator


class RoomPermissionView(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    room_id: str
    user_id: str
    role: str
    invited_by: str | None
    xmtp_address: str | None
    created_at: str

    @field_validator("created_at", mode="before")
    @classmethod
    def serialize_created_at(cls, value: datetime | str) -> str:
        return value.isoformat() if isinstance(value, datetime) else value


class RoomPermissionMember(RoomPermissionView):
    username: str
    display_name: str
    avatar_url: str | None
    user_type: str
