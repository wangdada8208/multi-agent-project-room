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

from __future__ import annotations

import argparse
import asyncio
import fcntl
import hashlib
import json
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, TextIO

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


def _friendly_ai_failure(agent_name: str, stderr: str) -> Optional[str]:
    """Turn common local CLI failures into short room-safe messages."""
    compact = " ".join(stderr.lower().split())
    if any(
        phrase in compact
        for phrase in [
            "usage limit",
            "hit your limit",
            "rate limit",
            "too many requests",
            "insufficient quota",
        ]
    ):
        return (
            f"[{agent_name}] 我在线，但本地 AI 命令现在触发了额度限制，"
            "暂时不能调用深度模型。简单问候我会直接回复；复杂任务等额度恢复后再继续。"
        )
    return None


def _singleton_lock_path(
    lock_dir: Path,
    server: str,
    room: str | None,
    agent_name: str,
) -> Path:
    """Build a stable lock path for one server/room/agent adapter instance."""
    effective_room = room if room else f"_agent_{agent_name.lower()}"
    key = "\n".join([server.rstrip("/"), effective_room, agent_name.lower()])
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    safe_agent = re.sub(r"[^a-z0-9_-]+", "-", agent_name.lower()).strip("-") or "agent"
    return lock_dir / f"{safe_agent}-{digest}.lock"


