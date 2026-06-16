#!/usr/bin/env python3
"""
Local AI Agent Adapter — bridges a local AI tool to the Multi-Agent Project Room.

Usage:
    # Claude:
    python local_agent_adapter.py \\
        --server http://localhost:8000 \\
        --agent-name "Claude" \\
        --command "claude -p"

    # Codex:
    python local_agent_adapter.py \\
        --server http://localhost:8000 \\
        --agent-name "Codex" \\
        --command "codex"
"""

import argparse
import asyncio
import json
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
import websockets


def _compact_stderr(stderr: str) -> str:
    """Return the useful tail of stderr without noisy warning lines."""
    lines = [
        line.strip()
        for line in stderr.splitlines()
        if line.strip()
        and " WARN " not in line
        and "warning" not in line.lower()
        and "hook:" not in line.lower()
    ]
    if not lines:
        return stderr.strip()[-500:]
    return "\n".join(lines[-5:])[-1000:]


def _strip_mention(content: str, agent_name: str) -> str:
    """Remove the leading mention and normalize lightweight chat text."""
    return content.replace(f"@{agent_name}", "").strip().lower()


def _target_agent(agent_name: str, content: str) -> Optional[str]:
    """Detect a different agent mentioned in the message."""
    lower = content.lower()
    candidates = {"claude": "Claude", "codex": "Codex"}
    for key, display_name in candidates.items():
        if display_name.lower() == agent_name.lower():
            continue
        if f"@{key}" in lower or key in lower:
            return display_name
    return None


def _agent_route_reply(agent_name: str, content: str) -> Optional[str]:
    """Build a plain chat message to another agent when the user asks for it."""
    target = _target_agent(agent_name, content)
    if target is None:
        return None

    text = _strip_mention(content, agent_name)
    compact = "".join(text.split())
    route_words = [
        "发送", "发一条", "发给", "问", "问问", "告诉", "转告", "联系",
        "对话", "聊天", "聊聊", "讨论", "协作", "沟通", "请教", "让",
        "send", "ask", "tell", "talk", "discuss",
    ]
    if not any(word in compact for word in route_words):
        return None

    original = re.sub(rf"@?{re.escape(agent_name)}", "", content, flags=re.IGNORECASE)
    original = re.sub(rf"@?{re.escape(target)}", "", original, flags=re.IGNORECASE)
    normalized = original.strip(" ，,。:：")

    if any(word in compact for word in ["问好", "打招呼", "问个好"]):
        normalized = f"你好，我是 {agent_name}。我这边已经在线，很高兴和你协作。"
    elif "让它" in normalized or "让他" in normalized:
        normalized = normalized.replace("告诉", "").replace("转告", "")
        normalized = normalized.replace("让它", "请").replace("让他", "请")
        normalized = normalized.strip(" ，,。:：")
    elif any(word in compact for word in ["讨论", "协作", "对话", "聊天", "聊聊"]):
        normalized = re.sub(r"^(尝试)?(和|与)?(聊天室内的)?", "", normalized)
        normalized = normalized.strip(" ，,。:：")
        normalized = f"我们来{normalized}" if normalized else f"我们可以在这里直接协作。"
    else:
        for phrase in [
            "发送一条消息", "发送消息", "发一条消息", "发消息",
            "告诉", "转告", "联系", "给", "向",
        ]:
            normalized = normalized.replace(phrase, "")
        normalized = normalized.strip(" ，,。:：")

    if not normalized:
        normalized = f"你好，我是 {agent_name}，我们可以在这个聊天室里直接协作。"
    normalized = normalized.replace("它", "你").replace("他", "你").replace("对方", "你")

    if not normalized.startswith(f"@{target}"):
        normalized = f"@{target} {normalized}"
    return normalized


def _quick_reply(agent_name: str, content: str) -> Optional[str]:
    """Return instant replies for small talk that should not boot the AI CLI."""
    text = _strip_mention(content, agent_name)
    compact = "".join(text.split())
    if not compact:
        return f"我在，{agent_name} 在线。"

    routed = _agent_route_reply(agent_name, content)
    if routed is not None:
        return routed

    greeting_words = ["你好", "在吗", "在线", "hello", "hi", "hey"]
    identity_words = ["你是谁", "介绍", "身份", "who are you", "你是"]
    status_words = ["状态", "进度", "完成了吗", "项目状态"]

    if any(word in compact for word in greeting_words):
        return f"我在，{agent_name} 在线。需要我看代码或推进任务时，直接把任务发给我。"

    if any(word in compact for word in identity_words):
        return (
            f"我是 {agent_name}，这个项目房间里的代码协作 Agent。"
            "我负责读取仓库、实现功能、跑测试，并把结果同步到 GitHub。"
        )

    if any(word in compact for word in status_words):
        return (
            "我在线。当前 Codex 负责的 Agent、Knowledge、Repository、Approval 前端和聊天保留期功能已完成；"
            "复杂检查请明确指定模块，我会再调用本地 Codex 深入分析。"
        )

    return None


