"""Synthetic ownership regression tests; no external transport or real credentials."""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select
from app.core.security import create_access_token
from app.models.user import User
from app.models.agent_card import AgentCardRecord

BASE = "/api/v1/agent-bindings"

@pytest_asyncio.fixture
async def identities(db):
    users = [User(username=name, display_name=name, user_type=kind)
             for name, kind in [("ownerone", "human"), ("ownertwo", "human"),
                                ("agentone", "agent"), ("agenttwo", "agent")]]
    db.add_all(users)
    await db.commit()
    return users


def headers(user):
    return {"Authorization": "Bearer " + create_access_token(user.id, user.user_type)}

async def issue(client, owner, **payload):
    return await client.post(BASE + "/invitations", headers=headers(owner), json=payload)

async def claim(client, agent, code):
    return await client.post(BASE + "/claim", headers=headers(agent), json={"code": code})

@pytest.mark.asyncio
async def test_binding_and_replay(client, db, identities):
    owner, other, agent, _ = identities
    legacy = AgentCardRecord(agent_name=agent.username, agent_card_url="local://agentone")
    db.add(legacy)
    await db.commit()
    invitation = await issue(client, owner, target_agent_user_id=agent.id)
    assert invitation.status_code == 201
    data = invitation.json()
    assert "hash" not in invitation.text and "salt" not in invitation.text
    response = await claim(client, agent, data["code"])
    assert response.status_code == 200
    assert data["code"] not in response.text
    await db.refresh(agent)
    await db.refresh(legacy)
    assert agent.owner_user_id == owner.id and agent.owner_bound_at
    assert legacy.agent_user_id is None  # never infer a historical Card from its name
    assert (await claim(client, agent, data["code"])).status_code == 409
    listing = await client.get(BASE + "/agents", headers=headers(owner))
    assert [a["id"] for a in listing.json()["agents"]] == [agent.id]
    assert (await client.get(BASE + "/agents", headers=headers(other))).json()["agents"] == []
    second = (await issue(client, other)).json()
    assert (await claim(client, agent, second["code"])).status_code == 409
    from app.models.agent_binding import AgentBindingInvite
    record = await db.get(AgentBindingInvite, second["id"])
    await db.refresh(record)
    assert record.consumed_at is None  # failed ownership CAS rolls back consumption

@pytest.mark.asyncio
async def test_roles_and_target(client, identities):
    owner, _, agent, wrong = identities
    assert (await client.post(BASE + "/invitations", json={})).status_code == 401
    assert (await issue(client, agent)).status_code == 403
    assert (await client.get(BASE + "/agents", headers=headers(agent))).status_code == 403
    invite = (await issue(client, owner, target_agent_username=agent.username.upper())).json()
    assert (await claim(client, owner, invite["code"])).status_code == 403
    assert (await claim(client, wrong, invite["code"])).status_code == 409
    assert (await claim(client, agent, invite["code"])).status_code == 200
    assert (await issue(client, owner, target_agent_username="nonexistent")).status_code == 403
    assert (await issue(client, owner, target_agent_user_id=owner.id)).status_code == 403

@pytest.mark.asyncio
async def test_expiry_revocation_and_tenant_boundary(client, db, identities):
    from app.models.agent_binding import AgentBindingInvite
    owner, other, agent, _ = identities
    expired = (await issue(client, owner)).json()
    record = await db.get(AgentBindingInvite, expired["id"])
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()
    assert (await claim(client, agent, expired["code"])).status_code == 409
    invitation = (await issue(client, owner)).json()
    path = BASE + "/invitations/" + invitation["id"] + "/revoke"
    assert (await client.post(path, headers=headers(other))).status_code == 404
    assert (await client.post(path, headers=headers(owner))).status_code == 200
    assert (await claim(client, agent, invitation["code"])).status_code == 409

@pytest.mark.asyncio
async def test_two_claimants_one_winner(client, db, identities):
    owner, _, one, two = identities
    invite = (await issue(client, owner)).json()
    responses = await asyncio.gather(claim(client, one, invite["code"]), claim(client, two, invite["code"]))
    assert sorted(r.status_code for r in responses) == [200, 409]
    await db.refresh(one)
    await db.refresh(two)
    assert sum(u.owner_user_id == owner.id for u in (one, two)) == 1

@pytest.mark.asyncio
async def test_issuance_limit(client, identities):
    owner, _, _, _ = identities
    for _ in range(10):
        assert (await issue(client, owner)).status_code == 201
    assert (await issue(client, owner)).status_code == 429

