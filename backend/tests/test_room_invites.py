import uuid
from datetime import datetime, timedelta, timezone
import pytest
from sqlalchemy import select

from conftest import engine as _test_engine
from _signing import new_wallet, redeem_signed
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

    # Redeem with a signed agent xmtp address
    wallet = new_wallet()
    redeem_resp = await redeem_signed(client, token, wallet)
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

    wallet = new_wallet()
    r1 = await redeem_signed(client, token, wallet)
    assert r1.status_code == 200

    # Same address re-redeeming (e.g. page reload while waiting for owner sync) is idempotent (200)
    r_retry = await redeem_signed(client, token, wallet)
    assert r_retry.status_code == 200

    # Second redemption of same token by a different address must be 409
    r2 = await redeem_signed(client, token, new_wallet())
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

    resp = await redeem_signed(client, token, new_wallet())
    assert resp.status_code == 410
    assert "expired" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_redeem_nonexistent_invite_404(client):
    resp = await redeem_signed(client, "nonexistent-token-xyz", new_wallet())
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
        json={"xmtp_address": "not-an-address", "nonce": "n", "signature": "0x" + "0" * 130},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_invite_multi_use_bounds(client, auth_headers):
    """WP6: max_uses 1..32 is accepted; out-of-range is rejected, never
    silently clamped into a token the caller misreads."""
    room_id = await _create_test_room(client, auth_headers)

    rejected = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": [], "max_uses": 33},
    )
    assert rejected.status_code == 422

    rejected0 = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": [], "max_uses": 0},
    )
    assert rejected0.status_code == 422

    ok = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": [], "max_uses": 5},
    )
    assert ok.status_code == 200
    assert ok.json()["invite"]["max_uses"] == 5
    assert ok.json()["invite"]["use_count"] == 0


@pytest.mark.asyncio
async def test_create_invite_rejects_owner_role_and_forbidden_scopes(client, auth_headers):
    room_id = await _create_test_room(client, auth_headers)

    role_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": [], "role": "owner"},
    )
    assert role_resp.status_code == 422

    for bad_scope in ("payment.send", "wallet.sign", "data.export_all", "banking.wire"):
        resp = await client.post(
            f"/api/v1/rooms/{room_id}/invites",
            headers=auth_headers,
            json={"proposed_scopes": [bad_scope]},
        )
        assert resp.status_code == 422, bad_scope


@pytest.mark.asyncio
async def test_owner_revokes_unredeemed_invite(client, auth_headers):
    room_id = await _create_test_room(client, auth_headers)
    create_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": []},
    )
    token = create_resp.json()["invite"]["token"]

    revoked = await client.delete(
        f"/api/v1/rooms/{room_id}/invites/{token}", headers=auth_headers
    )
    assert revoked.status_code == 200

    # m1: revocation sets revoked_at and keeps the row for audit — public
    # info and redeem now answer 410 (gone), not 404.
    info = await client.get(f"/api/v1/invites/{token}")
    assert info.status_code == 410

    redeem = await redeem_signed(client, token, new_wallet())
    assert redeem.status_code == 410


@pytest.mark.asyncio
async def test_revoke_redeemed_invite_keeps_audit_record(client, auth_headers):
    room_id = await _create_test_room(client, auth_headers)
    create_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": []},
    )
    token = create_resp.json()["invite"]["token"]
    redeem = await redeem_signed(client, token, new_wallet())
    assert redeem.status_code == 200

    revoked = await client.delete(
        f"/api/v1/rooms/{room_id}/invites/{token}", headers=auth_headers
    )
    assert revoked.status_code == 409


@pytest.mark.asyncio
async def test_non_owner_cannot_revoke_invite(client, auth_headers):
    room_id = await _create_test_room(client, auth_headers)
    create_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": []},
    )
    token = create_resp.json()["invite"]["token"]

    member_headers = await _register(client, "member_revoker")
    await client.post(
        f"/api/v1/rooms/{room_id}/invite",
        headers=auth_headers,
        json={"username": "member_revoker", "role": "member"},
    )
    revoked = await client.delete(
        f"/api/v1/rooms/{room_id}/invites/{token}", headers=member_headers
    )
    assert revoked.status_code == 403


@pytest.mark.skipif(
    _test_engine.dialect.name != "postgresql",
    reason="true concurrent claim requires real PostgreSQL row locking",
)
@pytest.mark.asyncio
async def test_redeem_invite_concurrent_single_winner(client, auth_headers):
    """Two overlapping redeems of the same token must produce exactly one 200."""
    import asyncio

    room_id = await _create_test_room(client, auth_headers)
    create_resp = await client.post(
        f"/api/v1/rooms/{room_id}/invites",
        headers=auth_headers,
        json={"proposed_scopes": ["calendar.free_busy"]},
    )
    token = create_resp.json()["invite"]["token"]

    async def redeem(account):
        return await redeem_signed(client, token, account)

    r1, r2 = await asyncio.gather(redeem(new_wallet()), redeem(new_wallet()))
    statuses = sorted([r1.status_code, r2.status_code])
    assert statuses == [200, 409], f"{r1.status_code}/{r2.status_code}"