class LocalAgentAdapter:
    """Connects a local AI to the project room via WebSocket + A2A."""

    def __init__(
        self,
        server: str,
        room: str,
        agent_name: str,
        agent_id: str,
        command: list[str],
        a2a_port: int,
        ai_timeout: int,
    ):
        self.server = server.rstrip("/")
        self.room = room
        self.agent_name = agent_name
        self.agent_id = agent_id
        self.command = command
        self.a2a_port = a2a_port
        self.ai_timeout = ai_timeout
        self.ws_url = (
            f"{server.replace('http', 'ws')}/ws/chat/{room}"
        )
        self._running = True
        self._processed_ids: set[str] = set()  # Track processed message IDs
        self.http = httpx.AsyncClient(base_url=self.server, timeout=30)

    # ── Main ──────────────────────────────────────────

    async def run(self):
        """Connect to room, register via A2A, then listen for messages."""
        print(f"🤖 [{self.agent_name}] Starting adapter...")
        await self._register_via_a2a()
        await self._ws_loop()

    # ── A2A Registration ──────────────────────────────

    async def _register_via_a2a(self):
        """Register this agent with the A2A Hub."""
        try:
            payload = {
                "jsonrpc": "2.0",
                "method": "agent/register",
                "params": {
                    "name": self.agent_name,
                    "url": f"http://localhost:{self.a2a_port}",
                },
                "id": str(uuid.uuid4()),
            }
            resp = await self.http.post("/a2a", json=payload)
            if resp.status_code == 200:
                print(f"  ✅ Registered with A2A Hub as '{self.agent_name}'")
            else:
                print(f"  ⚠️  A2A registration returned {resp.status_code}")
        except Exception as e:
            print(f"  ⚠️  A2A registration failed (server may be down): {e}")

    # ── WebSocket ─────────────────────────────────────

    async def _catch_up_missed_messages(self, ws):
        """Fetch recent messages on reconnect and process any missed @mentions."""
        try:
            resp = await self.http.get(
                f"/api/v1/rooms/{self.room}/messages?limit=20"
            )
            if resp.status_code != 200:
                return
            data = resp.json()
            messages = data.get("messages", [])
            if not messages:
                return

            mention = f"@{self.agent_name}"
            pending = 0
            for msg in messages:
                msg_id = msg.get("id", "")
                if msg_id in self._processed_ids:
                    continue
                content = msg.get("content", "")
                sender_id = msg.get("sender_id", "")
                msg_type = msg.get("msg_type", "text")
                if sender_id == self.agent_id:
                    self._processed_ids.add(msg_id)
                    continue
                if mention not in content and msg_type != "task":
                    self._processed_ids.add(msg_id)
                    continue
                # Found a missed @mention
                pending += 1
                print(f"  📋 Catching up missed @{self.agent_name} from {msg.get('sender_name') or sender_id[:8]}")
                ws_data = {"type": "message", "message": msg}
                await self._handle_message(ws_data, ws)
            if pending:
                print(f"  ✅ Caught up on {pending} missed message(s)")
        except Exception as e:
            print(f"  ⚠️  Catch-up error: {e}")

    async def _ws_loop(self):
        """Connect to chat room WebSocket with auto-reconnect."""
        retry = 1
        while self._running:
            try:
                async with websockets.connect(
                    self.ws_url,
                    ping_interval=30,
                    ping_timeout=10,
                ) as ws:
                    print(f"  ✅ Connected to room '{self.room}'")
                    retry = 1  # Reset backoff on success

                    # Send join message
                    await ws.send(json.dumps({
                        "type": "message",
                        "content": f"🤖 Agent {self.agent_name} connected.",
                        "sender_id": self.agent_id,
                        "sender_name": self.agent_name,
                        "sender_type": "agent",
                        "msg_type": "system",
                    }))

                    # Catch up on messages missed while disconnected
                    await self._catch_up_missed_messages(ws)

                    async for raw in ws:
                        if not self._running:
                            break
                        try:
                            data = json.loads(raw)
                            await self._handle_message(data, ws)
                        except json.JSONDecodeError:
                            continue

            except websockets.ConnectionClosed:
                print(f"  ⚠️  Disconnected. Reconnecting in {retry}s...")
            except Exception as e:
                print(f"  ⚠️  Connection error: {e}")

            if self._running:
                await asyncio.sleep(min(retry, 30))
                retry = min(retry * 2, 60)

    async def _handle_message(self, data: dict, ws):
        """Process an incoming WebSocket message."""
        msg_type = data.get("type")

        # Only process chat messages
        if msg_type != "message":
            return

        msg = data.get("message", data)
        content = msg.get("content", "")
        sender_id = msg.get("sender_id", "")

        # Ignore own messages
        if sender_id == self.agent_id:
            return

        # Track this message as processed
        msg_id = msg.get("id") or data.get("id", "")
        if msg_id:
            self._processed_ids.add(msg_id)

        # Check if mentioned
        mention = f"@{self.agent_name}"
        if mention not in content and msg.get("msg_type") != "task":
            return

        # Show typing indicator
        await ws.send(json.dumps({"type": "typing", "sender_id": self.agent_id}))

        quick_response = _quick_reply(self.agent_name, content)
        if quick_response is not None:
            print(f"  ⚡ Quick reply: {content[:80]}...")
            response = quick_response
        else:
            # Call local AI
            print(f"  💬 Processing: {content[:80]}...")
            response = await asyncio.to_thread(
                self._call_local_ai,
                self._build_prompt(content),
            )

        # Send response
        await ws.send(json.dumps({
            "type": "message",
            "content": response,
            "sender_id": self.agent_id,
            "sender_name": self.agent_name,
            "sender_type": "agent",
            "msg_type": "text",
        }))
        print(f"  ✅ Response sent ({len(response)} chars)")

    def _build_prompt(self, content: str) -> str:
        """Keep the chat prompt intentionally small for faster CLI responses."""
        return (
            f"你是 {self.agent_name}，Multi-Agent Project Room 的代码协作 Agent。"
            "请优先用中文简短回复，默认 1-3 句；只有用户明确要求实现/检查/修改代码时才展开。"
            f"\n聊天室消息：{content}"
        )

    # ── Local AI ──────────────────────────────────────

    def _call_local_ai(self, prompt: str) -> str:
        """Run the local AI command with the given prompt."""
        if not self.command:
            return f"[{self.agent_name}] No AI command configured."

        try:
            result = subprocess.run(
                self.command + [prompt],
                capture_output=True,
                text=True,
                timeout=self.ai_timeout,
            )
            output = result.stdout.strip()
            if result.stderr:
                print(f"  ⚠️  AI stderr: {result.stderr[:200]}")
            if output:
                return output[:2000]
            if result.stderr:
                error = _compact_stderr(result.stderr)
                return f"[{self.agent_name}] AI command produced no stdout.\n{error}"
            return "(No response)"
        except subprocess.TimeoutExpired:
            return f"[{self.agent_name}] ⏰ AI timed out after {self.ai_timeout}s."
        except FileNotFoundError:
            return f"[{self.agent_name}] ❌ Command not found: {self.command[0]}"
        except Exception as e:
            return f"[{self.agent_name}] ❌ Error: {e}"

    # ── Shutdown ──────────────────────────────────────

    def stop(self):
        """Graceful shutdown."""
        self._running = False