@pytest.mark.asyncio
async def test_card_registration_and_legacy_compatibility(client, db, identities):
    owner, _, agent, _ = identities
    assert agent.owner_user_id is None
    card = AgentCardRecord(agent_name=agent.username, agent_card_url="local://agentone")
    db.add(card)
    await db.commit()
    response = await client.post("/api/v1/agents/register", headers=headers(agent),
                                 json={"name": agent.username, "url": "local://agentone"})
    assert response.status_code == 200
    await db.refresh(card)
    assert card.agent_user_id == agent.id
    await db.refresh(agent)
    assert agent.owner_user_id is None

@pytest.mark.asyncio
async def test_same_agent_two_invitations_atomic_rollback(client, db, identities):
    from app.models.agent_binding import AgentBindingInvite
    owner, other, agent, _ = identities
    invites = [(await issue(client, owner)).json(), (await issue(client, other)).json()]
    responses = await asyncio.gather(*(claim(client, agent, i["code"]) for i in invites))
    assert sorted(r.status_code for r in responses) == [200, 409]
    records = (await db.scalars(select(AgentBindingInvite))).all()
    assert sum(i.consumed_at is not None for i in records) == 1
    await db.refresh(agent)
    assert agent.owner_user_id in {owner.id, other.id}

@pytest.mark.asyncio
async def test_storage_and_error_responses_do_not_disclose_code(client, db, identities, caplog):
    from app.models.agent_binding import AgentBindingInvite
    owner, _, agent, _ = identities
    invitation = (await issue(client, owner)).json()
    record = await db.get(AgentBindingInvite, invitation["id"])
    assert invitation["code"] not in str(record.__dict__)
    response = await claim(client, agent, invitation["code"] + "corrupt")
    assert response.status_code == 409
    assert (await claim(client, agent, "not-a-code")).status_code == 409
    assert all(secret not in response.text + caplog.text for secret in
               [invitation["code"], record.token_hash, record.token_salt])
    assert (await claim(client, agent, invitation["code"])).status_code == 200
    assert (await client.post(BASE + "/invitations/" + invitation["id"] + "/revoke",
                              headers=headers(owner))).status_code == 409

@pytest.mark.asyncio
async def test_db_role_collision_and_no_request_owner_override(client, db, identities):
    owner, other, agent, _ = identities
    forged_type = {"Authorization": "Bearer " + create_access_token(agent.id, "human")}
    assert (await client.post(BASE + "/invitations", headers=forged_type, json={})).status_code in (401, 403)
    invitation = (await issue(client, owner)).json()
    assert (await client.post(BASE + "/claim", headers=headers(agent),
                              json={"code": invitation["code"], "owner_user_id": other.id})).status_code == 422
    collision = User(username=agent.username.upper(), display_name="collision", user_type="agent")
    db.add(collision)
    await db.commit()
    assert (await claim(client, agent, invitation["code"])).status_code == 403

@pytest.mark.asyncio
async def test_claim_attempt_rate_limit(client, identities):
    _, _, agent, _ = identities
    for _ in range(20):
        assert (await claim(client, agent, "invalid")).status_code == 409
    assert (await claim(client, agent, "invalid")).status_code == 429

@pytest.mark.asyncio
async def test_rpc_register_links_authenticated_account(client, db, identities, monkeypatch):
    from unittest.mock import AsyncMock
    from types import SimpleNamespace
    from app.a2a import discovery
    owner, _, agent, _ = identities
    # Mock policy/transport; never resolve or connect to the synthetic hostname.
    monkeypatch.setattr(discovery, "validate_agent_card_url", lambda url: object())
    monkeypatch.setattr(discovery, "safe_probe_agent_url", AsyncMock(return_value=SimpleNamespace(
        status_code=200, json=lambda: {"skills": []})))
    response = await client.post("/a2a/dialogue-rpc", headers=headers(agent), json={
        "jsonrpc": "2.0", "method": "agent/register", "id": "synthetic",
        "params": {"name": agent.username, "url": "https://synthetic.invalid"}})
    assert response.status_code == 200 and "result" in response.json()
    card = await db.get(AgentCardRecord, response.json()["result"]["id"])
    assert card.agent_user_id == agent.id
    card.agent_user_id = owner.id  # corrupt/conflicting legacy relation must not be stolen
    await db.commit()
    response = await client.post("/a2a/dialogue-rpc", headers=headers(agent), json={
        "jsonrpc": "2.0", "method": "agent/register", "id": "conflict",
        "params": {"name": agent.username, "url": "https://synthetic.invalid"}})
    assert response.status_code == 403
    rest = await client.post("/api/v1/agents/register", headers=headers(agent),
                             json={"name": agent.username, "url": "local://agentone"})
    assert rest.status_code == 403


