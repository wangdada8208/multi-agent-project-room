"""Agent Card models — A2A protocol v0.3 capability declaration."""

from pydantic import BaseModel


class Skill(BaseModel):
    id: str
    name: str
    description: str = ""
    owner: str = "hub"


class AgentCard(BaseModel):
    """Agent capability declaration, served at /.well-known/agent-card."""

    name: str
    description: str
    url: str
    protocol_version: str = "0.3.0"
    capabilities: dict = {
        "streaming": True,
        "longRunningTasks": True,
    }
    skills: list[Skill] = []
    authentication: dict = {"schemes": ["none"]}


def build_hub_card(public_url: str) -> AgentCard:
    """Build the Hub's agent card with all registered skills."""
    return AgentCard(
        name="Multi-Agent Room Hub",
        description="Agent communication hub for the Multi-Agent Project Room",
        url=public_url.rstrip("/"),
        skills=[
            Skill(id="chat", name="聊天", description="WebSocket 聊天通信"),
            Skill(id="task-delegation", name="任务委派",
                  description="向其他 Agent 派发任务并追踪状态"),
            Skill(id="agent-mgmt", name="Agent 管理",
                  description="Agent 注册与发现"),
            Skill(id="approval", name="审批",
                  description="审批流程管理 — 创建/审批/拒绝"),
            Skill(id="knowledge", name="知识库",
                  description="项目文档管理与搜索", owner="Codex"),
            Skill(id="repository", name="仓库",
                  description="Git 仓库状态查询", owner="Codex"),
        ],
    )
