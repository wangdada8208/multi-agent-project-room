"""Message Loop — Agent 间多轮协作循环（借鉴 CoordClaw 理念）。

核心设计原则：
1. 每轮上下文完全重置 — 防止上下文污染
2. 角色视角正交 — 每个 Agent 只关注自己的领域
3. 冲突即信号 — 显式暴露差异而不是掩盖
4. 消息即协作 — 所有消息对人类可见可干预
5. 共识驱动收敛 — 循环直到达成共识或达到最大轮数
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

logger = logging.getLogger(__name__)


class LoopStatus(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    CONSENSUS = "consensus"
    MAX_TURNS = "max_turns"
    CANCELED = "canceled"
    TIMEOUT = "timeout"


@dataclass
class TurnResult:
    """One agent's response in the loop."""

    agent_name: str
    content: str
    turn_number: int
    signals_consensus: bool = False
    conflicts: list[str] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class TeamRole:
    """A role definition from natural language team config."""

    name: str
    agent_name: str
    responsibilities: list[str] = field(default_factory=list)
    focus_areas: list[str] = field(default_factory=list)
    ignore_areas: list[str] = field(default_factory=list)

    def to_prompt(self) -> str:
        lines = [f"你是 {self.name}（{self.agent_name}）。"]
        if self.responsibilities:
            lines.append("职责：" + "、".join(self.responsibilities))
        if self.focus_areas:
            lines.append("关注范围：" + "、".join(self.focus_areas))
        if self.ignore_areas:
            lines.append("不关注：" + "、".join(self.ignore_areas))
        return "\n".join(lines)


def parse_team_config(markdown: str) -> list[TeamRole]:
    """Parse a Markdown team configuration file into role definitions.

    Expected format:
    ### 架构师 (Architect)
    - 职责：系统设计、技术选型
    - 关注范围：整体架构、模块边界
    - 不关注：具体代码实现细节
    """
    roles: list[TeamRole] = []
    current: dict | None = None

    for line in markdown.splitlines():
        header_match = re.match(r"^###\s+(.+?)\s*\((.+?)\)", line.strip())
        if header_match:
            if current and "name" in current:
                roles.append(_build_role(current))
            current = {"name": header_match.group(1).strip(), "agent": header_match.group(2).strip()}
        elif current is not None:
            stripped = line.strip().lstrip("-• ")
            for key, cn in [("responsibilities", "职责"), ("focus_areas", "关注范围"), ("ignore_areas", "不关注")]:
                if stripped.startswith(cn):
                    value = stripped[len(cn):].lstrip("：: ").strip()
                    current[key] = [v.strip() for v in value.split("、") if v.strip()]
                    break

    if current and "name" in current:
        roles.append(_build_role(current))

    return roles


def _build_role(data: dict) -> TeamRole:
    return TeamRole(
        name=data.get("name", ""),
        agent_name=data.get("agent", ""),
        responsibilities=data.get("responsibilities", []),
        focus_areas=data.get("focus_areas", []),
        ignore_areas=data.get("ignore_areas", []),
    )


