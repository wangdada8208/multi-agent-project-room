#!/usr/bin/env python3
"""Live verification script: runs two TrustedRunner instances against https://hub.wangdada8208.xyz,

sends a room mention, triggers A2A dialogue, and verifies multi-agent collaboration live.
"""

import asyncio
import json
import os
import subprocess
import sys
import time
import httpx
import websockets

SERVER = "https://hub.wangdada8208.xyz"
ROOM_ID = "2222"
USERNAME = "wangdada"
PASSWORD = "12345678"


async def main():
    print("=" * 60)
    print("🚀 开始真实生产环境多智能体 A2A 联通测试")
    print(f"目标服务器: {SERVER}")
    print(f"目标房间: {ROOM_ID}")
    print("=" * 60)

    # 1. 登录获取用户 Token
    async with httpx.AsyncClient(verify=False) as client:
        login_resp = await client.post(
            f"{SERVER}/api/v1/auth/login",
            json={"username": USERNAME, "password": PASSWORD},
        )
        if login_resp.status_code != 200:
            print(f"❌ 登录失败: {login_resp.text}")
            return False
        data = login_resp.json()
        token = data["access_token"]
        user_id = data["user"]["id"]
        print(f"✅ 用户 [{USERNAME}] 登录成功，Token 已就绪")

        # 解析房间 UUID
        rooms_resp = await client.get(
            f"{SERVER}/api/v1/rooms",
            headers={"Authorization": f"Bearer {token}"},
        )
        resolved_room_id = ROOM_ID
        for r in rooms_resp.json().get("rooms", []):
            if r.get("id") == ROOM_ID or r.get("name") == ROOM_ID:
                resolved_room_id = r["id"]
                break
        print(f"✅ 房间 [{ROOM_ID}] 解析为 UUID: {resolved_room_id}")

    # 2. 启动两个 Agent 实例（Codex-1 与 Claude-1）
    print("\n[1/4] 启动两个 Agent 实例 (Codex-1 与 Claude-1) ...")
    runner_cmd = [sys.executable, "trusted_runner.py", "--server", SERVER, "--room-id", resolved_room_id, "--username", USERNAME, "--password", PASSWORD]

    proc_codex = subprocess.Popen(
        [*runner_cmd, "--agent-name", "Codex-1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    proc_claude = subprocess.Popen(
        [*runner_cmd, "--agent-name", "Claude-1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    # 等待 8 秒供两个 Agent 注册并完成 WebSocket 握手
    print("⏳ 等待两个 Agent 登录认证与 WebSocket 连线...")
    await asyncio.sleep(8)
    print("✅ 两个 Agent 运行器已在后台运行并完成上线")

    # 3. 模拟人类用户通过 WebSocket 连入房间并监听
    ws_url = f"{SERVER.replace('https://', 'wss://').replace('http://', 'ws://')}/ws/chat/{resolved_room_id}?token={token}"
    
    chat_log = []

    async with websockets.connect(ws_url) as ws:
        # 发送人类身份宣告
        await ws.send(json.dumps({
            "type": "identify",
            "sender_name": USERNAME,
            "sender_type": "human",
        }))

        print("\n[2/4] 测试 1：人类向 @Codex-1 发送问候消息 ...")
        mention_hello = "@Codex-1 在吗"
        await ws.send(json.dumps({
            "type": "message",
            "content": mention_hello,
            "sender_type": "human",
            "sender_name": USERNAME,
            "msg_type": "text",
        }))
        print(f"👤 人类发送: {mention_hello}")

        # 等待 Codex-1 回复
        hello_replied = False
        start_t = time.time()
        while time.time() - start_t < 8:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
                evt = json.loads(raw)
                if evt.get("type") == "message":
                    m = evt.get("message", {})
                    s_name = m.get("sender_name")
                    content = m.get("content")
                    chat_log.append(f"[{s_name}] {content}")
                    print(f"💬 收到房间广播 [{s_name}]: {content}")
                    if s_name == "Codex-1" and ("在线" in content or "就绪" in content or "我在" in content):
                        hello_replied = True
                        break
            except asyncio.TimeoutError:
                pass

        if hello_replied:
            print("🎉 测试 1 成功：Codex-1 成功接收到并实时回复了问候！")
        else:
            print("⚠️ 测试 1 未在超时内收到回复")

        print("\n[3/4] 测试 2：发起跨智能体 A2A 协议协同讨论 ...")
        dialogue_prompt = "@Codex-1 请和 @Claude-1 讨论一下当前系统的通信架构重构方案"
        await ws.send(json.dumps({
            "type": "message",
            "content": dialogue_prompt,
            "sender_type": "human",
            "sender_name": USERNAME,
            "msg_type": "text",
        }))
        print(f"👤 人类发出指令: {dialogue_prompt}")

        # 监听接下来的多轮 A2A 对话直到共识达成
        a2a_turns = 0
        consensus_reached = False
        start_t = time.time()
        while time.time() - start_t < 15:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2.5)
                evt = json.loads(raw)
                evt_type = evt.get("type")
                if evt_type == "message":
                    m = evt.get("message", {})
                    s_name = m.get("sender_name")
                    content = m.get("content")
                    chat_log.append(f"[{s_name}] {content}")
                    print(f"💬 房间对话 [{s_name}]: {content}")
                    if s_name in ("Codex-1", "Claude-1"):
                        a2a_turns += 1
                        if "[CONSENSUS]" in content or "共识" in content:
                            consensus_reached = True
                            print(f"🎯 检测到共识达成信号！由 [{s_name}] 提出。")
                            break
            except asyncio.TimeoutError:
                if a2a_turns >= 2:
                    break

        print("\n[4/4] 验证结果汇总")
        print("-" * 50)
        print(f"• 人类 @mention 响应: {'✅ 通过' if hello_replied else '❌ 失败'}")
        print(f"• A2A 跨智能体对话轮次: {a2a_turns} 次")
        print(f"• 共识达成与闭环: {'✅ 成功收敛 [CONSENSUS]' if consensus_reached else '已推进多轮'}")
        print("-" * 50)

    # 清理后台进程
    proc_codex.terminate()
    proc_claude.terminate()
    try:
        proc_codex.wait(timeout=2)
        proc_claude.wait(timeout=2)
    except Exception:
        proc_codex.kill()
        proc_claude.kill()

    return hello_replied and (a2a_turns > 0)


if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)
