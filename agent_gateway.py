#!/usr/bin/env python3
"""
Agent Gateway — 轻量本地网关，让本机的 AI Agent 加入 Multi-Agent Project Room。

用法：
    # Claude Code（ACP 子进程模式）
    python agent_gateway.py \
        --server http://localhost:8000 \
        --agent-name "Claude" \
        --backend claude-code

    # Codex CLI（ACP 子进程模式）
    python agent_gateway.py \
        --server http://localhost:8000 \
        --agent-name "Codex" \
        --backend codex

    # 自定义命令
    python agent_gateway.py \
        --server http://localhost:8000 \
        --agent-name "MyAgent" \
        --command "python my_agent.py"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys
import uuid
from datetime import datetime, timezone

import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")
logger = logging.getLogger("gateway")

# ── Backend definitions ────────────────────────────────

BACKENDS = {
    "claude-code": {
        "command": ["npx", "-y", "@anthropic-ai/claude-cli", "--print"],
        "description": "Claude Code CLI",
        "input_mode": "stdin-text",
    },
    "codex": {
        "command": ["npx", "-y", "@openai/codex", "--quiet"],
        "description": "OpenAI Codex CLI",
        "input_mode": "stdin-text",
    },
    "gemini": {
        "command": ["npx", "-y", "@google/gemini-cli"],
        "description": "Google Gemini CLI",
        "input_mode": "stdin-text",
    },
}


class ACPSession:
    """Runs a coding agent CLI as a subprocess (ACP pattern).

    Each turn:
      1. Send prompt text to stdin
      2. Read response from stdout until EOF or timeout
      3. Return the text output
    """

    def __init__(self, command: list[str], timeout: float = 120):
        self.command = command
        self.timeout = timeout
        self._proc: asyncio.subprocess.Process | None = None

    async def start(self) -> bool:
        """Start the subprocess."""
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self.command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            return True
        except FileNotFoundError:
            logger.error("Command not found: %s", " ".join(self.command))
            return False

    async def send(self, prompt: str) -> str:
        """Send a prompt and collect the response."""
        if not self._proc or self._proc.returncode is not None:
            started = await self.start()
            if not started:
                return "[error] 无法启动后端进程"

        try:
            assert self._proc.stdin and self._proc.stdout
            self._proc.stdin.write(prompt.encode() + b"\n")
            await self._proc.stdin.drain()

            stdout, stderr = await asyncio.wait_for(
                self._proc.communicate(), timeout=self.timeout
            )
            return stdout.decode().strip() if stdout else ""
        except asyncio.TimeoutError:
            logger.warning("Backend timed out after %ss", self.timeout)
            await self.stop()
            return "[error] 后端超时"
        except Exception as e:
            logger.exception("Backend error")
            return f"[error] {e}"

    async def stop(self):
        """Terminate the subprocess."""
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._proc.kill()
        self._proc = None


# ── Gateway ────────────────────────────────────────────


class AgentGateway:
    """Connects a local AI backend to the shared room server."""

    def __init__(
        self,
        server_url: str,
        agent_name: str,
        backend_command: list[str],
        room_id: str | None = None,
        poll_interval: float = 3.0,
    ):
        self.server = server_url.rstrip("/")
        self.agent_name = agent_name
        self.room_id = room_id
        self.poll_interval = poll_interval
        self.session = ACPSession(backend_command)
        self.http = httpx.AsyncClient(timeout=30)
        self.auth_token: str | None = None
        self.last_message_ts: str | None = None
        self.running = False

    async def register(self) -> dict | None:
        """Register this agent with the server via Agent Card."""
        skills = [
            {"id": "general", "name": "通用对话", "description": f"{self.agent_name} 的默认能力"},
        ]
        card = {
            "name": self.agent_name,
            "url": f"local://{self.agent_name.lower()}",
            "skills": skills,
        }
        resp = await self.http.post(
            f"{self.server}/a2a/dialogue-rpc",
            json={
                "jsonrpc": "2.0",
                "method": "agent/register",
                "params": card,
                "id": str(uuid.uuid4()),
            },
        )
        data = resp.json()
        result = data.get("result")
        if result:
            logger.info("Agent registered: %s", self.agent_name)
        else:
            logger.warning("Registration response: %s", data)
        return result

    async def poll_messages(self) -> list[dict]:
        """Poll for new messages that mention us."""
        params: dict = {}
        if self.room_id:
            params["room_id"] = self.room_id
        if self.last_message_ts:
            params["after"] = self.last_message_ts

        headers = {}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"

        try:
            resp = await self.http.get(
                f"{self.server}/api/v1/rooms/{self.room_id}/messages" if self.room_id else "",
                params=params,
                headers=headers,
            )
            if resp.status_code != 200:
                return []
            messages = resp.json().get("messages", [])
            relevant = []
            for msg in messages:
                content = msg.get("content", "")
                sender = msg.get("sender_name", "")
                if sender == self.agent_name:
                    continue
                if f"@{self.agent_name}" in content.lower():
                    relevant.append(msg)
                self.last_message_ts = msg.get("created_at", self.last_message_ts)
            return relevant
        except Exception as e:
            logger.debug("Poll error: %s", e)
            return []

    async def process_message(self, msg: dict):
        """Send a mentioned message to the local backend and post the reply."""
        content = msg.get("content", "")
        room_id = msg.get("room_id", "")
        sender = msg.get("sender_name", "user")

        prompt = (
            f"You are {self.agent_name} in a multi-agent collaboration room.\n"
            f"{sender} said: {content}\n"
            "Respond concisely."
        )

        reply = await self.session.send(prompt)
        if not reply:
            reply = f"[{self.agent_name}] 收到，但无法生成回复。"

        headers = {}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"

        try:
            await self.http.post(
                f"{self.server}/api/v1/rooms/{room_id}/messages",
                json={"content": reply, "msg_type": "text"},
                headers=headers,
            )
            logger.info("Reply posted to room %s", room_id[:8])
        except Exception as e:
            logger.error("Failed to post reply: %s", e)

    async def run(self):
        """Main event loop."""
        self.running = True
        logger.info("Gateway starting: %s → %s", self.agent_name, self.server)

        await self.register()
        started = await self.session.start()
        if not started:
            logger.error("Failed to start backend. Exiting.")
            return

        logger.info("Polling every %.1fs...", self.poll_interval)
        while self.running:
            try:
                messages = await self.poll_messages()
                for msg in messages:
                    logger.info("Processing mention from %s", msg.get("sender_name"))
                    await self.process_message(msg)
            except Exception as e:
                logger.exception("Loop error")
            await asyncio.sleep(self.poll_interval)

    async def shutdown(self):
        """Clean shutdown."""
        self.running = False
        await self.session.stop()
        await self.http.aclose()
        logger.info("Gateway stopped.")


def main():
    parser = argparse.ArgumentParser(description="Agent Gateway — join the Multi-Agent Project Room")
    parser.add_argument("--server", default="http://localhost:8000", help="Room server URL")
    parser.add_argument("--agent-name", required=True, help="Agent display name")
    parser.add_argument("--backend", choices=list(BACKENDS.keys()), help="Predefined backend type")
    parser.add_argument("--command", nargs="+", help="Custom command (overrides --backend)")
    parser.add_argument("--room-id", help="Room to join (default: auto)")
    parser.add_argument("--poll-interval", type=float, default=3.0)
    args = parser.parse_args()

    if args.command:
        cmd = args.command
    elif args.backend:
        cmd = BACKENDS[args.backend]["command"]
    else:
        print("Error: specify --backend or --command", file=sys.stderr)
        sys.exit(1)

    gateway = AgentGateway(
        server_url=args.server,
        agent_name=args.agent_name,
        backend_command=cmd,
        room_id=args.room_id,
        poll_interval=args.poll_interval,
    )

    async def _run():
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, lambda: asyncio.ensure_task(gateway.shutdown()))
            except NotImplementedError:
                pass
        await gateway.run()

    asyncio.run(_run())


if __name__ == "__main__":
    main()
