#!/usr/bin/env python3
"""真实 CLI 端到端测试：启动服务器 + 启动 gateway + 发消息 + 收回复。

使用本机安装的 claude / codex CLI，不消耗大量 CPU（AI 推理在云端）。
"""

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

os.environ["MAPR_DATABASE_URL"] = f"sqlite+aiosqlite:///{PROJECT_ROOT}/e2e_cli_test.db"
os.environ["MAPR_AUTH_SECRET_KEY"] = "e2e-cli-test"

import httpx
import uvicorn

BASE = "http://127.0.0.1:8765"


async def wait_for_server(client, timeout=10):
    for _ in range(int(timeout / 0.5)):
        try:
            r = await client.get(f"{BASE}/health")
            if r.status_code == 200:
                return True
        except Exception:
            pass
        await asyncio.sleep(0.5)
    return False


async def main():
    passed = failed = 0

    def check(name, cond, detail=""):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"  ✅ {name}")
        else:
            failed += 1
            print(f"  ❌ {name} {detail}")

    # 1. Start server
    print("\n[1] 启动后端服务器")
    from app.main import app as fastapi_app
    config = uvicorn.Config(fastapi_app, host="127.0.0.1", port=8765, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    async with httpx.AsyncClient(timeout=120) as client:
        ok = await wait_for_server(client)
        check("服务器就绪", ok)

        # 2. Register user + create room
        print("\n[2] 注册用户 + 创建房间")
        username = f"cli_test_{int(time.time())}"
        r = await client.post(f"{BASE}/api/v1/auth/register", json={
            "username": username, "password": "test123", "display_name": "CLI Tester"
        })
        token = r.json().get("access_token", "")
        headers = {"Authorization": f"Bearer {token}"}
        check("注册成功", len(token) > 10)

        r = await client.post(f"{BASE}/api/v1/rooms", json={"name": "CLI Test Room"}, headers=headers)
        room_id = r.json().get("room", {}).get("id", "")
        check("房间创建", len(room_id) > 5)

        # 3. Test Claude CLI directly (not through gateway, to isolate issues)
        print("\n[3] 直接调用 Claude CLI")
        try:
            proc = await asyncio.create_subprocess_exec(
                "claude", "-p", "回复两个字：收到",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(PROJECT_ROOT),
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
            cli_output = stdout.decode().strip()
            check("Claude CLI 有输出", len(cli_output) > 0, f"stderr: {stderr.decode()[:100]}")
            print(f"     输出: {cli_output[:100]}")
        except FileNotFoundError:
            check("Claude CLI 存在", False, "命令未找到")
            cli_output = ""
        except asyncio.TimeoutError:
            check("Claude CLI 响应", False, "超时(60s)")
            cli_output = ""

        # 4. Test Codex CLI
        print("\n[4] 直接调用 Codex CLI")
        try:
            proc = await asyncio.create_subprocess_exec(
                "codex", "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            codex_version = stdout.decode().strip()
            check("Codex CLI 可用", "codex" in codex_version.lower())
            print(f"     版本: {codex_version}")
        except Exception as e:
            check("Codex CLI", False, str(e)[:80])

        # 5. Test gateway registration flow (without actually running AI)
        print("\n[5] Gateway 注册流程")
        r = await client.post(f"{BASE}/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0", "method": "agent/register",
            "params": {"name": "ClaudeGateway", "url": "http://localhost:9999"},
            "id": "gw-1",
        })
        reg = r.json().get("result", {})
        check("Gateway Agent 注册", reg.get("status") in ("registered", "updated"))

        # Re-register should update
        r = await client.post(f"{BASE}/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0", "method": "agent/register",
            "params": {"name": "ClaudeGateway", "url": "http://localhost:9999"},
            "id": "gw-2",
        })
        reg2 = r.json().get("result", {})
        check("重复注册返回 updated", reg2.get("status") == "updated")
        check("ID 相同（去重生效）", reg2.get("id") == reg.get("id"))

        # 6. Dialogue loop between two agents
        print("\n[6] Agent 对话循环")
        r = await client.post(f"{BASE}/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0", "method": "dialogues/create",
            "params": {
                "room_id": room_id,
                "initiator_agent": "ClaudeGateway",
                "participants": ["CodexAgent"],
                "max_turns": 4,
                "duration_seconds": 60,
            },
            "id": "dlg-1",
        })
        dlg = r.json().get("result", {})
        check("对话创建", dlg.get("status") == "active")
        dlg_id = dlg.get("dialogue_id", "")

        # Send messages back and forth
        for turn in range(1, 3):
            sender = "ClaudeGateway" if turn % 2 == 1 else "CodexAgent"
            r = await client.post(f"{BASE}/a2a/dialogue-rpc", json={
                "jsonrpc": "2.0", "method": "dialogues/send",
                "params": {
                    "dialogue_id": dlg_id,
                    "content": f"第{turn}轮消息 from {sender}",
                    "sender_id": f"{sender.lower()}-id",
                    "sender_name": sender,
                },
                "id": f"turn-{turn}",
            })
            result = r.json().get("result", {})
            check(f"第{turn}轮消息发送", result.get("status") == "sent")

        # End dialogue
        r = await client.post(f"{BASE}/a2a/dialogue-rpc", json={
            "jsonrpc": "2.0", "method": "dialogues/end",
            "params": {"dialogue_id": dlg_id},
            "id": "end-1",
        })
        end_result = r.json().get("result", {})
        check("对话结束", end_result.get("status") == "ended")

        # 7. Check message history
        print("\n[7] 消息历史验证")
        r = await client.get(f"{BASE}/api/v1/rooms/{room_id}/messages?limit=50", headers=headers)
        msgs = r.json().get("messages", [])
        check("消息已持久化", len(msgs) >= 2, f"got {len(msgs)}")

    server.should_exit = True
    thread.join(timeout=5)

    print(f"\n{'='*40}")
    print(f"通过: {passed} | 失败: {failed}")
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    asyncio.run(main())
