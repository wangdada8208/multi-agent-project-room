import uuid
from datetime import datetime, timedelta, timezone
import pytest
from sqlalchemy import select

from app.models.room import Room
from app.models.room_invite import RoomInvite


async def _register(client, username: str) -> dict[str, str]:
    resp = await client.post(
        "/api/v1/auth/register",
        json={"username": username, "password": "secret123", "display_name": username},
    )
    assert resp.status_code in (200, 201), resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _create_test_room(client, auth_headers, name="邀请测试房间") -> str:
    created = await client.post(
        "/api/v1/rooms",
        headers=auth_headers,
        json={"name": name, "description": "测试邀请系统"},
    )
    assert created.status_code == 200, created.text
    room_id = created.json()["room"]["id"]

    # Bind xmtp group id
    bind_resp = await client.post(
        f"/api/v1/rooms/{room_id}/xmtp-binding",
        headers=auth_headers,
        json={"xmtp_group_id": "test-group-id-12345"},
    )
    assert bind_resp.status_code == 200, bind_resp.text
    return room_id


@pytest.mark.asyncio
async def test_owner_can_create_and_list_invite(client, auth_headers):
    room_id = await _create_test_room(client, auth_headers)

    create_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={
            "proposed_scopes": ["calendar.free_busy", "task.run"],
            "expires_hours": 12,
        },
    )
    assert create_resp.status_code == 200, create_resp.text
    invite = create_resp.json()["invite"]
    assert invite["room_id"] == room_id
    assert invite["proposed_scopes"] == ["calendar.free_busy", "task.run"]
    assert invite["used_at"] is None
    assert len(invite["token"]) > 20

    # List room invites
    list_resp = await client.get(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
    )
    assert list_resp.status_code == 200, list_resp.text
    invites = list_resp.json()["invites"]
    assert len(invites) == 1
    assert invites[0]["token"] == invite["token"]


@pytest.mark.asyncio
async def test_non_owner_cannot_create_invite(client, auth_headers):
    room_id = await _create_test_room(client, auth_headers)

    # Register another user
    other_headers = await _register(client, "other_user_invites")

    # Invite user as member
    await client.post(
        f"/api/v1/rooms/{room_id}/invite",
        headers=auth_headers,
        json={"username": "other_user_invites", "role": "member"},
    )

    resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=other_headers,
        json={"proposed_scopes": ["calendar.free_busy"]},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_redeem_invite_success(client, auth_headers):
    room_id = await _create_test_room(client, auth_headers)

    create_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": ["calendar.free_busy"]},
    )
    token = create_resp.json()["invite"]["token"]

    # Public check endpoint
    info_resp = await client.get(f"/api/v1/invites/{token}")
    assert info_resp.status_code == 200
    assert info_resp.json()["token"] == token
    assert info_resp.json()["room_id"] == room_id

    # Redeem with agent xmtp address
    agent_addr = "0x2222222222222222222222222222222222222222"
    redeem_resp = await client.post(
        f"/api/v1/invites/{token}/redeem",
        json={"xmtp_address": agent_addr},
    )
    assert redeem_resp.status_code == 200, redeem_resp.text
    data = redeem_resp.json()
    assert data["room_id"] == room_id
    assert data["xmtp_group_id"] == "test-group-id-12345"
    assert data["proposed_scopes"] == ["calendar.free_busy"]
    assert "redeemed_at" in data


@pytest.mark.asyncio
async def test_redeem_invite_duplicate_conflict_409(client, auth_headers):
    room_id = await _create_test_room(client, auth_headers)

    create_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": ["calendar.free_busy"]},
    )
    token = create_resp.json()["invite"]["token"]

    agent_addr = "0x3333333333333333333333333333333333333333"
    r1 = await client.post(
        f"/api/v1/invites/{token}/redeem",
        json={"xmtp_address": agent_addr},
    )
    assert r1.status_code == 200

    # Second redemption of same token must be 409
    r2 = await client.post(
        f"/api/v1/invites/{token}/redeem",
        json={"xmtp_address": agent_addr},
    )
    assert r2.status_code == 409
    assert "already redeemed" in r2.json()["detail"].lower()


@pytest.mark.asyncio
async def test_redeem_invite_expired_410(client, auth_headers):
    room_id = await _create_test_room(client, auth_headers)

    create_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": ["calendar.free_busy"]},
    )
    token = create_resp.json()["invite"]["token"]

    # Directly expire the token in database
    from app.core.database import get_db
    from app.main import app

    async for db in app.dependency_overrides[get_db]():
        invite = await db.get(RoomInvite, token)
        invite.expires_at = datetime.now(timezone.utc) - timedelta(hours=1)
        db.add(invite)
        await db.commit()
        break

    agent_addr = "0x4444444444444444444444444444444444444444"
    resp = await client.post(
        f"/api/v1/invites/{token}/redeem",
        json={"xmtp_address": agent_addr},
    )
    assert resp.status_code == 410
    assert "expired" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_redeem_nonexistent_invite_404(client):
    resp = await client.post(
        "/api/v1/invites/nonexistent-token-xyz/redeem",
        json={"xmtp_address": "0x5555555555555555555555555555555555555555"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_redeem_invalid_address_422(client, auth_headers):
    room_id = await _create_test_room(client, auth_headers)

    create_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": []},
    )
    token = create_resp.json()["invite"]["token"]

    resp = await client.post(
        f"/api/v1/invites/{token}/redeem",
        json={"xmtp_address": "not-an-address"},
    )
    assert resp.status_code == 422
