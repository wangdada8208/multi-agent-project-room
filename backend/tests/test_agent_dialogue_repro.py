"""Tests for TrustedRunner A2A dialogue capabilities and room mention handling."""

import asyncio
import json
import pytest
from httpx import AsyncClient

from app.models.room import Room
from app.models.user import User
from app.chat import service as chat_service
from trusted_runner import TrustedRunner


@pytest.mark.asyncio
async def test_trusted_runner_quick_replies():
    """Verify runner produces quick replies for greetings and status."""
    runner = TrustedRunner(agent_name="Codex-1")
    assert runner.is_mentioned("@Codex-1 在吗")
    assert runner.is_mentioned("@codex-1 你好")
    assert not runner.is_mentioned("@Claude 你好")

    reply = runner.quick_reply("@Codex-1 在吗")
    assert reply is not None
    assert "Codex-1" in reply
    assert "在线" in reply

    status_reply = runner.quick_reply("@Codex-1 状态")
    assert status_reply is not None
    assert "就绪" in status_reply or "正常" in status_reply


@pytest.mark.asyncio
async def test_trusted_runner_detect_dialogue_request():
    """Verify runner detects peer dialogue request from natural language."""
    runner = TrustedRunner(agent_name="Codex-1")

    target, topic = runner.detect_dialogue_request("@Codex-1 请和 @Claude-1 讨论当前架构设计")
    assert target == "Claude-1"
    assert "架构" in topic

    target2, topic2 = runner.detect_dialogue_request("@Codex-1 与 @Claude 协作对齐接口")
    assert target == "Claude-1" or target2 == "Claude"
    assert "接口" in topic2

    # Normal mention without peer should return None
    no_target, no_topic = runner.detect_dialogue_request("@Codex-1 在吗")
    assert no_target is None


@pytest.mark.asyncio
async def test_trusted_runner_a2a_dialogue_cycle(client: AsyncClient, auth_headers: dict):
    """Verify end-to-end A2A dialogue between two TrustedRunner instances."""
    room_id = "test-a2a-collab-room"

    # Register room
    await client.post(
        "/api/v1/rooms",
        json={"name": "A2A Collab", "description": "collab"},
        headers=auth_headers,
    )

    runner_a = TrustedRunner(agent_name="Codex-1", server_url="http://testserver", room_id=room_id)
    runner_b = TrustedRunner(agent_name="Claude-1", server_url="http://testserver", room_id=room_id)

    token = auth_headers["Authorization"].replace("Bearer ", "")
    runner_a.token = token
    runner_b.token = token
    runner_a.user_id = "test-user-id"
    runner_b.user_id = "test-user-id"

    # Mock client on runner
    runner_a._http_client = client
    runner_b._http_client = client

    # 1. Runner A registers agent card
    reg_ok = await runner_a.register_agent_card(token)
    assert reg_ok is True

    # 2. Runner A starts dialogue with Runner B
    dialogue_id = await runner_a.start_dialogue(
        target_agent="Claude-1",
        topic="重构通信协议",
        duration_seconds=30,
        max_turns=4,
    )
    assert dialogue_id is not None

    # 3. Check dialogue status from server
    status_resp = await client.post(
        "/a2a/dialogue-rpc",
        headers=auth_headers,
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/status",
            "params": {"dialogue_id": dialogue_id},
            "id": "status-1",
        },
    )
    assert status_resp.status_code == 200
    status_data = status_resp.json()["result"]
    assert status_data["status"] == "active"
    assert status_data["current_turn"] == 1

    # 4. Runner B receives message and replies
    simulated_msg = {
        "id": "msg-turn-1",
        "dialogue_id": dialogue_id,
        "sender_name": "Codex-1",
        "target_agent": "Claude-1",
        "content": "@Claude-1 我们围绕“重构通信协议”开始协作讨论，请先给出你的方案或判断。",
    }
    b_reply_id = await runner_b.handle_dialogue_message(
        dialogue=status_data,
        msg=simulated_msg,
    )
    assert b_reply_id is not None

    # 5. Verify turn advanced on server
    status_resp2 = await client.post(
        "/a2a/dialogue-rpc",
        headers=auth_headers,
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/status",
            "params": {"dialogue_id": dialogue_id},
            "id": "status-2",
        },
    )
    status_data2 = status_resp2.json()["result"]
    assert status_data2["current_turn"] == 2


@pytest.mark.asyncio
async def test_agent_message_distinct_sender_identity(client: AsyncClient, auth_headers: dict):
    """Verify that agent messages are saved with distinct agent composite sender_id and not the human user_id."""
    room_resp = await client.post(
        "/api/v1/rooms",
        json={"name": "Identity Room", "description": "test", "transport": "hub"},
        headers=auth_headers,
    )
    room_id = room_resp.json()["room"]["id"]

    # Start dialogue
    d_resp = await client.post(
        "/a2a/dialogue-rpc",
        headers=auth_headers,
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/create",
            "params": {
                "room_id": room_id,
                "initiator_agent": "Codex-1",
                "participants": ["Codex-1", "Claude-1"],
            },
            "id": "id-create",
        },
    )
    dialogue_id = d_resp.json()["result"]["dialogue_id"]

    # Send dialogue message as agent
    msg_resp = await client.post(
        "/a2a/dialogue-rpc",
        headers=auth_headers,
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/send",
            "params": {
                "dialogue_id": dialogue_id,
                "room_id": room_id,
                "sender_id": "agent_codex_1_custom",
                "sender_name": "Codex-1",
                "target_agent": "Claude-1",
                "content": "我是 Codex-1，在线协作中。",
            },
            "id": "id-send",
        },
    )
    assert msg_resp.status_code == 200

    # Retrieve room messages
    msgs_resp = await client.get(f"/api/v1/rooms/{room_id}/messages", headers=auth_headers)
    assert msgs_resp.status_code == 200
    messages = msgs_resp.json()["messages"]
    agent_msg = next(m for m in messages if m["content"] == "我是 Codex-1，在线协作中。")

    assert agent_msg["sender_type"] == "agent"
    assert agent_msg["sender_name"] == "Codex-1"

    # Agent sender_id must not collide with human user id
    current_user_resp = await client.get("/api/v1/auth/me", headers=auth_headers)
    human_user_id = current_user_resp.json()["user"]["id"]
    assert agent_msg["sender_id"] != human_user_id
    assert agent_msg["sender_id"] == "agent_codex_1_custom"