def _acquire_singleton_lock(lock_path: Path) -> TextIO:
    """Acquire an exclusive non-blocking adapter lock and return its file handle."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_file = lock_path.open("a+")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        lock_file.close()
        raise RuntimeError(f"adapter already running for lock {lock_path}") from exc

    lock_file.seek(0)
    lock_file.truncate()
    lock_file.write(str(Path.cwd()) + "\n")
    lock_file.flush()
    return lock_file


def _strip_mention(content: str, agent_name: str) -> str:
    """Remove the leading mention and normalize lightweight chat text."""
    return re.sub(rf"@{re.escape(agent_name)}\b", "", content, flags=re.IGNORECASE).strip().lower()


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


def _is_dialogue_request(agent_name: str, content: str) -> bool:
    """Return true when a user asks this agent to start peer dialogue."""
    target = _target_agent(agent_name, content)
    if target is None:
        return False
    text = _strip_mention(content, agent_name)
    compact = "".join(text.split())
    dialogue_words = [
        "持续对话", "连续对话", "互相", "对话", "聊天", "聊聊",
        "讨论", "协作", "沟通", "交流", "一起", "配合",
        "dialogue", "conversation", "talk", "discuss",
    ]
    return any(word in compact for word in dialogue_words)


def _requested_seconds(content: str, default_seconds: int) -> int:
    """Extract a simple Chinese/English second duration from user text."""
    match = re.search(r"(\d{1,3})\s*(秒|s|sec|seconds?)", content, re.IGNORECASE)
    if not match:
        return default_seconds
    return max(5, min(int(match.group(1)), 300))


def _dialogue_seed_message(agent_name: str, content: str) -> str:
    """Build the first peer message for a dialogue session."""
    target = _target_agent(agent_name, content)
    if not target:
        return f"我们开始一次简短协作，请先说说你的判断。"
    text = re.sub(rf"@?{re.escape(agent_name)}", "", content, flags=re.IGNORECASE)
    text = re.sub(rf"@?{re.escape(target)}", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\d{1,3}\s*(秒|s|sec|seconds?)", "", text, flags=re.IGNORECASE)
    for phrase in [
        "从你开始", "你先开始", "唤醒", "持续对话", "连续对话",
        "对话", "聊天", "聊聊", "讨论", "协作", "沟通", "交流",
        "让", "和", "与", "一起", "进行",
    ]:
        text = text.replace(phrase, "")
    text = text.strip(" ，,。:：")
    if text:
        return f"我们围绕“{text}”快速对齐，请你先给出你的判断。"
    return f"我们开始一次简短协作，请你先给出你的判断。"


def _is_dialogue_stop(content: str) -> bool:
    compact = "".join(content.lower().split())
    return any(
        word in compact
        for word in ["结束", "停止", "不用回复", "我这边结束", "[[end]]", "end"]
    )


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
        auto_dialogue_seconds: int = 30,
        max_dialogue_turns: int = 8,
        auth_token: str | None = None,
        auth_username: str | None = None,
        auth_password: str | None = None,
        auth_display_name: str | None = None,
        auth_register: bool = False,
    ):
        self.server = server.rstrip("/")
        self.agent_name = agent_name
        self.agent_id = agent_id
        # Default to agent channel if no room specified
        self.room = room if room else f"_agent_{agent_name.lower()}"
        self.is_agent_channel = self.room.startswith("_agent_")
        self.command = command
        self.a2a_port = a2a_port
        self.ai_timeout = ai_timeout
        self.auto_dialogue_seconds = auto_dialogue_seconds
        self.max_dialogue_turns = max_dialogue_turns
        self.auth_token = auth_token
        self.auth_username = auth_username
        self.auth_password = auth_password
        self.auth_display_name = auth_display_name
        self.auth_register = auth_register
        self.authenticated = False
        self.started_at = datetime.now(timezone.utc)
        self.ws_url = (
            f"{server.replace('http', 'ws')}/ws/chat/{self.room}"
        )
        self._running = True
        self._processed_ids: set[str] = set()  # Track processed message IDs
        self._dialogues: dict[str, dict] = {}
        self.http = httpx.AsyncClient(base_url=self.server, timeout=30)
        if auth_token:
            self.http.headers["Authorization"] = f"Bearer {auth_token}"
            self.authenticated = True

    # ── Main ──────────────────────────────────────────

    async def run(self):
        """Connect to room, register via A2A, then listen for messages."""
        print(f"🤖 [{self.agent_name}] Starting adapter...")
        await self._authenticate()
        await self._register_via_a2a()
        await self._ws_loop()

    # ── Auth ──────────────────────────────────────────

    async def _authenticate(self):
        """Authenticate for approval creation when credentials are provided."""
        if self.auth_token:
            print("  🔐 Auth token provided; approval creation enabled")
            return

        if not self.auth_username or not self.auth_password:
            print("  🔓 No auth credentials provided; approval creation disabled")
            return

        login_payload = {
            "username": self.auth_username,
            "password": self.auth_password,
        }
        try:
            resp = await self.http.post("/api/v1/auth/login", json=login_payload)
            if resp.status_code == 200:
                self._set_auth_from_response(resp.json())
                print(f"  🔐 Logged in as '{self.auth_username}'; approval creation enabled")
                return

            if resp.status_code not in (401, 404) or not self.auth_register:
                print(
                    "  ⚠️  Auth login failed; approval creation disabled "
                    f"(status={resp.status_code})"
                )
                return

            register_payload = {
                "username": self.auth_username,
                "password": self.auth_password,
                "display_name": self.auth_display_name or self.agent_name,
                "user_type": "agent",
            }
            register_resp = await self.http.post(
                "/api/v1/auth/register", json=register_payload
            )
            if register_resp.status_code == 200:
                self._set_auth_from_response(register_resp.json())
                print(f"  🔐 Registered agent user '{self.auth_username}'; approval creation enabled")
                return

            print(
                "  ⚠️  Auth registration failed; approval creation disabled "
                f"(status={register_resp.status_code})"
            )
        except Exception as e:
            print(f"  ⚠️  Auth failed; approval creation disabled: {e}")

    def _set_auth_from_response(self, data: dict):
        token = data.get("access_token")
        if not token:
            return
        self.http.headers["Authorization"] = f"Bearer {token}"
        self.authenticated = True

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

    async def _handle_agent_task(self, data: dict, ws):
        """Process an agent_task forwarded from any room."""
        message_id = data.get("message_id", "")
        task_id = data.get("task_id")
        if message_id in self._processed_ids:
            return
        self._processed_ids.add(message_id)

        content = data.get("content", "")
        origin_room = data.get("origin_room", "")
        sender_name = data.get("sender_name", "someone")

        # Show typing indicator
        await ws.send(json.dumps({"type": "typing", "sender_id": self.agent_id}))

        # Quick reply or full AI
        quick_response = _quick_reply(self.agent_name, content)
        if quick_response is not None:
            print(f"  ⚡ Quick reply from {sender_name}: {content[:60]}...")
            response = quick_response
        else:
            print(f"  💬 Processing task from room {origin_room} ({sender_name}): {content[:60]}...")
            response = await asyncio.to_thread(
                self._call_local_ai,
                self._build_prompt(content),
            )

        # Send response with target_room for cross-room routing
        await self._maybe_create_approval(origin_room, task_id, content, response)
        await ws.send(json.dumps({
            "type": "message",
            "content": response,
            "sender_id": self.agent_id,
            "sender_name": self.agent_name,
            "sender_type": "agent",
            "msg_type": "text",
            "target_room": origin_room,
            "parent_id": message_id,
            "task_id": task_id,
        }))
        print(f"  ✅ Response sent to room {origin_room} ({len(response)} chars)")

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

            if self.is_agent_channel:
                # Agent channel: process task-type messages (forwarded @mentions)
                pending = 0
                for msg in messages:
                    msg_id = msg.get("id", "")
                    if msg_id in self._processed_ids:
                        continue
                    if msg.get("msg_type") != "task":
                        self._processed_ids.add(msg_id)
                        continue
                    sender_id = msg.get("sender_id", "")
                    if sender_id == self.agent_id:
                        self._processed_ids.add(msg_id)
                        continue

                    try:
                        task_data = json.loads(msg.get("content", "{}"))
                    except (json.JSONDecodeError, TypeError):
                        self._processed_ids.add(msg_id)
                        continue

                    pending += 1
                    print(f"  📋 Catching up missed @{self.agent_name} from {task_data.get('original_sender', '?')}")
                    ws_data = {
                        "type": "agent_task",
                        "message_id": task_data.get("original_id", msg_id),
                        "task_id": task_data.get("task_id"),
                        "content": task_data.get("original_content", ""),
                        "sender_id": msg.get("sender_id", ""),
                        "sender_name": task_data.get("original_sender", ""),
                        "origin_room": task_data.get("origin_room", ""),
                    }
                    await self._handle_agent_task(ws_data, ws)
                    self._processed_ids.add(msg_id)  # Also mark the task DB msg to avoid re-scan
                if pending:
                    print(f"  ✅ Caught up on {pending} missed task(s)")
                return

            mention = f"@{self.agent_name}"
            pending = 0
            for msg in messages:
                msg_id = msg.get("id", "")
                if msg_id in self._processed_ids:
                    continue
                created_at = msg.get("created_at")
                if created_at:
                    try:
                        created_time = datetime.fromisoformat(
                            created_at.replace("Z", "+00:00")
                        )
                        if created_time < self.started_at:
                            self._processed_ids.add(msg_id)
                            continue
                    except ValueError:
                        pass
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

                    # Send join message (skip in agent channel mode)
                    if not self.is_agent_channel:
                        await ws.send(json.dumps({
                            "type": "message",
                            "content": f"🤖 Agent {self.agent_name} connected.",
                            "sender_id": self.agent_id,
                            "sender_name": self.agent_name,
                            "sender_type": "agent",
                            "msg_type": "system",
                        }))
                    else:
                        await ws.send(json.dumps({
                            "type": "identify",
                            "sender_id": self.agent_id,
                            "sender_name": self.agent_name,
                            "sender_type": "agent",
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

        # Handle agent_task (cross-room @mentions forwarded by backend)
        if msg_type == "agent_task":
            await self._handle_agent_task(data, ws)
            return

        # Skip regular chat messages in agent channel mode
        if self.is_agent_channel:
            return

        if msg_type == "agent_dialogue_message":
            await self._handle_dialogue_message(data, ws)
            return

        if msg_type == "agent_dialogue_ended":
            dialogue = data.get("dialogue", {})
            dialogue_id = dialogue.get("dialogue_id")
            if dialogue_id:
                self._dialogues.pop(dialogue_id, None)
            return

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

        if _is_dialogue_stop(content):
            await self._end_all_dialogues("stopped by user")
            await ws.send(json.dumps({
                "type": "message",
                "content": "已停止当前 Agent 连续对话。",
                "sender_id": self.agent_id,
                "sender_name": self.agent_name,
                "sender_type": "agent",
                "msg_type": "text",
            }))
            return

        if _is_dialogue_request(self.agent_name, content):
            started = await self._start_dialogue_from_request(content)
            if started:
                await ws.send(json.dumps({"type": "typing", "sender_id": self.agent_id}))
                await ws.send(json.dumps({
                    "type": "message",
                    "content": started,
                    "sender_id": self.agent_id,
                    "sender_name": self.agent_name,
                    "sender_type": "agent",
                    "msg_type": "text",
                }))
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
        task_id = msg.get("task_id") or data.get("task_id")
        await self._maybe_create_approval(self.room, task_id, content, response)
        await ws.send(json.dumps({
            "type": "message",
            "content": response,
            "sender_id": self.agent_id,
            "sender_name": self.agent_name,
            "sender_type": "agent",
            "msg_type": "text",
            "parent_id": msg_id,
            "task_id": task_id,
        }))
        print(f"  ✅ Response sent ({len(response)} chars)")

    async def _maybe_create_approval(
        self,
        room_id: str,
        task_id: str | None,
        request_content: str,
        response: str,
    ) -> None:
        """Create an approval when the agent response explicitly asks for one."""
        if not task_id or not room_id:
            return
        compact = "".join((request_content + response).lower().split())
        if not any(word in compact for word in ["需要审批", "请求审批", "approval", "approve"]):
            return
        payload = {
            "title": f"{self.agent_name} 请求人工审批",
            "description": response[:1000],
            "risk_level": "medium",
            "task_id": task_id,
            "requested_action": request_content[:300],
            "risk_summary": "Agent 标记该任务需要人工确认后继续。",
        }
        try:
            resp = await self.http.post(f"/api/v1/rooms/{room_id}/approvals", json=payload)
            if resp.status_code in (200, 201):
                print(f"  📋 Approval created for task {task_id}")
            elif resp.status_code == 401:
                print("  ⚠️  Approval skipped: provide --auth-token to create approvals")
            else:
                print(f"  ⚠️  Approval create failed: {resp.status_code} {resp.text[:120]}")
        except Exception as e:
            print(f"  ⚠️  Approval create error: {e}")

    async def _start_dialogue_from_request(self, content: str) -> Optional[str]:
        """Create a Hub dialogue and send the first peer-directed message."""
        target = _target_agent(self.agent_name, content)
        if not target:
            return None
        duration_seconds = _requested_seconds(content, self.auto_dialogue_seconds)
        payload = {
            "jsonrpc": "2.0",
            "method": "dialogues/start",
            "params": {
                "room_id": self.room,
                "initiator_agent": self.agent_name,
                "participants": [self.agent_name, target],
                "duration_seconds": duration_seconds,
                "max_turns": self.max_dialogue_turns,
            },
            "id": str(uuid.uuid4()),
        }
        try:
            resp = await self.http.post("/a2a", json=payload)
            data = resp.json()
            dialogue = data.get("result")
            if not dialogue:
                error = data.get("error", {}).get("message", "unknown error")
                return f"启动与 {target} 的连续对话失败：{error}"
            dialogue_id = dialogue["dialogue_id"]
            self._dialogues[dialogue_id] = dialogue
            await self._send_dialogue_message(
                dialogue_id,
                target,
                _dialogue_seed_message(self.agent_name, content),
            )
            return (
                f"已启动与 {target} 的连续对话，最长 {duration_seconds} 秒，"
                f"最多 {dialogue.get('max_turns', self.max_dialogue_turns)} 轮。"
            )
        except Exception as e:
            return f"启动与 {target} 的连续对话失败：{e}"

    async def _handle_dialogue_message(self, data: dict, ws):
        """Handle a Hub-relayed dialogue message without requiring @mentions."""
        dialogue = data.get("dialogue") or {}
        msg = data.get("message") or {}
        dialogue_id = dialogue.get("dialogue_id") or msg.get("dialogue_id")
        if not dialogue_id:
            return
        if dialogue.get("status") not in (None, "active"):
            self._dialogues.pop(dialogue_id, None)
            return
        participants = dialogue.get("participants") or []
        if self.agent_name.lower() not in {str(p).lower() for p in participants}:
            return
        target_agent = msg.get("target_agent")
        if target_agent and target_agent.lower() != self.agent_name.lower():
            return
        sender_id = msg.get("sender_id", "")
        sender_name = msg.get("sender_name", "")
        if sender_id == self.agent_id or sender_name.lower() == self.agent_name.lower():
            return
        msg_id = msg.get("id", "")
        if msg_id and msg_id in self._processed_ids:
            return
        if msg_id:
            self._processed_ids.add(msg_id)

        self._dialogues[dialogue_id] = dialogue
        content = msg.get("content", "")
        if _is_dialogue_stop(content):
            await self._end_dialogue(dialogue_id, "peer ended dialogue")
            return

        await ws.send(json.dumps({"type": "typing", "sender_id": self.agent_id}))
        print(f"  🔁 Dialogue {dialogue_id[:8]} from {sender_name}: {content[:80]}...")
        response = await asyncio.to_thread(
            self._call_local_ai,
            self._build_dialogue_prompt(sender_name or "peer", content, dialogue),
        )
        response = self._trim_dialogue_response(response)
        if _is_dialogue_stop(response):
            await self._send_dialogue_message(dialogue_id, sender_name, response)
            await self._end_dialogue(dialogue_id, "agent ended dialogue")
            return
        await self._send_dialogue_message(dialogue_id, sender_name, response)

    async def _send_dialogue_message(
        self,
        dialogue_id: str,
        target_agent: str,
        content: str,
    ):
        """Send a dialogue message through the Hub relay."""
        payload = {
            "jsonrpc": "2.0",
            "method": "dialogues/send",
            "params": {
                "dialogue_id": dialogue_id,
                "room_id": self.room,
                "sender_id": self.agent_id,
                "sender_name": self.agent_name,
                "target_agent": target_agent,
                "content": content,
            },
            "id": str(uuid.uuid4()),
        }
        resp = await self.http.post("/a2a", json=payload)
        data = resp.json()
        if data.get("error"):
            print(f"  ⚠️  Dialogue send failed: {data['error'].get('message')}")
            self._dialogues.pop(dialogue_id, None)

    async def _end_dialogue(self, dialogue_id: str, reason: str):
        """Ask the Hub to end one dialogue."""
        self._dialogues.pop(dialogue_id, None)
        payload = {
            "jsonrpc": "2.0",
            "method": "dialogues/end",
            "params": {"dialogue_id": dialogue_id, "reason": reason},
            "id": str(uuid.uuid4()),
        }
        try:
            await self.http.post("/a2a", json=payload)
        except Exception as e:
            print(f"  ⚠️  Dialogue end failed: {e}")

    async def _end_all_dialogues(self, reason: str):
        """End every active dialogue known to this adapter."""
        dialogue_ids = list(self._dialogues)
        for dialogue_id in dialogue_ids:
            await self._end_dialogue(dialogue_id, reason)

    def _build_dialogue_prompt(self, peer_name: str, content: str, dialogue: dict) -> str:
        """Prompt for fast peer-to-peer dialogue turns."""
        return (
            f"你是 {self.agent_name}，正在和 {peer_name} 进行一个短时 Agent 对话。"
            "请直接接上对方的话，中文回复 1-3 句，保持具体、快速、可执行。"
            "不要声称自己没有聊天室或 WebSocket 工具；不要写 @ 名字。"
            "如果你认为对话应结束，在最后写“我这边结束”。"
            f"\n当前轮次：{dialogue.get('current_turn', 0)}/{dialogue.get('max_turns', self.max_dialogue_turns)}"
            f"\n{peer_name}：{content}"
        )

    def _trim_dialogue_response(self, response: str) -> str:
        """Keep relay dialogue short enough to feel live."""
        lines = [line.strip() for line in response.splitlines() if line.strip()]
        compact = " ".join(lines)
        return compact[:600] or f"收到，我这边继续配合。"

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
                friendly = _friendly_ai_failure(self.agent_name, result.stderr)
                if friendly:
                    return friendly
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

  # Auto-login for approval creation
  python local_agent_adapter.py --server https://hub.example.com \\
      --agent-name Codex --auth-username codex --auth-password "secret" --auth-register
        """,
    )
    parser.add_argument(
        "--server", required=True, help="Server URL (e.g., http://localhost:8000)"
    )
    parser.add_argument(
        "--room", default=None,
        help="Room ID to join (default: auto-connect to _agent_{name} channel)"
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
    parser.add_argument(
        "--auto-dialogue-seconds", type=int, default=30,
        help="Default seconds for agent-to-agent dialogue sessions (default: 30)",
    )
    parser.add_argument(
        "--max-dialogue-turns", type=int, default=8,
        help="Max relayed dialogue turns before the Hub stops the session (default: 8)",
    )
    parser.add_argument(
        "--auth-token", default=None,
        help="Bearer token used when the adapter needs to create approvals",
    )
    parser.add_argument(
        "--auth-username", default=None,
        help="Username used to log in for approval creation",
    )
    parser.add_argument(
        "--auth-password", default=None,
        help="Password used to log in for approval creation",
    )
    parser.add_argument(
        "--auth-display-name", default=None,
        help="Display name used when --auth-register creates an agent user",
    )
    parser.add_argument(
        "--auth-register", action="store_true",
        help="Register an agent user if auth login fails with 401/404",
    )

    args = parser.parse_args()
    args.command = args.command.split()
    agent_id = args.agent_id or f"{args.agent_name.lower().replace(' ', '-')}-{uuid.uuid4().hex[:6]}"
    lock_path = _singleton_lock_path(
        Path.home() / ".multi-agent-project-room" / "locks",
        server=args.server,
        room=args.room,
        agent_name=args.agent_name,
    )
    try:
        singleton_lock = _acquire_singleton_lock(lock_path)
    except RuntimeError as e:
        print(f"  ❌ {e}")
        sys.exit(2)

    adapter = LocalAgentAdapter(
        server=args.server,
        room=args.room,
        agent_name=args.agent_name,
        agent_id=agent_id,
        command=args.command,
        a2a_port=args.port,
        ai_timeout=args.ai_timeout,
        auto_dialogue_seconds=args.auto_dialogue_seconds,
        max_dialogue_turns=args.max_dialogue_turns,
        auth_token=args.auth_token,
        auth_username=args.auth_username,
        auth_password=args.auth_password,
        auth_display_name=args.auth_display_name,
        auth_register=args.auth_register,
    )

    try:
        asyncio.run(adapter.run())
    except KeyboardInterrupt:
        print(f"\n  👋 [{args.agent_name}] Shutting down...")
        adapter.stop()
    finally:
        singleton_lock.close()


if __name__ == "__main__":
    main()
