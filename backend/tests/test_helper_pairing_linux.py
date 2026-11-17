"""WP3 pairing lifecycle: single use, expiry, issue limit, revocation, S6 log hygiene.

Only synthetic users and in-process requests; no external transport.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.core.security import create_access_token
from app.helper.models import HelperCode, HelperDevice
from app.models.user import User

BASE = "/api/v1/helpers"


def headers(user):
    return {"Authorization": "Bearer " + create_access_token(user.id, user.user_type)}


@pytest_asyncio.fixture
async def owner(db):
    user = User(username="helperowner", display_name="Helper Owner", user_type="human")
    db.add(user)
    await db.commit()
    return user


@pytest_asyncio.fixture
async def other(db):
    user = User(username="otherhuman", display_name="Other Human", user_type="human")
    db.add(user)
    await db.commit()
    return user


async def _issue_code(client, owner):
    resp = await client.post(f"{BASE}/pairing-codes", headers=headers(owner))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _pair(client, code, device="dev"):
    return await client.post(f"{BASE}/pair",
                             json={"code": code, "device_name": device, "platform": "linux"})


@pytest.mark.asyncio
async def test_pairing_code_happy_path_and_storage(client, db, owner):
    data = await _issue_code(client, owner)
    assert data["code"].startswith("mpc_")
    assert data["code"] in data["install_command"]
    assert "install.sh" in data["install_command"]

    resp = await _pair(client, data["code"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["helper_token"].startswith("mhp_")
    assert body["owner_user_id"] == owner.id
    assert body["owner_display_name"] == owner.display_name
    assert resp.headers["cache-control"] == "no-store"

    # Only salted hashes may be stored; the presented values never are.
    record = (await db.execute(select(HelperCode).where(
        HelperCode.owner_user_id == owner.id))).scalar_one()
    assert data["code"] not in str(record.__dict__)
    device = (await db.execute(select(HelperDevice).where(
        HelperDevice.owner_user_id == owner.id))).scalar_one()
    assert body["helper_token"] not in str(device.__dict__)

    helper_headers = {"Authorization": f"Bearer {body['helper_token']}"}
    rooms = await client.get(f"{BASE}/me/rooms", headers=helper_headers)
    assert rooms.status_code == 200 and rooms.json() == []
    listing = (await client.get(BASE, headers=headers(owner))).json()
    assert listing[0]["device_name"] == "dev" and listing[0]["revoked"] is False


@pytest.mark.asyncio
async def test_pairing_code_single_use_and_concurrent_claim(client, db, owner):
    own_devices = select(HelperDevice).where(HelperDevice.owner_user_id == owner.id)
    data = await _issue_code(client, owner)
    assert (await _pair(client, data["code"])).status_code == 200
    assert (await _pair(client, data["code"])).status_code == 409
    assert len((await db.execute(own_devices)).scalars().all()) == 1

    fresh = await _issue_code(client, owner)
    first, second = await asyncio.gather(_pair(client, fresh["code"]), _pair(client, fresh["code"]))
    assert sorted(r.status_code for r in (first, second)) == [200, 409]
    assert len((await db.execute(own_devices)).scalars().all()) == 2


@pytest.mark.asyncio
async def test_pairing_code_expiry_and_rejection_variants(client, db, owner):
    data = await _issue_code(client, owner)
    row_id = data["code"].split(".")[0][len("mpc_"):]
    record = await db.get(HelperCode, row_id)
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()
    assert (await _pair(client, data["code"])).status_code == 409

    fresh = await _issue_code(client, owner)
    bad = fresh["code"][:-1] + ("a" if fresh["code"][-1] != "a" else "b")
    assert (await _pair(client, bad)).status_code == 409
    assert (await _pair(client, "not-a-code")).status_code == 409
    assert (await _pair(client, "mpc_missing.deadbeef")).status_code == 409


@pytest.mark.asyncio
async def test_pairing_code_issue_limit(client, db, owner):
    for _ in range(10):
        resp = await client.post(f"{BASE}/pairing-codes", headers=headers(owner))
        assert resp.status_code == 201
    assert (await client.post(f"{BASE}/pairing-codes", headers=headers(owner))).status_code == 429


@pytest.mark.asyncio
async def test_revoked_helper_401_and_heartbeat_reports_revoked(client, db, owner):
    data = await _issue_code(client, owner)
    paired = (await _pair(client, data["code"])).json()
    helper_headers = {"Authorization": f"Bearer {paired['helper_token']}"}

    assert (await client.delete(f"{BASE}/{paired['helper_id']}", headers=headers(owner))).status_code == 204
    # strict helper endpoints now refuse the token
    assert (await client.get(f"{BASE}/me/rooms", headers=helper_headers)).status_code == 401
    assert (await client.post(f"{BASE}/me/seats", headers=helper_headers,
                              json={"via": "local", "room_id": "r", "agent_key": "codex",
                                    "kind": "codex", "display_name": "d",
                                    "xmtp_address": "0x" + "a" * 40})).status_code == 401
    # heartbeat still answers so the helper learns it was revoked
    beat = await client.post(f"{BASE}/me/heartbeat", headers=helper_headers,
                             json={"agents": [], "seats": []})
    assert beat.status_code == 200 and beat.json() == {"revoked": True, "seats_to_stop": []}
    assert (await client.get(BASE, headers=headers(owner))).json()[0]["revoked"] is True


@pytest.mark.asyncio
async def test_helper_auth_and_human_only_boundaries(client, db, owner, other):
    assert (await client.get(f"{BASE}/me/rooms")).status_code == 401
    assert (await client.get(f"{BASE}/me/rooms",
                             headers={"Authorization": "Bearer mhp_nope.nope"})).status_code == 401
    # a human access token is not a helper token
    assert (await client.get(f"{BASE}/me/rooms", headers=headers(owner))).status_code == 401

    data = await _issue_code(client, owner)
    paired = (await _pair(client, data["code"])).json()
    # another human cannot see or revoke the device
    assert (await client.delete(f"{BASE}/{paired['helper_id']}", headers=headers(other))).status_code == 404
    assert (await client.get(BASE, headers=headers(other))).json() == []

    # human endpoints reject agent accounts
    agent = User(username="robotacct", display_name="Bot", user_type="agent")
    db.add(agent)
    await db.commit()
    assert (await client.post(f"{BASE}/pairing-codes", headers=headers(agent))).status_code == 403
    assert (await client.get(BASE, headers=headers(agent))).status_code == 403

    # an inactive owner invalidates the helper token
    owner.is_active = False
    await db.commit()
    deny = await client.get(f"{BASE}/me/rooms",
                            headers={"Authorization": f"Bearer {paired['helper_token']}"})
    assert deny.status_code == 401


@pytest.mark.asyncio
async def test_no_secrets_in_logs_or_error_responses(client, db, owner, caplog):
    data = await _issue_code(client, owner)
    assert (await _pair(client, data["code"] + "corrupt")).status_code == 409
    resp = await _pair(client, data["code"])
    assert resp.status_code == 200
    token = resp.json()["helper_token"]
    record = (await db.execute(select(HelperCode).where(
        HelperCode.owner_user_id == owner.id))).scalars().all()[0]
    device = (await db.execute(select(HelperDevice).where(
        HelperDevice.owner_user_id == owner.id))).scalar_one()
    deny = await client.get(f"{BASE}/me/rooms", headers={"Authorization": f"Bearer {token}x"})
    assert deny.status_code == 401
    # The pair response legitimately carries the minted token once (S6 forbids
    # secrets in logs and error responses, not in their own delivery payload).
    assert data["code"] not in resp.text + deny.text + caplog.text
    for secret in (token, record.code_hash, record.code_salt,
                   device.token_hash, device.token_salt):
        assert secret not in deny.text + caplog.text
