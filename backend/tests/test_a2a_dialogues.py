"""Test A2A relay dialogues for no-mention agent conversations."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_dialogue_start_send_and_end(client: AsyncClient):
    """Dialogue RPCs should create, relay, and end a two-agent session."""
    start_resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/start",
            "params": {
                "room_id": "dialogue-room",
                "initiator_agent": "Codex",
                "participants": ["Codex", "Claude"],
                "duration_seconds": 30,
                "max_turns": 8,
            },
            "id": "dialogue-start",
        },
    )

    assert start_resp.status_code == 200
    start_result = start_resp.json()["result"]
    assert start_result["status"] == "active"
    assert start_result["participants"] == ["Codex", "Claude"]
    dialogue_id = start_result["dialogue_id"]

    send_resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/send",
            "params": {
                "dialogue_id": dialogue_id,
                "room_id": "dialogue-room",
                "sender_id": "codex-local",
                "sender_name": "Codex",
                "target_agent": "Claude",
                "content": "我们先对齐当前项目状态。",
            },
            "id": "dialogue-send",
        },
    )

    assert send_resp.status_code == 200
    send_result = send_resp.json()["result"]
    assert send_result["status"] == "sent"
    assert send_result["dialogue_id"] == dialogue_id
    assert send_result["target_agent"] == "Claude"
    assert send_result["current_turn"] == 1

    end_resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/end",
            "params": {"dialogue_id": dialogue_id, "reason": "test complete"},
            "id": "dialogue-end",
        },
    )

    assert end_resp.status_code == 200
    end_result = end_resp.json()["result"]
    assert end_result["status"] == "ended"
    assert end_result["reason"] == "test complete"


@pytest.mark.asyncio
async def test_dialogue_rejects_send_after_turn_limit(client: AsyncClient):
    """Dialogue sessions should stop relaying once max_turns is reached."""
    start_resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/start",
            "params": {
                "room_id": "dialogue-room",
                "initiator_agent": "Codex",
                "participants": ["Codex", "Claude"],
                "duration_seconds": 30,
                "max_turns": 1,
            },
            "id": "dialogue-start-limit",
        },
    )
    dialogue_id = start_resp.json()["result"]["dialogue_id"]

    first_resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/send",
            "params": {
                "dialogue_id": dialogue_id,
                "room_id": "dialogue-room",
                "sender_id": "codex-local",
                "sender_name": "Codex",
                "target_agent": "Claude",
                "content": "第一轮。",
            },
            "id": "dialogue-send-first",
        },
    )
    assert first_resp.json()["result"]["status"] == "sent"

    second_resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/send",
            "params": {
                "dialogue_id": dialogue_id,
                "room_id": "dialogue-room",
                "sender_id": "claude-local",
                "sender_name": "Claude",
                "target_agent": "Codex",
                "content": "第二轮。",
            },
            "id": "dialogue-send-second",
        },
    )

    assert second_resp.status_code == 200
    assert second_resp.json()["error"]["message"] == "Dialogue is not active"
