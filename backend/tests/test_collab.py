"""Test message loop collaboration and team configuration parsing."""

import pytest
from httpx import AsyncClient
from app.collab.message_loop import (
    MessageLoop,
    LoopStatus,
    TeamRole,
    parse_team_config,
)


# ── Team Config Parser ─────────────────────────────────


SAMPLE_TEAM_MD = """
# 团队配置：项目开发组

## 成员

### 架构师 (Architect)
- 职责：系统设计、技术选型、架构评审
- 关注范围：整体架构、模块边界、接口设计
- 不关注：具体代码实现细节

### 开发者 (Developer)
- 职责：功能实现、代码编写、单元测试
- 关注范围：代码质量、逻辑正确性
- 不关注：架构决策

### 审查者 (Reviewer)
- 职责：代码审查、质量把关
- 关注范围：代码规范、安全漏洞
- 不关注：需求分析
"""


class TestTeamConfigParser:
    def test_parse_roles(self):
        roles = parse_team_config(SAMPLE_TEAM_MD)
        assert len(roles) == 3

    def test_role_names(self):
        roles = parse_team_config(SAMPLE_TEAM_MD)
        names = [r.name for r in roles]
        assert "架构师" in names
        assert "开发者" in names
        assert "审查者" in names

    def test_role_agent_names(self):
        roles = parse_team_config(SAMPLE_TEAM_MD)
        agents = {r.name: r.agent_name for r in roles}
        assert agents["架构师"] == "Architect"
        assert agents["开发者"] == "Developer"

    def test_responsibilities_parsed(self):
        roles = parse_team_config(SAMPLE_TEAM_MD)
        architect = next(r for r in roles if r.name == "架构师")
        assert "系统设计" in architect.responsibilities
        assert len(architect.responsibilities) == 3

    def test_ignore_areas_parsed(self):
        roles = parse_team_config(SAMPLE_TEAM_MD)
        architect = next(r for r in roles if r.name == "架构师")
        assert "具体代码实现细节" in architect.ignore_areas

    def test_empty_input(self):
        roles = parse_team_config("")
        assert len(roles) == 0

    def test_role_to_prompt(self):
        roles = parse_team_config(SAMPLE_TEAM_MD)
        prompt = roles[0].to_prompt()
        assert "你是 架构师（Architect）" in prompt
        assert "职责" in prompt


# ── Message Loop ────────────────────────────────────────


def _make_loop(max_turns=6) -> MessageLoop:
    roles = [
        TeamRole(name="架构师", agent_name="Architect", responsibilities=["系统设计"]),
        TeamRole(name="开发者", agent_name="Developer", responsibilities=["代码实现"]),
    ]
    return MessageLoop(
        room_id="test-room",
        topic="设计一个登录页面",
        participants=roles,
        max_turns=max_turns,
    )


class TestMessageLoop:
    @pytest.mark.asyncio
    async def test_basic_run_without_send_fn(self):
        loop = _make_loop()
        summary = await loop.run()
        assert summary["status"] == "max_turns"
        assert summary["rounds_completed"] == 6
        assert len(summary["participants"]) == 2

    @pytest.mark.asyncio
    async def test_consensus_detection(self):
        loop = _make_loop()

        async def fake_send(prompt, role):
            return "[CONSENSUS] 我们都同意用 React 实现登录页。"

        result = await loop.step(send_fn=fake_send)
        assert result is not None
        assert result.signals_consensus is True
        assert loop.status == LoopStatus.CONSENSUS

    @pytest.mark.asyncio
    async def test_conflict_detection(self):
        loop = _make_loop()

        async def fake_send(prompt, role):
            return "我建议用 Vue。但是你说的 React 也有道理。"

        result = await loop.step(send_fn=fake_send)
        assert result is not None
        assert len(result.conflicts) > 0

    @pytest.mark.asyncio
    async def test_context_reset_includes_recent_only(self):
        loop = _make_loop()
        # Simulate several turns
        for i in range(4):
            async def fake_send(p, r):
                return f"回复 {i}"
            await loop.step(send_fn=fake_send)

        context = loop.build_context_reset()
        # Should only include last 2 turns, not all history
        assert context.count("**Architect**: 回复") + context.count("**Developer**: 回复") <= 2

    @pytest.mark.asyncio
    async def test_max_turns_stops_loop(self):
        loop = _make_loop(max_turns=2)
        summary = await loop.run()
        assert summary["status"] == "max_turns"
        assert summary["rounds_completed"] == 2

    def test_active_role_rotation(self):
        loop = _make_loop()
        assert loop.active_role.agent_name == "Architect"

        async def noop(p, r):
            return "ok"
        asyncio.run(loop.step(send_fn=noop))
        assert loop.active_role.agent_name == "Developer"

    def test_to_dict(self):
        loop = _make_loop()
        data = loop.to_dict()
        assert data["topic"] == "设计一个登录页面"
        assert data["status"] == "pending"
        assert isinstance(data["turns"], list)


