import uuid

import pytest

from app.models.room import Room
from app.models.room_permission import RoomPermission


async def _register(client, username: str) -> dict[str, str]:
    resp = await client.post(
        "/api/v1/auth/register",
        json={"username": username, "password": "secret123", "display_name": username},
    )
    assert resp.status_code in (200, 201), resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _room_with_member(client, auth_headers):
    created = await client.post(
        "/api/v1/rooms", headers=auth_headers, json={"name": "绑定守卫", "description": ""}
    )
    room_id = created.json()["room"]["id"]
    member_headers = await _register(client, "member_bind")
    invited = await client.post(
        f"/api/v1/rooms/{room_id}/invite",
        headers=auth_headers,
        json={"username": "member_bind", "role": "member"},
    )
    assert invited.status_code == 200, invited.text
    return room_id, member_headers


@pytest.mark.asyncio
async def test_member_cannot_bind_group(client, auth_headers):
    room_id, member_headers = await _room_with_member(client, auth_headers)
    resp = await client.post(
        f"/api/v1/rooms/{room_id}/xmtp-binding",
        headers=member_headers,
        json={"xmtp_group_id": "group-attacker"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_owner_cannot_rebind_to_another_group(client, auth_headers):
    room_id, _ = await _room_with_member(client, auth_headers)
    first = await client.post(
        f"/api/v1/rooms/{room_id}/xmtp-binding",
        headers=auth_headers,
        json={"xmtp_group_id": "group-first"},
    )
    assert first.status_code == 200
    again = await client.post(
        f"/api/v1/rooms/{room_id}/xmtp-binding",
        headers=auth_headers,
        json={"xmtp_group_id": "group-first"},
    )
    assert again.status_code == 200
    assert again.json()["xmtp_group_id"] == "group-first"
    other = await client.post(
        f"/api/v1/rooms/{room_id}/xmtp-binding",
        headers=auth_headers,
        json={"xmtp_group_id": "group-second"},
    )
    assert other.status_code == 409
    room = await client.get(f"/api/v1/rooms/{room_id}", headers=auth_headers)
    assert room.json()["room"]["xmtp_group_id"] == "group-first"


@pytest.mark.asyncio
async def test_hub_room_cannot_be_flipped_to_xmtp(client, auth_headers, db):
    me = await client.get("/api/v1/auth/me", headers=auth_headers)
    user_id = me.json()["user"]["id"]
    room_id = str(uuid.uuid4())
    db.add(Room(id=room_id, name="旧明文", transport="hub", created_by=user_id))
    db.add(RoomPermission(room_id=room_id, user_id=user_id, role="owner"))
    await db.commit()
    resp = await client.post(
        f"/api/v1/rooms/{room_id}/xmtp-binding",
        headers=auth_headers,
        json={"xmtp_group_id": "group-x"},
    )
    assert resp.status_code == 409
