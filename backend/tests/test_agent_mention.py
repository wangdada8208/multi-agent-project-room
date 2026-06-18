"""Tests for cross-room @mention detection utilities.

These test the helper functions in ws_handler.py that detect
@AgentName mentions and build forwarding data.
"""
import pytest
from sqlalchemy import select

from app.chat import service as chat_service
from app.chat.models import Message
from app.chat.ws_handler import _check_mentions_and_forward, _find_mentioned_agents
from app.models.agent_card import AgentCardRecord
from app.models.room import Room


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


@pytest.mark.asyncio
async def test_forward_mention_creates_hidden_agent_channel(db):
    """Forwarding @Codex should persist the hidden agent channel before task message."""
    db.add(
        AgentCardRecord(
            agent_name="Codex",
            agent_card_url="http://localhost:8765",
            is_active=True,
        )
    )
    await chat_service.get_or_create_room(db, "demo-room", name="Demo Room")
    source_message = await chat_service.save_message(
        db=db,
        room_id="demo-room",
        sender_id="human-1",
        sender_type="human",
        sender_name="Human",
        content="@Codex 你在吗",
    )

    await _check_mentions_and_forward(
        source_room_id="demo-room",
        message=source_message,
        content=source_message.content,
    )

    agent_room = await db.get(Room, "_agent_codex")
    assert agent_room is not None
    assert agent_room.is_active is False

    result = await db.execute(
        select(Message).where(
            Message.room_id == "_agent_codex",
            Message.msg_type == "task",
        )
    )
    task_message = result.scalar_one()
    assert task_message.parent_id == source_message.id
    assert '"task_id"' in task_message.content
