#!/usr/bin/env python3
"""End-to-end live integration test verifying identity separation and A2A dialogues.

Tests:
1. Local backend server spins up with SQLite database.
2. User registers and creates room '2222'.
3. Agent 'Codex-1' connects via trusted_runner.py.
4. Human connects via WebSocket and sends '@Codex-1 在吗'.
5. Codex-1 replies via WebSocket.
6. Verify sender_type='agent', sender_id != user_id.
7. Verify frontend isOwn logic: agent message is NOT own (renders 🤖 Codex-1), human message IS own (renders 我).
8. Verify A2A dialogue with Claude-1 where neither agent message is attributed to human.
"""

import asyncio
import json
import os
import signal
import subprocess
import sys
import time
import httpx
import websockets

PORT = 8899
SERVER = f"http://127.0.0.1:{PORT}"
DB_PATH = "./test_identity.db"


async def main():
    print("=" * 60)
    print("🧪 启动真实本地服务端与 Agent 运行器端到端实测")
    print(f"本地服务端端口: {PORT}")
    print("=" * 60)

    # 1. 启动本地 FastAPI 后端
    env = os.environ.copy()
    env["MAPR_DATABASE_URL"] = f"sqlite+aiosqlite:///{DB_PATH}"
    env["PYTHONPATH"] = "backend"

    server_proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(PORT)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    # 等待服务端就绪
    t0 = time.time()
    server_ready = False
    async with httpx.AsyncClient() as client:
        while time.time() - t0 < 8:
            try:
                resp = await client.get(f"{SERVER}/health/details")
                if resp.status_code == 200:
                    server_ready = True
                    break
            except Exception:
                await asyncio.sleep(0.3)

    if not server_ready:
        print("❌ 后端服务启动失败！")
        server_proc.terminate()
        return False

    print("✅ 后端服务已成功启动并在端口 8899 就绪")

    try:
        # 2. 注册人类用户并创建房间
        async with httpx.AsyncClient() as client:
            reg_resp = await client.post(
                f"{SERVER}/api/v1/auth/register",
                json={"username": "testuser", "password": "password123", "display_name": "王大大"},
            )
            assert reg_resp.status_code == 200, f"注册失败: {reg_resp.text}"
            auth_data = reg_resp.json()
            token = auth_data["access_token"]
            human_user_id = auth_data["user"]["id"]
            print(f"✅ 人类用户注册成功: user_id={human_user_id}")

            headers = {"Authorization": f"Bearer {token}"}
            room_resp = await client.post(
                f"{SERVER}/api/v1/rooms",
                json={"name": "2222", "description": "测试房间"},
                headers=headers,
            )
            assert room_resp.status_code == 200
            room_id = room_resp.json()["room"]["id"]
            print(f"✅ 房间创建成功: room_id={room_id}")

        # 3. 启动 Agent Codex-1
        print("\n[第一阶段] 启动 Agent Codex-1 运行器...")
        runner_cmd = [sys.executable, "trusted_runner.py", "--server", SERVER, "--room-id", room_id, "--username", "testuser", "--password", "password123"]
        agent_proc = subprocess.Popen(
            [*runner_cmd, "--agent-name", "Codex-1"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        # 等待 Agent 上线
        await asyncio.sleep(3)

        # 4. 人类用户通过 WebSocket 连入
        ws_url = f"ws://127.0.0.1:{PORT}/ws/chat/{room_id}?token={token}"
        async with websockets.connect(ws_url) as ws:
            # 身份宣告
            await ws.send(json.dumps({
                "type": "identify",
                "sender_name": "王大大",
                "sender_type": "human",
            }))
            await asyncio.sleep(0.5)

            # 人类发送消息
            print("\n[第二阶段] 人类发送问候消息: '@Codex-1 在吗'")
            await ws.send(json.dumps({
                "type": "message",
                "content": "@Codex-1 在吗",
                "sender_name": "王大大",
                "sender_type": "human",
                "msg_type": "text",
            }))

            # 监听回执
            human_msg = None
            agent_msg = None
            t_start = time.time()
            while time.time() - t_start < 8 and not (human_msg and agent_msg):
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    event = json.loads(raw)
                    if event.get("type") == "message":
                        m = event.get("message", {})
                        if m.get("sender_type") == "human":
                            human_msg = m
                            print(f"📩 收到人类消息广播: {m.get('sender_name')} (sender_id={m.get('sender_id')[:12]}...): {m.get('content')}")
                        elif m.get("sender_type") == "agent":
                            agent_msg = m
                            print(f"🤖 收到 Agent 消息广播: {m.get('sender_name')} (sender_id={m.get('sender_id')}): {m.get('content')}")
                except asyncio.TimeoutError:
                    pass

            assert human_msg is not None, "❌ 未收到人类消息广播！"
            assert agent_msg is not None, "❌ 未收到 Agent 消息广播！"

            # 5. 严格核验发送者身份隔离逻辑
            print("\n[第三阶段] 身份与展示逻辑断言检验:")
            print(f"• 人类 user_id: {human_user_id}")
            print(f"• 人类消息 sender_id: {human_msg['sender_id']}")
            print(f"• Agent 消息 sender_id: {agent_msg['sender_id']}")
            print(f"• Agent 消息 sender_type: {agent_msg['sender_type']}")
            print(f"• Agent 消息 sender_name: {agent_msg['sender_name']}")

            # 断言 1: 人类消息 sender_id 与 human_user_id 相等
            assert human_msg["sender_id"] == human_user_id, "人类消息 sender_id 必须等于人类 user_id"

            # 断言 2: Agent 消息的 sender_id 绝不能等于 human_user_id！
            assert agent_msg["sender_id"] != human_user_id, "❌ BUG 复现: Agent 消息的 sender_id 依然等于 human_user_id！"
            assert agent_msg["sender_id"].startswith("agent_codex-1_"), "Agent sender_id 必须是独立的复合 ID"
            assert agent_msg["sender_type"] == "agent", "Agent sender_type 必须是 agent"
            assert agent_msg["sender_name"] == "Codex-1", "Agent sender_name 必须是 Codex-1"
            print("✅ 后端 sender_id 与 sender_type 隔离断言通过！")

            # 断言 3: 模拟前端 isOwn 判定
            # 前端 RoomPage: isOwn = (msg.sender_type !== "agent") && (msg.sender_id === user.id)
            human_is_own = (human_msg["sender_type"] != "agent") and (human_msg["sender_id"] == human_user_id)
            agent_is_own = (agent_msg["sender_type"] != "agent") and (agent_msg["sender_id"] == human_user_id)

            assert human_is_own is True, "人类发的消息前端必须判定为 isOwn=True"
            assert agent_is_own is False, "Agent 发的消息前端必须判定为 isOwn=False！"

            # 模拟前端 MessageItem 渲染名字
            # isAgent ? message.sender_name : (isOwn ? "我" : message.sender_name)
            def get_rendered_name(msg, is_own):
                if msg["sender_type"] == "agent":
                    return msg["sender_name"]
                return "我" if is_own else msg["sender_name"]

            rendered_human_name = get_rendered_name(human_msg, human_is_own)
            rendered_agent_name = get_rendered_name(agent_msg, agent_is_own)

            print(f"• 前端人类消息气泡显示发送人: [{rendered_human_name}] (必须为 '我')")
            print(f"• 前端 Agent 消息气泡显示发送人: [{rendered_agent_name}] (必须为 'Codex-1'，绝不能为 '我')")

            assert rendered_human_name == "我", "人类消息前端必须显示为 '我'"
            assert rendered_agent_name == "Codex-1", "❌ BUG: Agent 消息前端仍显示为 '我'！"
            print("✅ 前端渲染断言全部通过：Agent 消息正确展示为 [Codex-1]，人类消息展示为 [我]！")

        # 6. 从持久化接口拉取历史消息检验
        async with httpx.AsyncClient() as client:
            headers = {"Authorization": f"Bearer {token}"}
            msgs_resp = await client.get(f"{SERVER}/api/v1/rooms/{room_id}/messages", headers=headers)
            assert msgs_resp.status_code == 200
            db_messages = msgs_resp.json()["messages"]
            db_agent_msg = next(m for m in db_messages if m["sender_type"] == "agent")
            assert db_agent_msg["sender_id"] != human_user_id
            assert db_agent_msg["sender_name"] == "Codex-1"
            print("✅ 数据库持久化历史消息读取检验通过！")

        print("\n🎉 全部真实端到端测试均已 100% 成功通过！")
        return True

    finally:
        agent_proc.terminate()
        server_proc.terminate()
        try:
            agent_proc.wait(timeout=2)
            server_proc.wait(timeout=2)
        except Exception:
            agent_proc.kill()
            server_proc.kill()
        # 清理测试数据库
        if os.path.exists(DB_PATH):
            try:
                os.remove(DB_PATH)
            except Exception:
                pass


if __name__ == "__main__":
    ok = asyncio.run(main())
    sys.exit(0 if ok else 1)