def test_incremental_migration_on_new_synthetic_sqlite(tmp_path):
    import importlib.util
    from pathlib import Path
    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    path = Path(__file__).resolve().parents[1] / "alembic/versions/a10c20261010_agent_owner_binding.py"
    spec = importlib.util.spec_from_file_location("binding_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.down_revision == "f9a1c2d3e4b5"
    engine = sa.create_engine("sqlite:///" + str(tmp_path / "migration.sqlite"))
    with engine.begin() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")
        conn.exec_driver_sql("CREATE TABLE users (id VARCHAR(36) PRIMARY KEY, username VARCHAR(64), user_type VARCHAR(16))")
        conn.exec_driver_sql("CREATE TABLE agent_card_records (id VARCHAR(36) PRIMARY KEY, agent_name VARCHAR(128))")
        conn.exec_driver_sql("INSERT INTO users VALUES ('legacy', 'legacy', 'agent')")
        conn.exec_driver_sql("INSERT INTO agent_card_records VALUES ('legacy-card', 'legacy')")
        with Operations.context(MigrationContext.configure(conn)):
            migration.upgrade()
            assert conn.exec_driver_sql("SELECT owner_user_id, owner_bound_at FROM users").one() == (None, None)
            assert conn.exec_driver_sql("SELECT agent_user_id FROM agent_card_records").scalar() is None
            assert sa.inspect(conn).get_foreign_keys("users")[0]["referred_table"] == "users"
            assert len(sa.inspect(conn).get_foreign_keys("agent_binding_invites")) == 3
            with pytest.raises(sa.exc.IntegrityError):
                conn.exec_driver_sql("UPDATE users SET owner_user_id='missing'")
            migration.downgrade()
            assert "agent_binding_invites" not in sa.inspect(conn).get_table_names()
            assert "owner_user_id" not in {c["name"] for c in sa.inspect(conn).get_columns("users")}
            assert conn.exec_driver_sql("SELECT id FROM users").scalar() == "legacy"
    engine.dispose()

@pytest.mark.asyncio
async def test_database_error_redaction(client, identities, monkeypatch):
    from unittest.mock import AsyncMock
    from sqlalchemy.exc import SQLAlchemyError
    from sqlalchemy.ext.asyncio import AsyncSession
    owner, _, _, _ = identities
    monkeypatch.setattr(AsyncSession, "commit", AsyncMock(side_effect=SQLAlchemyError("synthetic-sensitive-hash")))
    response = await issue(client, owner)
    assert response.status_code == 503
    assert "synthetic-sensitive-hash" not in response.text


def test_postgresql_offline_ddl_and_revision_head():
    import ast
    import importlib.util
    from io import StringIO
    from pathlib import Path
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    versions = Path(__file__).resolve().parents[1] / "alembic/versions"
    revisions = {}
    for path in versions.glob("*.py"):
        fields = {}
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                fields[node.target.id] = node.value
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        fields[target.id] = node.value
        revisions[ast.literal_eval(fields["revision"])] = ast.literal_eval(fields["down_revision"])
    new = "a10c20261010"
    assert new in revisions and revisions[new] == "f9a1c2d3e4b5"
    assert revisions["c30c20261010"] == "b20c20261010"
    assert revisions["d40c20261010"] == "c30c20261010"
    assert revisions["e50c20261011"] == "d40c20261010"
    assert revisions["f60c20261011"] == "e50c20261011"
    assert set(revisions) - set(revisions.values()) == {"f60c20261011"}
    old = {r: parent for r, parent in revisions.items() if r not in (new, "b20c20261010", "c30c20261010", "d40c20261010", "e50c20261011", "f60c20261011")}
    assert len(old) == 11 and set(old) - set(old.values()) == {"f9a1c2d3e4b5"}
    spec = importlib.util.spec_from_file_location("binding_offline_migration", versions / "a10c20261010_agent_owner_binding.py")
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    output = StringIO()
    context = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": output})
    with Operations.context(context):
        migration.upgrade()
    sql = output.getvalue()
    assert "ALTER TABLE users ADD COLUMN owner_user_id" in sql
    assert "CREATE TABLE agent_binding_invites" in sql
    assert "FOREIGN KEY(owner_user_id) REFERENCES users (id)" in sql
    assert "DROP TABLE" not in sql and "UPDATE " not in sql
