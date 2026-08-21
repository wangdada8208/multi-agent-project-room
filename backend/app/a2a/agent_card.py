"""Agent Card — A2A Protocol v1.0 capability declaration.

Uses official a2a-sdk protobuf types for protocol compliance.
"""

from __future__ import annotations

from a2a.types import AgentCard, AgentCapabilities, AgentSkill, AgentInterface

from app.config import get_settings


def build_hub_card(public_url: str) -> AgentCard:
    """Build the Hub's agent card with all registered skills."""
    card = AgentCard()
    card.name = "Multi-Agent Room Hub"
    card.description = (
        "Agent communication hub for the Multi-Agent Project Room. "
        "Routes messages, tasks, and approvals between human users and AI agents."
    )
    card.version = "2.0.0"
    card.capabilities.streaming = True
    card.capabilities.push_notifications = True
    card.default_input_modes.append("text/plain")
    card.default_input_modes.append("application/json")
    card.default_output_modes.append("text/plain")
    card.default_output_modes.append("application/json")

    iface = AgentInterface()
    iface.url = public_url.rstrip("/")
    iface.protocol_binding = "JSONRPC"
    card.supported_interfaces.append(iface)

    _skills = [
        ("chat", "聊天", "WebSocket 聊天通信", ["chat", "messaging"]),
        ("task-delegation", "任务委派", "向其他 Agent 派发任务并追踪状态", ["tasks"]),
        ("agent-mgmt", "Agent 管理", "Agent 注册与发现", ["discovery"]),
        ("approval", "审批", "审批流程管理 — 创建/审批/拒绝", ["workflow"]),
        ("knowledge", "知识库", "项目文档管理与搜索", ["documents"]),
        ("repository", "仓库", "Git 仓库状态查询", ["git"]),
        ("dialogue", "多轮对话", "Agent 间消息循环协作", ["collaboration"]),
    ]
    for sid, sname, sdesc, tags in _skills:
        skill = AgentSkill()
        skill.id = sid
        skill.name = sname
        skill.description = sdesc
        for tag in tags:
            skill.tags.append(tag)
        card.skills.append(skill)

    return card


def build_agent_card(
    name: str,
    description: str,
    url: str,
    skills: list[dict] | None = None,
) -> AgentCard:
    """Build an individual agent's card."""
    card = AgentCard()
    card.name = name
    card.description = description or f"{name} agent"
    card.version = "1.0.0"
    card.capabilities.streaming = True
    card.capabilities.push_notifications = False
    card.default_input_modes.append("text/plain")
    card.default_output_modes.append("text/plain")

    iface = AgentInterface()
    iface.url = url.rstrip("/")
    iface.protocol_binding = "JSONRPC"
    card.supported_interfaces.append(iface)

    for s in (skills or []):
        skill = AgentSkill()
        skill.id = s.get("id", "")
        skill.name = s.get("name", "")
        skill.description = s.get("description", "")
        for tag in s.get("tags", []):
            skill.tags.append(tag)
        card.skills.append(skill)

    return card


def card_to_dict(card: AgentCard) -> dict:
    """Serialize an AgentCard to a JSON-compatible dict."""
    return {
        "name": card.name,
        "description": card.description,
        "version": card.version,
        "url": (
            card.supported_interfaces[0].url
            if card.supported_interfaces
            else ""
        ),
        "protocol_version": "1.0",
        "capabilities": {
            "streaming": card.capabilities.streaming,
            "push_notifications": card.capabilities.push_notifications,
        },
        "default_input_modes": list(card.default_input_modes),
        "default_output_modes": list(card.default_output_modes),
        "skills": [
            {
                "id": s.id,
                "name": s.name,
                "description": s.description,
                "tags": list(s.tags),
            }
            for s in card.skills
        ],
    }
