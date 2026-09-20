#!/usr/bin/env python3
"""
Trusted Runner — 受控智能体运行器。

特性：
1. 自动登录与认证：支持传入用户名密码或 token，自动向服务端换取身份凭据。
2. 房间长连接与上线：通过 WebSocket 连入指定房间，自动向房间声明 Agent 身份。
3. 强行取消联动：收到 task_canceled 广播时，通过 os.killpg 直接终止子进程组。
4. 迟到输出隔离：取消后子进程返回的任何残留输出均直接丢弃。
5. 操作授权核验：执行特权动作前强制校验 ActionGrant 凭据与参数哈希。
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
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
    """受控智能体运行器。包含执行隔离、取消响应、授权检查与在线状态维持。"""

    def __init__(
        self,
        agent_name: str,
        server_url: str = "http://localhost:8000",
        room_id: Optional[str] = None,
    ) -> None:
        self.agent_name = agent_name
        self.server_url = server_url.rstrip("/")
        self.room_id = room_id
        self.controller = ProcessGroupController()
        self.is_canceled = False
        self.current_task_id: Optional[str] = None

    def cancel_current_execution(self) -> bool:
        """取消当前正在执行的任务，终止底层子进程并设置丢弃标记。"""
        logger.info("cancel request received for runner agent=%s task_id=%s", self.agent_name, self.current_task_id)
        self.is_canceled = True
        killed = self.controller.kill_process_group()
        return killed

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
                token = login_resp.json().get("access_token")
                logger.info("authenticated successfully! access_token obtained.")

        if not self.room_id:
            raise ValueError("必须通过 --room-id 指定要连入的目标房间 ID")

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
                        logger.info("收到房间消息 [%s]: %s", msg.get("sender_name"), msg.get("content"))
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
    args = parser.parse_args()

    runner = TrustedRunner(agent_name=args.agent_name, server_url=args.server, room_id=args.room_id)
    try:
        asyncio.run(runner.connect_and_run(token=args.token, username=args.username, password=args.password))
    except KeyboardInterrupt:
        logger.info("runner stopped by user (KeyboardInterrupt)")


if __name__ == "__main__":
    main()
