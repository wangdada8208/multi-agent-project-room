import pytest
from app.models.room import Room


def test_room_transport_defaults_to_hub():
    room = Room(name="旧房间")
    assert room.transport == "hub"
    assert room.xmtp_group_id is None
    payload = room.to_dict()
    assert payload["transport"] == "hub"
    assert payload["xmtp_group_id"] is None
    assert "wallet" not in payload
    assert "key" not in payload
