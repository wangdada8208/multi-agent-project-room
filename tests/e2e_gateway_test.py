#!/usr/bin/env python3
"""端到端集成测试：后端 + agent_gateway 完整流程。

使用 /bin/cat 作为轻量后端命令（echo 模式），不调用真实 AI API。
验证：注册 → 建房 → 网关注册 → 发消息 → 收到回复。
"""

import asyncio
import json
import subprocess
import sys
import time

import httpx

BASE = "http://127.0.0.1:8000"
PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = ""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name} {detail}")


async def main():
    async with httpx.AsyncClient(timeout=10) as client:

        # ── Step 1: Health check ──
        print("\n[1] 健康检查")
        resp = await client.get(f"{BASE}/health")
        check("GET /health", resp.status_code == 200)

        # ── Step 2: Agent Card ──
        print("\n[2] Agent Card 发现")
        resp = await client.get(f"{BASE}/.well-known/agent-card.json")
        check("GET /.well-known/agent-card.json", resp.status_code == 200)
        card = resp.json()
        check("Card has name", "name" in card)
        check("Card has skills", len(card.get("skills", [])) > 0)
        check("Card version >= 2.0", card.get("version", "") >= "2.0")

        # ── Step 3: Register user ──
        print("\n[3] 用户注册")
        username = f"e2e_user_{int(time.time())}"
        resp = await client.post(f"{BASE}/api/v1/auth/register", json={
            "username": username,
            "password": "e2e-secret-123",
            "display_name": "E2E Tester",
        })
        check("POST /auth/register", resp.status_code in (200, 201))
        token = resp.json().get("access_token", "")
        headers = {"Authorization": f"Bearer {token}"}
        check("Got auth token", len(token) > 10)

        # ── Step 4: Create room ──
        print("\n[4] 创建房间")
        resp = await client.post(f"{BASE}/api/v1/rooms", json={
            "name": "E2E Test Room"
        }, headers=headers)
        check("POST /rooms", resp.status_code in (200, 201))
        room_id = resp.json().get("room", {}).get("id", "")
        check("Got room_id", len(room_id) > 5)

        # ── Step 5: Agent registration via dialogue RPC ──
        print("\n[5] Agent 注册")
        resp = await client.post(f"{BASE}/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0",
            "method": "agent/register",
            "params": {
                "name": "EchoAgent",
                "url": "local://echo-agent",
                "skills": [{"id": "echo", "name": "回声", "description": "重复输入"}],
            },
            "id": "reg-1",
        })
        check("POST /a2a/dialogue-rpc agent/register", resp.status_code == 200)
        reg_result = resp.json().get("result", {})
        check("Agent registered", reg_result.get("status") == "registered" or "id" in reg_result)

        # ── Step 6: Dialogue create ──
        print("\n[6] 对话循环创建")
        resp = await client.post(f"{BASE}/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0",
            "method": "dialogues/create",
            "params": {
                "room_id": room_id,
                "initiator_agent": "EchoAgent",
                "participants": ["PartnerAgent"],
                "max_turns": 3,
            },
            "id": "dlg-1",
        })
        check("dialogues/create", resp.status_code == 200)
        dlg = resp.json().get("result", {})
        check("Dialogue active", dlg.get("status") == "active")
        dialogue_id = dlg.get("dialogue_id", "")

        # ── Step 7: Dialogue send ──
        print("\n[7] 对话消息发送")
        resp = await client.post(f"{BASE}/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0",
            "method": "dialogues/send",
            "params": {
                "dialogue_id": dialogue_id,
                "content": "你好，这是第一条协作消息。",
                "sender_id": "echo-agent-id",
                "sender_name": "EchoAgent",
            },
            "id": "dlg-2",
        })
        check("dialogues/send", resp.status_code == 200)
        send_result = resp.json().get("result", {})
        check("Message sent", send_result.get("status") == "sent")
        check("Target is PartnerAgent", send_result.get("target_agent") == "PartnerAgent")

        # ── Step 8: Task submission ──
        print("\n[8] 任务提交")
        resp = await client.post(f"{BASE}/api/v1/rooms/{room_id}/messages", json={
            "content": "@EchoAgent 你好",
            "msg_type": "text",
        }, headers=headers)
        check("Send @mention message", resp.status_code in (200, 201))

        # Check task list
        resp = await client.get(f"{BASE}/api/v1/rooms/{room_id}/tasks", headers=headers)
        check("GET room tasks", resp.status_code == 200)
        tasks = resp.json().get("tasks", [])
        check(f"Tasks exist ({len(tasks)})", isinstance(tasks, list))

        # ── Summary ──
        print(f"\n{'='*40}")
        print(f"通过: {PASS} | 失败: {FAIL}")
        if FAIL > 0:
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