import asyncio


# ── Agent Discovery Dedup ──────────────────────────────


class TestAgentDiscoveryDedup:
    @pytest.mark.asyncio
    async def test_register_upsert_same_name_url(self, db):
        """Same name + URL should update, not create duplicate."""
        from app.a2a.discovery import AgentDiscovery

        r1 = await AgentDiscovery.register("TestAgent", "http://localhost:9999")
        assert r1["status"] == "registered"

        r2 = await AgentDiscovery.register("TestAgent", "http://localhost:9999")
        assert r2["status"] == "updated"
        assert r2["id"] == r1["id"]

    @pytest.mark.asyncio
    async def test_register_deactivates_old_url(self, db):
        """Re-registering with different URL should deactivate old record."""
        from app.a2a.discovery import AgentDiscovery

        await AgentDiscovery.register("OldAgent", "http://old:1111")
        r2 = await AgentDiscovery.register("OldAgent", "http://new:2222")

        agents = await AgentDiscovery.list_available()
        active = [a for a in agents if a["name"] == "OldAgent"]
        assert len(active) == 1
        assert active[0]["url"] == "http://new:2222"

    @pytest.mark.asyncio
    async def test_cleanup_duplicates(self, db):
        """Cleanup should remove inactive and duplicate active records."""
        from app.a2a.discovery import AgentDiscovery

        # Create duplicates manually via multiple registrations at same url (simulating old behavior)
        for _ in range(3):
            await AgentDiscovery.register("DupAgent", "http://dup:1234")

        result = await AgentDiscovery.cleanup_duplicates()
        agents = await AgentDiscovery.list_available()
        dup_agents = [a for a in agents if a["name"] == "DupAgent"]
        assert len(dup_agents) == 1

    @pytest.mark.asyncio
    async def test_list_available_deduplicates_by_name(self, db):
        """list_available should return unique agent names."""
        from app.a2a.discovery import AgentDiscovery

        await AgentDiscovery.register("UniqueA", "http://a:1")
        await AgentDiscovery.register("UniqueB", "http://b:2")

        agents = await AgentDiscovery.list_available()
        names = [a["name"] for a in agents]
        assert names.count("UniqueA") <= 1
        assert names.count("UniqueB") <= 1


# ── Dialogue Auto-Run ──────────────────────────────────


class TestDialogueAutoRun:
    @pytest.mark.asyncio
    async def test_dialogues_run_creates_and_executes(self, client: AsyncClient):
        """dialogues/run should create a dialogue and auto-execute turns."""
        resp = await client.post("/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0",
            "method": "dialogues/run",
            "params": {
                "room_id": "auto-run-room",
                "initiator_agent": "AgentA",
                "participants": ["AgentB"],
                "topic": "讨论登录方案",
                "max_turns": 2,
            },
            "id": "run-1",
        })
        assert resp.status_code == 200
        result = resp.json().get("result", {})
        assert result["status"] == "active"
        assert result["auto_run"] is True
        assert len(result["participants"]) >= 2

    @pytest.mark.asyncio
    async def test_dialogues_run_requires_room(self, client: AsyncClient):
        """dialogues/run should fail without room_id."""
        resp = await client.post("/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0",
            "method": "dialogues/run",
            "params": {"participants": ["A"]},
            "id": "run-err",
        })
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_dialogues_run_requires_participants(self, client: AsyncClient):
        """dialogues/run should fail without participants."""
        resp = await client.post("/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0",
            "method": "dialogues/run",
            "params": {"room_id": "r1"},
            "id": "run-err2",
        })
        assert resp.status_code == 400
