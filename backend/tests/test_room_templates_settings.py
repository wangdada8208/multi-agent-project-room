"""WP9: template structured metadata → rooms.settings_json.

Covers: template listing metadata, create-room persistence of
settings_json + settings_version, hard-forbidden-scope rejection, and the
heartbeat ``rooms`` sync shape that helpers consume. No XMTP transport.
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.api.invites import FORBIDDEN_SCOPE_PREFIXES, FORBIDDEN_SCOPES
from app.api.templates import SYSTEM_TEMPLATES, seed_system_templates
from app.core.security import create_access_token
from app.models.room import Room
from app.models.room_template import RoomTemplate
from app.models.user import User

TEMPLATES = "/api/v1/templates"
HELPERS = "/api/v1/helpers"


def headers(user):
    return {"Authorization": "Bearer " + create_access_token(user.id, user.user_type)}


@pytest_asyncio.fixture
async def owner(db):
    user = User(username="wp9owner", display_name="Owner", user_type="human")
    db.add(user)
    await db.commit()
    return user


@pytest_asyncio.fixture
async def seeded(db):
    await seed_system_templates(db)
    return True


async def _create_room(client, owner, **payload):
    body = {"template_key": "dev_team", "name": "wp9 room", **payload}
    return await client.post(f"{TEMPLATES}/create-room", headers=headers(owner), json=body)


@pytest.mark.asyncio
async def test_seed_is_idempotent_and_column_safe(client, db, seeded):
    """house_rules/default_max_rounds have no DB columns; seeding must filter."""
    await seed_system_templates(db)  # second run must not fail or duplicate
    keys = (await db.execute(select(RoomTemplate.key))).scalars().all()
    assert sorted(keys) == sorted(t["key"] for t in SYSTEM_TEMPLATES)


@pytest.mark.asyncio
async def test_list_templates_exposes_structured_metadata(client, db, seeded):
    resp = await client.get(TEMPLATES)
    assert resp.status_code == 200, resp.text
    templates = {t["key"]: t for t in resp.json()["templates"]}
    assert set(templates) == {t["key"] for t in SYSTEM_TEMPLATES}

    for key, tmpl in templates.items():
        static = next(t for t in SYSTEM_TEMPLATES if t["key"] == key)
        assert tmpl["house_rules"] == static["house_rules"]
        assert tmpl["default_max_rounds"] == static["default_max_rounds"]
        # team_config_markdown is explicitly marked non-authoritative
        assert "不构成授权依据" in tmpl["team_config_markdown"]
        # suggested defaults: only ask/cannot, never a hard-forbidden scope
        for scope, decision in tmpl["house_rules"]["scopes"].items():
            assert decision in ("ask", "cannot")
            assert scope not in FORBIDDEN_SCOPES
            assert not any(scope.startswith(p) for p in FORBIDDEN_SCOPE_PREFIXES)


@pytest.mark.asyncio
async def test_create_room_persists_settings_json(client, db, owner, seeded):
    resp = await _create_room(client, owner)
    assert resp.status_code == 200, resp.text

    static = next(t for t in SYSTEM_TEMPLATES if t["key"] == "dev_team")
    expected = {
        "template_key": "dev_team",
        "house_rules": static["house_rules"],
        "team_config_markdown": static["team_config_markdown"],
        "default_max_rounds": static["default_max_rounds"],
    }
    room_body = resp.json()["room"]
    assert room_body["settings_version"] == 1
    assert room_body["settings_json"] == expected

    # Persisted on the row, not just the response
    room = await db.get(Room, room_body["id"])
    assert room.settings_version == 1
    assert room.settings_json == expected


@pytest.mark.asyncio
async def test_create_room_owner_overrides_merge(client, db, owner, seeded):
    override = {"scopes": {"*": "ask", "gmail.send": "cannot"}, "notes": ["custom"]}
    resp = await _create_room(
        client, owner,
        house_rules=override,
        team_config_markdown="custom bounded config",
        default_max_rounds=5,
    )
    assert resp.status_code == 200, resp.text
    settings = resp.json()["room"]["settings_json"]
    assert settings["house_rules"] == override
    assert settings["team_config_markdown"] == "custom bounded config"
    assert settings["default_max_rounds"] == 5
    assert settings["template_key"] == "dev_team"


@pytest.mark.asyncio
async def test_create_room_rejects_hard_forbidden_scopes(client, db, owner, seeded):
    for bad in ("payment.send", "banking.transfer", "credentials.read",
                "password.store", "card.charge", "wallet.sign", "data.export_all"):
        resp = await _create_room(
            client, owner, house_rules={"scopes": {bad: "cannot"}}
        )
        assert resp.status_code == 422, (bad, resp.text)
    # even a bare forbidden token hidden in notes is rejected (same as rooms.py)
    resp = await _create_room(
        client, owner, house_rules={"notes": ["data.export_all"]}
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_room_rejects_auto_grant(client, db, owner, seeded):
    """Hub metadata may tighten or defer — never 'allow' (auto-grant)."""
    resp = await _create_room(
        client, owner, house_rules={"scopes": {"gmail.send": "allow"}}
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_create_room_rejects_malformed_metadata(client, db, owner, seeded):
    # oversized markdown (pydantic bound)
    resp = await _create_room(client, owner, team_config_markdown="x" * 4097)
    assert resp.status_code == 422
    # oversized assembled settings document (> _MAX_SETTINGS_BYTES)
    resp = await _create_room(
        client, owner, house_rules={"notes": ["x" * 280] * 32}
    )
    assert resp.status_code == 422
    # bad shapes
    for bad_rules in (
        ["not-a-dict"],
        {"scopes": ["gmail.send"]},            # scopes must be an object
        {"scopes": {"gmail.send": "maybe"}},   # unknown decision
        {"bogus": {}},                          # unsupported envelope key
    ):
        resp = await _create_room(client, owner, house_rules=bad_rules)
        assert resp.status_code == 422, (bad_rules, resp.text)
    # bad rounds
    for bad_rounds in (0, 65, "three"):
        resp = await _create_room(client, owner, default_max_rounds=bad_rounds)
        assert resp.status_code == 422, (bad_rounds, resp.text)


@pytest.mark.asyncio
async def test_create_room_unknown_template_404(client, db, owner, seeded):
    resp = await _create_room(client, owner, template_key="nope")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_settings_sync_via_heartbeat_rooms(client, db, owner, seeded):
    """Helper heartbeat `rooms` entries carry the template metadata so workers
    can re-pull on settings_version change (B5 channel)."""
    resp = await _create_room(client, owner)
    assert resp.status_code == 200, resp.text
    room_id = resp.json()["room"]["id"]

    code = (await client.post(f"{HELPERS}/pairing-codes",
                              headers=headers(owner))).json()["code"]
    pair = await client.post(f"{HELPERS}/pair",
                             json={"code": code, "device_name": "d", "platform": "linux"})
    assert pair.status_code == 200, pair.text
    helper_headers = {"Authorization": f"Bearer {pair.json()['helper_token']}"}

    beat = (await client.post(f"{HELPERS}/me/heartbeat", headers=helper_headers,
                              json={"agents": [], "seats": []})).json()
    entry = [r for r in beat["rooms"] if r["id"] == room_id]
    assert entry, "template room missing from heartbeat rooms sync"
    assert entry[0]["settings_version"] == 1
    settings = entry[0]["settings_json"]
    assert settings["template_key"] == "dev_team"
    assert set(settings["house_rules"]["scopes"].values()) <= {"ask", "cannot"}
    assert "不构成授权依据" in settings["team_config_markdown"]
    assert settings["default_max_rounds"] == 3
