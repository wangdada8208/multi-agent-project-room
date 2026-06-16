"""Agent module model aliases.

The A2A hub already owns the physical registry table. Codex exposes it as the
Agent module API so the frontend and other modules have a stable REST surface.
"""

from app.models.agent_card import AgentCardRecord

__all__ = ["AgentCardRecord"]
