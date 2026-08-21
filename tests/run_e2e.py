#!/usr/bin/env python3
"""端到端集成测试 — 单进程方案。"""

import asyncio
import os
import sys
import threading
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

os.environ["MAPR_DATABASE_URL"] = f"sqlite+aiosqlite:///{PROJECT_ROOT}/e2e_test.db"
os.environ["MAPR_AUTH_SECRET_KEY"] = "e2e-test-secret"

import httpx
import uvicorn


async def main():
    from app.main import app as fastapi_app

    config = uvicorn.Config(fastapi_app, host="127.0.0.1", port=8765, log_level="warning")
    server = uvicorn.Server(config)
    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    base = "http://127.0.0.1:8765"
    for _ in range(30):
        try:
            async with httpx.AsyncClient() as c:
                r = await c.get(f"{base}/health")
                if r.status_code == 200:
                    break
        except Exception:
            pass
        await asyncio.sleep(0.3)
    print("✅ 服务器已启动（含自动建表）")

    passed = 0
    failed = 0

    def check(name, cond, detail=""):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"  ✅ {name}")
        else:
            failed += 1
            print(f"  ❌ {name} {detail}")

    async with httpx.AsyncClient(timeout=10) as client:

        print("\n[1] 健康检查")
        r = await client.get(f"{base}/health")
        check("GET /health", r.status_code == 200)

        print("\n[2] Agent Card (A2A v1.0)")
        r = await client.get(f"{base}/.well-known/agent-card.json")
        check("Agent Card", r.status_code == 200)
        card = r.json()
        check("has name", "name" in card)
        check("has skills", len(card.get("skills", [])) > 0)

        print("\n[3] 用户注册")
        username = f"e2e_{int(time.time())}"
        r = await client.post(f"{base}/api/v1/auth/register", json={
            "username": username, "password": "test123", "display_name": "E2E"
        })
        check("register", r.status_code in (200, 201), f"got {r.status_code}")
        token = r.json().get("access_token", "")
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        check("token", len(token) > 10)

        print("\n[4] 创建房间")
        r = await client.post(f"{base}/api/v1/rooms", json={"name": "E2E Room"}, headers=headers)
        check("create room", r.status_code in (200, 201), f"got {r.status_code}")
        room_id = r.json().get("room", {}).get("id", "")
        check("room_id", len(room_id) > 5)

        print("\n[5] Agent 注册")
        r = await client.post(f"{base}/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0", "method": "agent/register",
            "params": {"name": "EchoAgent", "url": "local://echo"},
            "id": "r1",
        })
        check("agent/register", r.status_code == 200)

        print("\n[6] 对话循环（消息循环协作）")
        r = await client.post(f"{base}/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0", "method": "dialogues/create",
            "params": {"room_id": room_id, "initiator_agent": "A", "participants": ["B"]},
            "id": "d1",
        })
        check("dialogues/create", r.status_code == 200)
        dlg_id = r.json().get("result", {}).get("dialogue_id", "")

        r = await client.post(f"{base}/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0", "method": "dialogues/send",
            "params": {"dialogue_id": dlg_id, "content": "hello", "sender_id": "a", "sender_name": "A"},
            "id": "d2",
        })
        check("dialogues/send", r.status_code == 200)
        check("target=B", r.json().get("result", {}).get("target_agent") == "B")

        r = await client.post(f"{base}/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0", "method": "dialogues/end",
            "params": {"dialogue_id": dlg_id}, "id": "d3",
        })
        check("dialogues/end", r.status_code == 200)

        print("\n[7] 消息发送 + 任务列表")
        r = await client.post(f"{base}/api/v1/rooms/{room_id}/messages", json={
            "content": "@EchoAgent hello", "msg_type": "text"
        }, headers=headers)
        # Message sending is via WebSocket, verify GET works
        r = await client.get(f"{base}/api/v1/rooms/{room_id}/messages", headers=headers)
        check("get messages", r.status_code == 200)

        r = await client.get(f"{base}/api/v1/rooms/{room_id}/tasks", headers=headers)
        check("task list", r.status_code == 200)

    server.should_exit = True
    server_thread.join(timeout=5)

    print(f"\n{'='*40}")
    print(f"通过: {passed} | 失败: {failed}")
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    asyncio.run(main())
