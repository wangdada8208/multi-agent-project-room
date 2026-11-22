"""Tests for collaborator invite acceptance (/accept), idempotent /redeem, and agent display_name sync."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.core.database import get_db
from app.main import app
from app.models.room_invite import RoomInvite

from _signing import new_wallet, redeem_signed


ADDR_COLLAB_1 = "0x" + "1a" * 20
ADDR_COLLAB_2 = "0x" + "2b" * 20
ADDR_SEAT = "0x" + "3c" * 20


async def _register(client, username: str, display_name: str | None = None) -> dict[str, str]:
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": "secret123",
            "display_name": display_name or username,
        },
    )
    assert resp.status_code in (200, 201), resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _create_xmtp_room(client, owner_headers: dict[str, str], name: str = "加密协作房") -> str:
    created = await client.post(
        "/api/v1/rooms",
        headers=owner_headers,
        json={"name": name, "description": "Collaborator invite test", "transport": "xmtp"},
    )
    assert created.status_code == 200, created.text
    room_id = created.json()["room"]["id"]
    bind = await client.post(
        f"/api/v1/rooms/{room_id}/xmtp-binding",
        headers=owner_headers,
        json={"xmtp_group_id": "group-collab-123"},
    )
    assert bind.status_code == 200, bind.text
    return room_id


@pytest.mark.asyncio
async def test_accept_grants_room_access_without_consuming_redeem_and_is_idempotent(client):
    owner_headers = await _register(client, "collab_owner", "Owner")
    collab_headers = await _register(client, "collab_bob", "Bob")
    outsider_headers = await _register(client, "collab_eve", "Eve")

    room_id = await _create_xmtp_room(client, owner_headers)

    # Before accepting invite, Bob cannot read the room
    denied = await client.get(f"/api/v1/rooms/{room_id}", headers=collab_headers)
    assert denied.status_code == 403

    inv_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=owner_headers,
        json={"proposed_scopes": [], "expires_hours": 24},
    )
    assert inv_resp.status_code == 200
    token = inv_resp.json()["invite"]["token"]

    # Unauthenticated /accept -> 401
    unauth = await client.post(f"/api/v1/invites/{token}/accept")
    assert unauth.status_code == 401

    # Bob accepts invite -> receives member permission
    acc1 = await client.post(f"/api/v1/invites/{token}/accept", headers=collab_headers)
    assert acc1.status_code == 200, acc1.text
    assert acc1.json() == {"room_id": room_id, "role": "member"}

    # GET /api/v1/rooms/{id} now succeeds for Bob
    room_get = await client.get(f"/api/v1/rooms/{room_id}", headers=collab_headers)
    assert room_get.status_code == 200, room_get.text
    assert room_get.json()["room"]["id"] == room_id

    # Invite used_at is NOT set yet so Bob's browser can still call /redeem after unlocking XMTP
    info = await client.get(f"/api/v1/invites/{token}")
    assert info.status_code == 200

    # Bob unlocks XMTP and calls /redeem with an EIP-191 signed address proof
    bob_wallet = new_wallet()
    red1 = await redeem_signed(client, token, bob_wallet, headers=collab_headers)
    assert red1.status_code == 200, red1.text
    assert red1.json()["room_id"] == room_id
    assert red1.json()["xmtp_group_id"] == "group-collab-123"

    # Owner's invite list records lowercase redeemed_by_address
    listed = await client.get(f"/api/v1/rooms/{room_id}/invites", headers=owner_headers)
    assert listed.status_code == 200
    assert listed.json()["invites"][0]["redeemed_by_address"] == bob_wallet.address.lower()
    assert listed.json()["invites"][0]["used_at"] is not None

    # Re-calling /accept by Bob (already has RoomPermission) still returns 200 even after used_at is set
    acc2 = await client.post(f"/api/v1/invites/{token}/accept", headers=collab_headers)
    assert acc2.status_code == 200
    assert acc2.json() == {"room_id": room_id, "role": "member"}

    # Outsider calling /accept after token was redeemed gets 409
    eve_acc = await client.post(f"/api/v1/invites/{token}/accept", headers=outsider_headers)
    assert eve_acc.status_code == 409

    # Idempotent /redeem with the SAME signed address returns 200 OK
    red_same = await redeem_signed(client, token, bob_wallet)
    assert red_same.status_code == 200, red_same.text
    assert red_same.json()["room_id"] == room_id
    assert red_same.json()["xmtp_group_id"] == "group-collab-123"

    # Second DISTINCT signed address returns 409 Conflict (and never grants Eve access)
    red_diff = await redeem_signed(client, token, new_wallet(), headers=outsider_headers)
    assert red_diff.status_code == 409
    assert (await client.get(f"/api/v1/rooms/{room_id}", headers=outsider_headers)).status_code == 403


@pytest.mark.asyncio
async def test_redeem_with_optional_bearer_grants_room_permission_and_expired_410(client):
    owner_headers = await _register(client, "collab_owner2", "Owner 2")
    collab_headers = await _register(client, "collab_carol", "Carol")

    room_id = await _create_xmtp_room(client, owner_headers)
    inv_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=owner_headers,
        json={"proposed_scopes": [], "expires_hours": 24},
    )
    token = inv_resp.json()["invite"]["token"]

    # Carol calls /redeem directly with her Bearer token (without calling /accept first)
    carol_wallet = new_wallet()
    red = await redeem_signed(client, token, carol_wallet, headers=collab_headers)
    assert red.status_code == 200, red.text

    # Carol now has member access to GET /api/v1/rooms/{room_id}
    room_resp = await client.get(f"/api/v1/rooms/{room_id}", headers=collab_headers)
    assert room_resp.status_code == 200

    # Expire the token and verify both /accept and /redeem return 410
    async for session in app.dependency_overrides[get_db]():
        inv = await session.get(RoomInvite, token)
        inv.expires_at = datetime.now(timezone.utc) - timedelta(minutes=5)
        session.add(inv)
        await session.commit()
        break

    assert (await client.post(f"/api/v1/invites/{token}/accept", headers=collab_headers)).status_code == 410
    # Carol's consumed redemption stays idempotent (200), but a NEW address
    # cannot redeem an expired token → 410.
    assert (await redeem_signed(client, token, carol_wallet)).status_code == 200
    assert (await redeem_signed(client, token, new_wallet())).status_code == 410
    assert (await client.post("/api/v1/invites/missing-token/accept", headers=collab_headers)).status_code == 404


@pytest.mark.asyncio
async def test_helper_seat_updates_agent_display_name_on_rename(client):
    owner_headers = await _register(client, "rename_owner", "Rename Owner")
    room_id = await _create_xmtp_room(client, owner_headers)

    code = (await client.post("/api/v1/helpers/pairing-codes", headers=owner_headers)).json()["code"]
    paired = (
        await client.post(
            "/api/v1/helpers/pair",
            json={"code": code, "device_name": "dev-box", "platform": "darwin"},
        )
    ).json()
    helper_headers = {"Authorization": f"Bearer {paired['helper_token']}"}
    manual_key = "manual:11111111-2222-3333-4444-555555555555"

    s1 = await client.post(
        "/api/v1/helpers/me/seats",
        headers=helper_headers,
        json={
            "via": "local",
            "room_id": room_id,
            "agent_key": manual_key,
            "kind": "openai-compatible",
            "display_name": "Grok Old",
            "xmtp_address": ADDR_SEAT,
        },
    )
    assert s1.status_code == 201, s1.text

    s2 = await client.post(
        "/api/v1/helpers/me/seats",
        headers=helper_headers,
        json={
            "via": "local",
            "room_id": room_id,
            "agent_key": manual_key,
            "kind": "openai-compatible",
            "display_name": "Grok Renamed",
            "xmtp_address": ADDR_SEAT,
        },
    )
    assert s2.status_code == 201, s2.text

    seats = (await client.get(f"/api/v1/rooms/{room_id}/seats", headers=owner_headers)).json()
    assert len(seats) == 1
    assert seats[0]["agent_display_name"] == "Grok Renamed"
