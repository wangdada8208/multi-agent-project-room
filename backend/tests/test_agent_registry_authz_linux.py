"""REST and RPC registry must authorize before writes or network discovery."""

from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from app.agent import service
from app.a2a.server import AgentDiscovery
from app.core.security import create_access_token
from app.models.user import User
from app.models.agent_card import AgentCardRecord


async def identity(db, username, role="agent", display="Codex"):
    user = User(username=username, display_name=display, user_type=role)
    db.add(user)
    await db.commit()
    return user, {"Authorization": f"Bearer {create_access_token(user.id, role)}"}


async def register(client, channel, headers, name="Codex"):
    params = {"name": name, "url": "https://agent.invalid", "capabilities": ["review"], "skills": [{"id": "review"}]}
    if channel == "rest":
        return await client.post("/api/v1/agents/register", headers=headers, json=params)
    return await client.post("/a2a/dialogue-rpc", headers=headers,
                             json={"jsonrpc": "2.0", "method": "agent/register", "params": params, "id": "test"})


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["rest", "rpc"])
@pytest.mark.parametrize("kind", ["anonymous", "human", "impostor", "collision", "agent_collision", "deleted"])
async def test_registry_rejects_before_write_or_network(client, db, monkeypatch, channel, kind):
    headers = {}
    if kind != "anonymous":
        user, headers = await identity(db, "codex" if kind in ("human", "collision", "agent_collision", "deleted") else "other_agent",
                                       "human" if kind == "human" else "agent", display="Codex")
        if kind in ("collision", "agent_collision"):
            await identity(db, "CoDeX", "human" if kind == "collision" else "agent")
        if kind == "deleted":
            await db.delete(user)
            await db.commit()
    write = AsyncMock(return_value={"name": "Codex"})
    discovery = AsyncMock(return_value={"status": "registered"})
    monkeypatch.setattr(service, "register_agent", write)
    monkeypatch.setattr(AgentDiscovery, "register", discovery)
    response = await register(client, channel, headers)
    assert response.status_code == (401 if kind in ("anonymous", "deleted") else 403)
    write.assert_not_awaited()
    discovery.assert_not_awaited()
    assert not (await db.execute(select(AgentCardRecord))).scalars().all()


@pytest.mark.asyncio
async def test_rest_agent_card_and_public_reads(client, db):
    _, headers = await identity(db, "CoDeX", display="Not the username")
    # This registry/read test uses the account's local marker; public HTTP
    # validation and pinned transport are covered by the egress regressions.
    response = await client.post("/api/v1/agents/register", headers=headers, json={
        "name": "Codex", "url": "local://codex", "capabilities": ["review"],
        "skills": [{"id": "review"}],
    })
    assert response.status_code == 200
    card = response.json()["agent"]
    assert card["name"] == "codex"
    assert card["url"] == "local://codex"
    assert card["skills"] == [{"id": "review"}]
    assert card["capabilities"] == ["review"]
    assert (await client.get("/api/v1/agents")).status_code == 200
    assert (await client.get(f"/api/v1/agents/{card['id']}")).json()["agent"]["name"] == "codex"


@pytest.mark.asyncio
async def test_rpc_agent_registration_uses_db_identity(client, db, monkeypatch):
    user, headers = await identity(db, "CoDeX", display="Unrelated label")
    discovery = AsyncMock(return_value={"status": "registered"})
    monkeypatch.setattr(AgentDiscovery, "register", discovery)
    response = await register(client, "rpc", headers)
    assert response.status_code == 200
    assert response.json()["result"]["status"] == "registered"
    discovery.assert_awaited_once_with("codex", "https://agent.invalid", agent_user_id=user.id)
