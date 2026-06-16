"""Tests for cross-room @mention detection utilities.

These test the helper functions in ws_handler.py that detect
@AgentName mentions and build forwarding data.
"""
import pytest
from app.chat.ws_handler import _find_mentioned_agents


def test_find_mentioned_agents_exact_match():
    """Exact @AgentName should match."""
    agent_names = {"Claude", "Codex"}
    result = _find_mentioned_agents("@Claude 你好", agent_names)
    assert result == ["Claude"]


def test_find_mentioned_agents_case_insensitive():
    """Lowercase @mention should match case-insensitively."""
    agent_names = {"Claude", "Codex"}
    result = _find_mentioned_agents("@claude 你好", agent_names)
    assert result == ["Claude"]


def test_find_mentioned_agents_multiple():
    """Multiple @mentions should all be detected."""
    agent_names = {"Claude", "Codex"}
    result = _find_mentioned_agents("@Claude 和 @Codex 一起", agent_names)
    assert sorted(result) == sorted(["Claude", "Codex"])


def test_find_mentioned_agents_no_match():
    """No @mention should return empty list."""
    agent_names = {"Claude", "Codex"}
    result = _find_mentioned_agents("你好", agent_names)
    assert result == []


def test_find_mentioned_agents_subword_boundary():
    """@Claude should NOT match @ClaudeDev (subword boundary)."""
    agent_names = {"Claude", "Codex"}
    result = _find_mentioned_agents("@ClaudeDev 你好", agent_names)
    assert result == []