# ── CLI ────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Local AI Agent Adapter — bridge your AI to the project room",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Claude
  python local_agent_adapter.py --server http://localhost:8000 --agent-name Claude

  # Codex with custom command
  python local_agent_adapter.py --server http://localhost:8000 \\
      --agent-name Codex --command codex

  # Custom room and port
  python local_agent_adapter.py --server https://hub.example.com \\
      --room my-room --agent-name Claude --port 9000
        """,
    )
    parser.add_argument(
        "--server", required=True, help="Server URL (e.g., http://localhost:8000)"
    )
    parser.add_argument(
        "--room", default="demo-room", help="Room ID to join (default: demo-room)"
    )
    parser.add_argument(
        "--agent-name", default="Agent", help="Agent name for @mentions"
    )
    parser.add_argument(
        "--agent-id", default=None, help="Unique agent ID (auto-generated if omitted)"
    )
    parser.add_argument(
        "--command", type=str, default="claude -p",
        help="AI command + args (default: claude -p)",
    )
    parser.add_argument(
        "--port", type=int, default=8765,
        help="Local port for A2A HTTP server (default: 8765)",
    )
    parser.add_argument(
        "--ai-timeout", type=int, default=120,
        help="Seconds to wait for the local AI command (default: 120)",
    )

    args = parser.parse_args()
    args.command = args.command.split()
    agent_id = args.agent_id or f"{args.agent_name.lower().replace(' ', '-')}-{uuid.uuid4().hex[:6]}"

    adapter = LocalAgentAdapter(
        server=args.server,
        room=args.room,
        agent_name=args.agent_name,
        agent_id=agent_id,
        command=args.command,
        a2a_port=args.port,
        ai_timeout=args.ai_timeout,
    )

    try:
        asyncio.run(adapter.run())
    except KeyboardInterrupt:
        print(f"\n  👋 [{args.agent_name}] Shutting down...")
        adapter.stop()


if __name__ == "__main__":
    main()