class MessageLoop:
    """Multi-turn collaboration loop between agents.

    Each round:
      1. Reset context (only keep role definitions + previous round summary)
      2. Route message to next agent
      3. Collect response
      4. Check consensus signal
      5. If no consensus and turns remain → continue
    """

    def __init__(
        self,
        loop_id: str | None = None,
        room_id: str = "",
        topic: str = "",
        participants: list[TeamRole] | None = None,
        max_turns: int = 10,
        timeout_seconds: int = 120,
    ):
        self.loop_id = loop_id or str(uuid.uuid4())
        self.room_id = room_id
        self.topic = topic
        self.participants = participants or []
        self.max_turns = max_turns
        self.timeout_seconds = timeout_seconds

        self.status = LoopStatus.PENDING
        self.current_round = 0
        self.turns: list[TurnResult] = []
        self.consensus_summary: str | None = None

    @property
    def active_agent_index(self) -> int:
        return len(self.turns) % len(self.participants) if self.participants else 0

    @property
    def active_role(self) -> TeamRole | None:
        if not self.participants:
            return None
        return self.participants[self.active_agent_index]

    def build_context_reset(self) -> str:
        """Build a clean context prompt with only essential info.

        This prevents context pollution by resetting each turn.
        """
        parts = [
            f"## 协作主题\n{self.topic}",
            f"## 当前进度\n第 {self.current_round} 轮 / 最多 {self.max_turns} 轮",
        ]

        # Include only the last 2 turns as context (not full history)
        recent_turns = self.turns[-2:]
        if recent_turns:
            parts.append("## 最近讨论")
            for t in recent_turns:
                parts.append(f"**{t.agent_name}**: {t.content[:500]}")

        role = self.active_role
        if role:
            parts.insert(0, role.to_prompt())

        parts.append(
            "\n如果你认为已达成共识，请在回复开头加上 [CONSENSUS]。"
            "\n如果发现冲突，请明确列出冲突点。"
        )

        return "\n\n".join(parts)

    def detect_conflicts(self, content: str) -> list[str]:
        """Detect explicit conflict markers in a response."""
        conflicts = []
        patterns = [
            r"(?:但是|不过|然而|问题在于)(.{5,100})",
            r"(?:不同意|反对|有异议)(.{5,80})",
            r"\[CONFLICT\]\s*(.+)",
        ]
        for pattern in patterns:
            matches = re.findall(pattern, content)
            conflicts.extend(m.strip() for m in matches)
        return conflicts[:3]

    def check_consensus(self, content: str) -> bool:
        """Check if this turn signals consensus."""
        upper = content.upper()
        return "[CONSENSUS]" in upper or "共识已达成" in content or "达成一致" in content

    def record_turn(self, agent_name: str, content: str) -> TurnResult:
        """Record an agent's response."""
        result = TurnResult(
            agent_name=agent_name,
            content=content,
            turn_number=len(self.turns) + 1,
            signals_consensus=self.check_consensus(content),
            conflicts=self.detect_conflicts(content),
        )
        self.turns.append(result)
        return result

    async def step(self, send_fn=None) -> TurnResult | None:
        """Execute one turn of the loop.

        Args:
            send_fn: Async callable(prompt) -> str that sends prompt to the active agent.

        Returns:
            TurnResult if executed, None if loop should stop.
        """
        if self.status == LoopStatus.PENDING:
            self.status = LoopStatus.ACTIVE

        if self.status != LoopStatus.ACTIVE:
            return None

        if self.current_round >= self.max_turns:
            self.status = LoopStatus.MAX_TURNS
            return None

        if not self.participants:
            self.status = LoopStatus.CANCELED
            return None

        role = self.active_role
        if not role:
            return None

        prompt = self.build_context_reset()

        if send_fn:
            try:
                response_text = await send_fn(prompt, role)
            except Exception as e:
                logger.exception("Agent %s failed", role.agent_name)
                response_text = f"[error] {e}"
        else:
            response_text = f"[simulated] {role.name} 回复"

        self.current_round += 1
        result = self.record_turn(role.agent_name, response_text)

        if result.signals_consensus:
            self.status = LoopStatus.CONSENSUS
            self.consensus_summary = response_text

        return result

    async def run(self, send_fn=None) -> dict:
        """Run the complete message loop until convergence.

        Returns a summary dict.
        """
        while self.status == LoopStatus.ACTIVE or self.status == LoopStatus.PENDING:
            await self.step(send_fn)

        return {
            "loop_id": self.loop_id,
            "status": self.status.value,
            "rounds_completed": self.current_round,
            "max_turns": self.max_turns,
            "total_messages": len(self.turns),
            "consensus_reached": self.status == LoopStatus.CONSENSUS,
            "consensus_summary": self.consensus_summary,
            "conflicts_found": sum(len(t.conflicts) for t in self.turns),
            "participants": [p.agent_name for p in self.participants],
        }

    def to_dict(self) -> dict:
        return {
            "loop_id": self.loop_id,
            "room_id": self.room_id,
            "topic": self.topic,
            "status": self.status.value,
            "current_round": self.current_round,
            "max_turns": self.max_turns,
            "turns": [
                {
                    "agent": t.agent_name,
                    "content": t.content,
                    "turn": t.turn_number,
                    "consensus": t.signals_consensus,
                    "conflicts": t.conflicts,
                    "timestamp": t.timestamp,
                }
                for t in self.turns
            ],
            "consensus_summary": self.consensus_summary,
        }
