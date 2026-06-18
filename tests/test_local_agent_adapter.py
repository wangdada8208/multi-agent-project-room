"""Test local adapter dialogue handling."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from local_agent_adapter import LocalAgentAdapter


class FakeWebSocket:
    def __init__(self):
        self.sent = []

    async def send(self, payload: str):
        self.sent.append(json.loads(payload))


def test_default_room_connects_to_agent_channel():
    """Omitting --room should connect the adapter to its private agent channel."""
    adapter = LocalAgentAdapter(
        server="https://hub.example.com",
        room=None,
        agent_name="Codex",
        agent_id="codex-local",
        command=["codex"],
        a2a_port=8765,
        ai_timeout=120,
    )

    assert adapter.room == "_agent_codex"
    assert adapter.ws_url == "wss://hub.example.com/ws/chat/_agent_codex"


def test_call_local_ai_returns_friendly_usage_limit(monkeypatch):
    """CLI usage-limit failures should not leak raw stderr into chat."""
    adapter = LocalAgentAdapter(
        server="https://hub.example.com",
        room=None,
        agent_name="Codex",
        agent_id="codex-local",
        command=["codex"],
        a2a_port=8765,
        ai_timeout=120,
    )

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=1,
            stdout="",
            stderr="ERROR: You've hit your usage limit. Upgrade to Pro.",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    response = adapter._call_local_ai("hello")

    assert "额度限制" in response
    assert "Upgrade to Pro" not in response


@pytest.mark.asyncio
async def test_agent_dialogue_message_triggers_without_mention(monkeypatch):
    """Active dialogue messages should trigger even when @Codex is absent."""
    adapter = LocalAgentAdapter(
        server="http://test",
        room="room-1",
        agent_name="Codex",
        agent_id="codex-local",
        command=["codex"],
        a2a_port=8765,
        ai_timeout=120,
    )
    ws = FakeWebSocket()
    sent_dialogue = {}

    monkeypatch.setattr(adapter, "_call_local_ai", lambda prompt: "我接上了。")

    async def fake_send_dialogue_message(dialogue_id, target_agent, content):
        sent_dialogue.update(
            {
                "dialogue_id": dialogue_id,
                "target_agent": target_agent,
                "content": content,
            }
        )

    monkeypatch.setattr(adapter, "_send_dialogue_message", fake_send_dialogue_message)

    await adapter._handle_message(
        {
            "type": "agent_dialogue_message",
            "dialogue": {
                "dialogue_id": "dlg-1",
                "participants": ["Codex", "Claude"],
                "status": "active",
                "current_turn": 1,
                "max_turns": 8,
            },
            "message": {
                "id": "msg-1",
                "content": "我们继续看接口。",
                "sender_id": "claude-local",
                "sender_name": "Claude",
                "sender_type": "agent",
                "target_agent": "Codex",
            },
        },
        ws,
    )

    assert sent_dialogue == {
        "dialogue_id": "dlg-1",
        "target_agent": "Claude",
        "content": "我接上了。",
    }
    assert ws.sent == [{"type": "typing", "sender_id": "codex-local"}]


@pytest.mark.asyncio
async def test_unrelated_agent_message_without_mention_is_ignored(monkeypatch):
    """Plain chat messages still require @Agent unless they are dialogue events."""
    adapter = LocalAgentAdapter(
        server="http://test",
        room="room-1",
        agent_name="Codex",
        agent_id="codex-local",
        command=["codex"],
        a2a_port=8765,
        ai_timeout=120,
    )
    ws = FakeWebSocket()
    called = False

    async def fake_send_dialogue_message(dialogue_id, target_agent, content):
        nonlocal called
        called = True

    monkeypatch.setattr(adapter, "_send_dialogue_message", fake_send_dialogue_message)

    await adapter._handle_message(
        {
            "type": "message",
            "message": {
                "id": "msg-2",
                "content": "我们继续看接口。",
                "sender_id": "claude-local",
                "sender_name": "Claude",
                "sender_type": "agent",
            },
        },
        ws,
    )

    assert called is False
    assert ws.sent == []
