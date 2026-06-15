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
import subprocess
import sys
import uuid
from datetime import datetime, timezone

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
    ):
        self.server = server.rstrip("/")
        self.room = room
        self.agent_name = agent_name
        self.agent_id = agent_id
        self.command = command
        self.a2a_port = a2a_port
        self.ws_url = (
            f"{server.replace('http', 'ws')}/ws/chat/{room}"
        )
        self._running = True
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
                        "sender_type": "agent",
                        "msg_type": "system",
                    }))

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

        # Check if mentioned
        mention = f"@{self.agent_name}"
        if mention not in content and msg.get("msg_type") != "task":
            return

        # Show typing indicator
        await ws.send(json.dumps({"type": "typing", "sender_id": self.agent_id}))

        # Call local AI
        print(f"  💬 Processing: {content[:80]}...")
        response = self._call_local_ai(f"{self.agent_name}, 项目房间消息: {content}")

        # Send response
        await ws.send(json.dumps({
            "type": "message",
            "content": response,
            "sender_id": self.agent_id,
            "sender_type": "agent",
            "msg_type": "text",
        }))
        print(f"  ✅ Response sent ({len(response)} chars)")

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
                timeout=120,
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
            return f"[{self.agent_name}] ⏰ AI timed out after 120s."
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
        "--command", nargs="+", default=["claude", "-p"],
        help="AI command + args (default: claude -p)",
    )
    parser.add_argument(
        "--port", type=int, default=8765,
        help="Local port for A2A HTTP server (default: 8765)",
    )

    args = parser.parse_args()
    agent_id = args.agent_id or f"{args.agent_name.lower().replace(' ', '-')}-{uuid.uuid4().hex[:6]}"

    adapter = LocalAgentAdapter(
        server=args.server,
        room=args.room,
        agent_name=args.agent_name,
        agent_id=agent_id,
        command=args.command,
        a2a_port=args.port,
    )

    try:
        asyncio.run(adapter.run())
    except KeyboardInterrupt:
        print(f"\n  👋 [{args.agent_name}] Shutting down...")
        adapter.stop()


if __name__ == "__main__":
    main()
