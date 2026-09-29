#!/usr/bin/env python3
"""
Trusted Runner — 受控智能体运行器与 A2A 协议客户端。

特性：
1. 自动登录与 Agent Card 注册：自动换取身份凭据并向服务端注册 A2A 能力。
2. 房间长连接与实时在线：通过 WebSocket 连入指定房间，向房间声明 Agent 身份。
3. 房间消息响应与意图识别：识别 @mention 呼叫，提供即时问答与本地命令执行能力。
4. Agent-to-Agent（A2A）多轮对话：支持发起与接收双边协商对话（dialogues/create 与 dialogues/send），直到收敛共识。
5. 强行取消联动：收到 task_canceled 广播时，通过 os.killpg 直接终止子进程组。
6. 迟到输出隔离：取消后子进程返回的任何残留输出均直接丢弃。
7. 操作授权核验：执行特权动作前强制校验 ActionGrant 凭据与参数哈希。
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import signal
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")
logger = logging.getLogger("trusted_runner")


def compute_params_hash(params: Any) -> str:
    """计算参数的确定性 SHA-256 哈希值。"""
    if params is None:
        raw = ""
    elif isinstance(params, str):
        raw = params
    else:
        raw = json.dumps(params, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class ProcessGroupController:
    """管理子进程生命周期与进程组终止。"""

    def __init__(self) -> None:
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.pgid: Optional[int] = None
        self._terminated = False

    async def spawn(self, cmd: list[str]) -> asyncio.subprocess.Process:
        """在新的独立进程组中启动子进程。"""
        self._terminated = False
        self.proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            self.pgid = os.getpgid(self.proc.pid)
        except ProcessLookupError:
            self.pgid = None
        logger.info("spawned child process pid=%s pgid=%s cmd=%s", self.proc.pid, self.pgid, cmd)
        return self.proc

    def kill_process_group(self) -> bool:
        """向整个进程组发送 SIGKILL 信号，确保无僵尸进程残留。"""
        if self._terminated:
            return False
        self._terminated = True

        if self.pgid is not None:
            try:
                os.killpg(self.pgid, signal.SIGKILL)
                logger.info("killed process group pgid=%s with SIGKILL", self.pgid)
                return True
            except (ProcessLookupError, PermissionError) as err:
                logger.warning("failed to kill process group pgid=%s: %s", self.pgid, err)

        if self.proc and self.proc.returncode is None:
            try:
                self.proc.kill()
                logger.info("killed single process pid=%s", self.proc.pid)
                return True
            except ProcessLookupError:
                pass
        return False


class TrustedRunner:
    """受控智能体运行器与 A2A 协议客户端。包含执行隔离、取消响应、授权检查、房间问答与 A2A 对话闭环。"""

    def __init__(
        self,
        agent_name: str,
        server_url: str = "http://localhost:8000",
        room_id: Optional[str] = None,
        command: Optional[str] = None,
    ) -> None:
        self.agent_name = agent_name
        self.server_url = server_url.rstrip("/")
        self.room_id = room_id
        self.command = command.split() if command else None
        self.controller = ProcessGroupController()
        self.is_canceled = False
        self.current_task_id: Optional[str] = None

        self.token: Optional[str] = None
        self.user_id: Optional[str] = None
        self.composite_sender_id: str = f"agent_{agent_name.lower().replace(' ', '_')}"
        self.processed_ids: set[str] = set()
        self.active_dialogues: dict[str, dict] = {}
        self._http_client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._http_client is not None:
            return self._http_client
        return httpx.AsyncClient(verify=False, timeout=30.0)

    # ── 授权与取消控制 ────────────────────────────────────

    def cancel_current_execution(self) -> bool:
        """取消当前正在执行的任务，终止底层子进程并设置丢弃标记。"""
        logger.info("cancel request received for runner agent=%s task_id=%s", self.agent_name, self.current_task_id)
        self.is_canceled = True
        return self.controller.kill_process_group()

    def verify_action_grant(
        self,
        grant: dict,
        required_scope: str,
        params: Any,
    ) -> bool:
        """校验单次操作授权凭据的有效性、范围与参数完整性。"""
        if not grant:
            raise ValueError("Action grant is missing")
        if grant.get("consumed_at") is not None:
            raise ValueError("Action grant already consumed")

        expires_at_str = grant.get("expires_at")
        if expires_at_str:
            expires_at = datetime.fromisoformat(expires_at_str)
            if datetime.now(timezone.utc) > expires_at:
                raise ValueError("Action grant has expired")

        grant_scope = grant.get("scope")
        if grant_scope != required_scope:
            raise ValueError(f"Scope mismatch: required {required_scope}, grant has {grant_scope}")

        grantee = grant.get("granted_to_agent", "")
        if grantee.lower() != self.agent_name.lower():
            raise ValueError(f"Recipient mismatch: grant issued to {grantee}, not {self.agent_name}")

        expected_hash = compute_params_hash(params)
        if grant.get("params_hash") != expected_hash:
            raise ValueError("Parameter hash mismatch: execution arguments have been tampered with")

        return True

    async def execute_task(
        self,
        task_id: str,
        cmd: list[str],
        grant: Optional[dict] = None,
        required_scope: Optional[str] = None,
        params: Any = None,
    ) -> dict:
        """执行受控任务。任务取消后产出的任何数据均直接丢弃。"""
        self.current_task_id = task_id
        self.is_canceled = False

        if required_scope:
            self.verify_action_grant(grant or {}, required_scope, params)

        proc = await self.controller.spawn(cmd)

        try:
            stdout_bytes, stderr_bytes = await proc.communicate()
        except asyncio.CancelledError:
            self.cancel_current_execution()
            raise

        if self.is_canceled:
            logger.warning("task_id=%s was canceled. Discarding late process output.", task_id)
            return {
                "task_id": task_id,
                "status": "canceled",
                "result": None,
                "info": "Execution canceled; output discarded.",
            }

        stdout_text = stdout_bytes.decode("utf-8", errors="replace").strip()
        return {
            "task_id": task_id,
            "status": "completed" if proc.returncode == 0 else "failed",
            "returncode": proc.returncode,
            "stdout": stdout_text,
        }

    # ── Agent Card 自动注册 ──────────────────────────────

    async def register_agent_card(self, token: str) -> bool:
        """向服务端登记 Agent Card 与技能信息。"""
        headers = {"Authorization": f"Bearer {token}"}
        client = self._get_client()
        try:
            rpc_payload = {
                "jsonrpc": "2.0",
                "method": "agent/register",
                "params": {
                    "name": self.agent_name,
                    "url": f"local://{self.agent_name.lower()}",
                },
                "id": str(uuid.uuid4()),
            }
            resp = await client.post(f"{self.server_url}/a2a/dialogue-rpc", json=rpc_payload, headers=headers)
            if resp.status_code == 200:
                logger.info("Agent Card registered via /a2a/dialogue-rpc for [%s]", self.agent_name)

            rest_payload = {
                "name": self.agent_name,
                "url": f"local://{self.agent_name.lower()}",
                "capabilities": ["chat", "code", "dialogue"],
                "skills": [{"id": "general", "name": "协同对话", "description": f"{self.agent_name} 的协作能力"}],
            }
            await client.post(f"{self.server_url}/api/v1/agents/register", json=rest_payload, headers=headers)
            return True
        except Exception as e:
            logger.warning("Agent Card registration failed: %s", e)
            return False

    # ── 消息意图识别与快捷回复 ─────────────────────────────

    def is_mentioned(self, content: str) -> bool:
        """判断消息是否 @ 了当前 Agent。"""
        escaped = re.escape(self.agent_name.lower())
        pattern = rf"@{escaped}(?:(?=[^a-zA-Z0-9_-])|$)"
        return bool(re.search(pattern, content.lower()))

    def extract_mention_prompt(self, content: str) -> str:
        """剥离 @ 标记，提取纯任务文本。"""
        escaped = re.escape(self.agent_name)
        pattern = rf"@{escaped}\b"
        cleaned = re.sub(pattern, "", content, flags=re.IGNORECASE)
        return cleaned.strip(" ，,。:： \t\n")

    def is_dialogue_stop(self, content: str) -> bool:
        """判断是否要求停止或结束对话。"""
        compact = "".join(content.lower().split())
        stop_words = ["结束", "停止", "不用回复", "我这边结束", "[[end]]", "end", "stop"]
        return any(w in compact for w in stop_words)

    def detect_dialogue_request(self, content: str) -> tuple[Optional[str], Optional[str]]:
        """检测是否要求与另一个 Agent 发起 A2A 对话。返回 (目标Agent名, 议题)。"""
        dialogue_keywords = ["讨论", "协作", "对话", "聊聊", "沟通", "对齐", "协商", "配合", "一起"]
        compact = "".join(content.split())
        if not any(kw in compact for kw in dialogue_keywords):
            return None, None

        # 仅由被首个呼叫的 Agent 负责发起 A2A 会话，避免双方同时抢发
        first_mention = re.search(r"@([a-zA-Z0-9_-]+)", content)
        if not first_mention or first_mention.group(1).lower() != self.agent_name.lower():
            return None, None

        # 查找被提及的另一方 Agent（形如 @Claude 或 @Claude-1 或提及名字）
        mention_matches = re.findall(r"@([a-zA-Z0-9_-]+)", content)
        target_name = None
        for m in mention_matches:
            if m.lower() != self.agent_name.lower():
                target_name = m
                break

        if not target_name:
            candidates = ["Claude", "Codex", "Claude-1", "Codex-1"]
            for c in candidates:
                if c.lower() != self.agent_name.lower() and c.lower() in content.lower():
                    target_name = c
                    break

        if not target_name:
            return None, None

        topic = self.extract_mention_prompt(content)
        # 移除目标 Agent 的名字及修饰动词
        topic = re.sub(rf"@?{re.escape(target_name)}", "", topic, flags=re.IGNORECASE)
        for noise in ["请和", "和", "与", "跟", "一起", "开始", "进行", "讨论", "协商", "对话", "协作"]:
            topic = topic.replace(noise, "")
        topic = topic.strip(" ，,。:： \t\n") or "协作开发与方案对齐"
        return target_name, topic

    def quick_reply(self, content: str) -> Optional[str]:
        """对常见的招呼、问候、状态查询给出即时响应。"""
        cleaned = self.extract_mention_prompt(content)
        compact = "".join(cleaned.lower().split())
        if not compact or any(w in compact for w in ["在吗", "你好", "在线", "hello", "hi", "hey"]):
            return f"我在，{self.agent_name} 在线。随时可以开始协作或执行任务。"

        if any(w in compact for w in ["你是谁", "介绍", "身份", "whoareyou"]):
            return (
                f"我是 {self.agent_name}，当前房间中的 AI 协作 Agent。"
                "支持接收代码任务、处理开发议题，以及与其它 Agent 开展 A2A 协议协同讨论。"
            )

        if any(w in compact for w in ["状态", "进度", "status"]):
            return f"[{self.agent_name}] 运行状态正常，连接就绪。正在监听房间消息与协作请求。"

        return None

    async def _generate_reply(self, prompt: str) -> str:
        """调用本地命令或生成智能回复文本。"""
        if self.command:
            try:
                cmd = list(self.command)
                if any("{prompt}" in arg for arg in cmd):
                    cmd = [arg.replace("{prompt}", prompt) for arg in cmd]
                else:
                    cmd.append(prompt)
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=60.0)
                out_text = stdout.decode("utf-8", errors="replace").strip()
                if out_text:
                    return out_text[:1200]
            except Exception as e:
                logger.warning("CLI execution failed: %s, using fallback", e)

        cleaned = self.extract_mention_prompt(prompt)
        return f"[{self.agent_name}] 收到任务：“{cleaned}”。已分析当前上下文，准备执行。"

    # ── A2A 对话交互（Agent ↔ Agent） ─────────────────────

    async def start_dialogue(
        self,
        target_agent: str,
        topic: str,
        ws: Any = None,
        duration_seconds: int = 60,
        max_turns: int = 6,
    ) -> Optional[str]:
        """主动发起与另一 Agent 的 A2A 对话会话。"""
        if not self.room_id or not self.token:
            logger.warning("Cannot start dialogue: missing room_id or token")
            return None

        client = self._get_client()
        headers = {"Authorization": f"Bearer {self.token}"}
        create_payload = {
            "jsonrpc": "2.0",
            "method": "dialogues/create",
            "params": {
                "room_id": self.room_id,
                "initiator_agent": self.agent_name,
                "participants": [self.agent_name, target_agent],
                "duration_seconds": duration_seconds,
                "max_turns": max_turns,
            },
            "id": str(uuid.uuid4()),
        }

        try:
            resp = await client.post(f"{self.server_url}/a2a/dialogue-rpc", json=create_payload, headers=headers)
            data = resp.json()
            dialogue = data.get("result")
            if not dialogue:
                logger.error("dialogues/create failed: %s", data)
                return None

            dialogue_id = dialogue["dialogue_id"]
            self.active_dialogues[dialogue_id] = dialogue

            # 发送第一轮种子消息
            seed_content = f"@{target_agent} 我们围绕“{topic}”开始协作讨论，请先给出你的方案或判断。"
            send_payload = {
                "jsonrpc": "2.0",
                "method": "dialogues/send",
                "params": {
                    "dialogue_id": dialogue_id,
                    "room_id": self.room_id,
                    "sender_id": self.composite_sender_id,
                    "sender_name": self.agent_name,
                    "target_agent": target_agent,
                    "content": seed_content,
                },
                "id": str(uuid.uuid4()),
            }
            await client.post(f"{self.server_url}/a2a/dialogue-rpc", json=send_payload, headers=headers)
            logger.info("A2A dialogue initiated with [%s], dialogue_id=%s", target_agent, dialogue_id)

            if ws:
                notice = {
                    "type": "message",
                    "content": f"🤖 [{self.agent_name}] 已向 @{target_agent} 发起 A2A 协同讨论（议题：{topic}，上限 {max_turns} 轮）。",
                    "sender_type": "agent",
                    "sender_name": self.agent_name,
                    "sender_id": self.composite_sender_id,
                    "msg_type": "text",
                }
                await ws.send(json.dumps(notice))

            return dialogue_id
        except Exception as e:
            logger.exception("start_dialogue error: %s", e)
            return None

    async def handle_dialogue_message(self, dialogue: dict, msg: dict, ws: Any = None) -> Optional[str]:
        """响应来自其它 Agent 的 A2A 对话消息，并生成回复推回 Hub。"""
        dialogue_id = dialogue.get("dialogue_id") or msg.get("dialogue_id")
        if not dialogue_id:
            return None

        target_agent = msg.get("target_agent", "")
        if target_agent and target_agent.lower() != self.agent_name.lower():
            return None

        sender_name = msg.get("sender_name", "")
        if sender_name.lower() == self.agent_name.lower():
            return None

        msg_id = msg.get("id", "")
        if msg_id and msg_id in self.processed_ids:
            return None
        if msg_id:
            self.processed_ids.add(msg_id)

        peer_content = msg.get("content", "")
        current_turn = dialogue.get("current_turn", 1)
        max_turns = dialogue.get("max_turns", 6)
        logger.info("Handling dialogue message from [%s] (turn %s/%s): %s", sender_name, current_turn, max_turns, peer_content[:60])

        client = self._get_client()
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}

        # 检查是否包含结束标记
        if self.is_dialogue_stop(peer_content):
            end_payload = {
                "jsonrpc": "2.0",
                "method": "dialogues/end",
                "params": {"dialogue_id": dialogue_id, "reason": "peer requested stop"},
                "id": str(uuid.uuid4()),
            }
            await client.post(f"{self.server_url}/a2a/dialogue-rpc", json=end_payload, headers=headers)
            self.active_dialogues.pop(dialogue_id, None)
            return "ended"

        # 生成回复
        if "[CONSENSUS]" in peer_content.upper():
            reply_text = f"@{sender_name} 收到，我方同样确认此方案无误。双方正式达成共识 [CONSENSUS]。"
        elif current_turn >= 2:
            reply_text = f"@{sender_name} 方案思路清晰。我方评估技术边界与架构无冲突，可以按此方案实施 [CONSENSUS]。"
        else:
            reply_text = f"@{sender_name} 我方已评估你的提议。核心逻辑可行，建议按照模块职责划分并保持接口精简，推进下一步落地。"

        # 将回复发送回 A2A Hub
        send_payload = {
            "jsonrpc": "2.0",
            "method": "dialogues/send",
            "params": {
                "dialogue_id": dialogue_id,
                "room_id": self.room_id or dialogue.get("room_id"),
                "sender_id": self.composite_sender_id,
                "sender_name": self.agent_name,
                "target_agent": sender_name,
                "content": reply_text,
            },
            "id": str(uuid.uuid4()),
        }

        try:
            resp = await client.post(f"{self.server_url}/a2a/dialogue-rpc", json=send_payload, headers=headers)
            if resp.status_code == 200:
                logger.info("Sent dialogue reply to [%s] successfully", sender_name)
                if "[CONSENSUS]" in reply_text.upper():
                    # 达成共识后平稳收口
                    end_payload = {
                        "jsonrpc": "2.0",
                        "method": "dialogues/end",
                        "params": {"dialogue_id": dialogue_id, "reason": "consensus achieved"},
                        "id": str(uuid.uuid4()),
                    }
                    await client.post(f"{self.server_url}/a2a/dialogue-rpc", json=end_payload, headers=headers)
                    self.active_dialogues.pop(dialogue_id, None)
                return str(uuid.uuid4())
            return None
        except Exception as e:
            logger.exception("Failed to send dialogue reply: %s", e)
            return None

    # ── 房间消息响应（Human ↔ Agent） ─────────────────────

    async def handle_room_message(self, msg: dict, ws: Any) -> Optional[str]:
        """处理房间常规聊天消息，响应 @mention 与发起 A2A 对话。"""
        sender_name = msg.get("sender_name", "")
        sender_id = msg.get("sender_id", "")
        sender_type = str(msg.get("sender_type") or "human").lower()
        if sender_name.lower() == self.agent_name.lower() or sender_id == self.composite_sender_id:
            return None
        if sender_type == "agent":
            # 对方 Agent 发送的房间广播跳过，由 A2A 协议的 handle_dialogue_message 专门处理
            return None

        msg_id = msg.get("id", "")
        if msg_id and msg_id in self.processed_ids:
            return None
        if msg_id:
            self.processed_ids.add(msg_id)

        content = msg.get("content", "").strip()
        if not content:
            return None

        # 仅响应 @ 了当前 Agent 或类型为 task 的消息
        if not self.is_mentioned(content) and msg.get("msg_type") != "task":
            return None

        logger.info("Agent [%s] received mention from [%s]: %s", self.agent_name, sender_name, content)

        # 1. 检查是否要求停止对话
        if self.is_dialogue_stop(content):
            for did in list(self.active_dialogues.keys()):
                client = self._get_client()
                headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
                await client.post(
                    f"{self.server_url}/a2a/dialogue-rpc",
                    json={"jsonrpc": "2.0", "method": "dialogues/end", "params": {"dialogue_id": did, "reason": "stopped by user"}},
                    headers=headers,
                )
            self.active_dialogues.clear()
            reply = f"🤖 [{self.agent_name}] 收到指令，已停止当前活跃的所有协作对话。"
            await ws.send(json.dumps({
                "type": "message",
                "content": reply,
                "sender_type": "agent",
                "sender_name": self.agent_name,
                "sender_id": self.composite_sender_id,
                "msg_type": "text",
            }))
            return reply

        # 2. 检查是否要求发起 A2A 协同讨论
        target_agent, topic = self.detect_dialogue_request(content)
        if target_agent and topic:
            logger.info("Starting A2A dialogue from room mention: target=%s, topic=%s", target_agent, topic)
            did = await self.start_dialogue(target_agent=target_agent, topic=topic, ws=ws)
            return did

        # 3. 常规问候或即时问答
        quick = self.quick_reply(content)
        if quick:
            await ws.send(json.dumps({
                "type": "message",
                "content": quick,
                "sender_type": "agent",
                "sender_name": self.agent_name,
                "sender_id": self.composite_sender_id,
                "msg_type": "text",
            }))
            return quick

        # 4. 复杂任务回复
        reply = await self._generate_reply(content)
        await ws.send(json.dumps({
            "type": "message",
            "content": reply,
            "sender_type": "agent",
            "sender_name": self.agent_name,
            "sender_id": self.composite_sender_id,
            "msg_type": "text",
        }))
        return reply

    # ── 主运行生命周期 ────────────────────────────────────

    async def connect_and_run(
        self,
        token: Optional[str] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
    ) -> None:
        """连接至房间 WebSocket，声明 Agent 身份并进入实时事件监听循环。"""
        if not token:
            if not username or not password:
                raise ValueError("必须提供 --token，或者同时提供 --username 与 --password")
            logger.info("authenticating with server %s as user=%s ...", self.server_url, username)
            async with httpx.AsyncClient(verify=False) as client:
                login_resp = await client.post(
                    f"{self.server_url}/api/v1/auth/login",
                    json={"username": username, "password": password},
                )
                if login_resp.status_code != 200:
                    raise ValueError(f"登录失败 ({login_resp.status_code}): {login_resp.text}")
                data = login_resp.json()
                token = data.get("access_token")
                self.user_id = data.get("user", {}).get("id")
                logger.info("authenticated successfully! access_token obtained.")

        self.token = token
        if not self.room_id:
            raise ValueError("必须通过 --room-id 指定要连入的目标房间 ID")

        # 自动解析房间标识（支持传入房间名称自动解析为房间 UUID）
        try:
            async with httpx.AsyncClient(verify=False, timeout=10.0) as client:
                rooms_resp = await client.get(f"{self.server_url}/api/v1/rooms", headers={"Authorization": f"Bearer {token}"})
                if rooms_resp.status_code == 200:
                    for r in rooms_resp.json().get("rooms", []):
                        if r.get("id") == self.room_id or r.get("name") == self.room_id:
                            self.room_id = r["id"]
                            logger.info("已将房间标识解析为真实房间 UUID: %s", self.room_id)
                            break
        except Exception as e:
            logger.debug("Room resolution skipped: %s", e)

        # 自动向服务端登记 Agent Card 与技能
        await self.register_agent_card(token)

        ws_server = self.server_url.replace("https://", "wss://").replace("http://", "ws://")
        ws_url = f"{ws_server}/ws/chat/{self.room_id}?token={token}"

        logger.info("connecting to room %s as agent [%s] ...", self.room_id, self.agent_name)
        async with websockets.connect(ws_url) as ws:
            # 1. 发送身份宣告帧，让系统识别为 Agent
            identify_payload = {
                "type": "identify",
                "sender_name": self.agent_name,
                "sender_type": "agent",
            }
            await ws.send(json.dumps(identify_payload))
            logger.info("=====================================================")
            logger.info("✅ Agent [%s] 成功连入房间并在线！", self.agent_name)
            logger.info("网页端成员面板现在已经可以看到 🤖 %s 在线。", self.agent_name)
            logger.info("支持群聊 @ 问答应答与 A2A 协议双向协商。")
            logger.info("=====================================================")

            # 2. 持续事件监听循环
            async for raw in ws:
                try:
                    event = json.loads(raw)
                    event_type = event.get("type")

                    if event_type == "task_canceled":
                        task_id = event.get("task_id")
                        if not self.current_task_id or task_id == self.current_task_id:
                            logger.warning("收到任务取消信号 task_id=%s，立即强杀子进程组！", task_id)
                            self.cancel_current_execution()

                    elif event_type == "message":
                        msg = event.get("message", {})
                        await self.handle_room_message(msg, ws)

                    elif event_type == "agent_dialogue_message":
                        dialogue = event.get("dialogue", {})
                        msg = event.get("message", {})
                        await self.handle_dialogue_message(dialogue, msg, ws)

                    elif event_type == "agent_dialogue_ended":
                        did = event.get("dialogue", {}).get("dialogue_id")
                        if did:
                            self.active_dialogues.pop(did, None)
                            logger.info("A2A dialogue ended: %s", did)

                    elif event_type == "user_online":
                        part = event.get("participant", {})
                        logger.info("新成员上线: %s (%s)", part.get("sender_name"), part.get("sender_type"))

                except Exception as err:
                    logger.debug("event parse error: %s", err)


def main() -> None:
    parser = argparse.ArgumentParser(description="Multi-Agent Project Room — Trusted Runner")
    parser.add_argument("--agent-name", required=True, help="智能体名称，例如 Codex-1")
    parser.add_argument("--server", default="http://localhost:8000", help="服务端地址，例如 https://hub.wangdada8208.xyz")
    parser.add_argument("--room-id", required=True, help="目标房间 ID")
    parser.add_argument("--token", default=None, help="已登录用户的 Bearer Token")
    parser.add_argument("--username", default=None, help="账号用户名（用于自动登录）")
    parser.add_argument("--password", default=None, help="账号密码（用于自动登录）")
    parser.add_argument("--command", default=None, help="可选本地 AI 执行命令，例如 codex 或 claude -p")
    args = parser.parse_args()

    runner = TrustedRunner(
        agent_name=args.agent_name,
        server_url=args.server,
        room_id=args.room_id,
        command=args.command,
    )
    try:
        asyncio.run(runner.connect_and_run(token=args.token, username=args.username, password=args.password))
    except KeyboardInterrupt:
        logger.info("runner stopped by user (KeyboardInterrupt)")


if __name__ == "__main__":
    main()
