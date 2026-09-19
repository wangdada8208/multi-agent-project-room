#!/usr/bin/env python3
"""
Trusted Runner — 受控智能体运行器。

特性：
1. 子进程组隔离：通过 start_new_session 启动独立进程组。
2. 强行取消联动：接收到取消事件时，通过 os.killpg 直接终止进程组。
3. 迟到输出隔离：取消后子进程返回的任何残留输出均直接丢弃。
4. 操作授权核验：执行特权动作前强制校验 ActionGrant 凭据与参数哈希。
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
from typing import Any, Callable, Coroutine, Optional

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
    """受控智能体运行器。包含执行隔离、取消响应与授权检查。"""

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


def main() -> None:
    parser = argparse.ArgumentParser(description="Multi-Agent Project Room — Trusted Runner")
    parser.add_argument("--agent-name", required=True, help="智能体名称")
    parser.add_argument("--server", default="http://localhost:8000", help="服务端地址")
    parser.add_argument("--room-id", default=None, help="目标房间标识")
    args = parser.parse_args()

    runner = TrustedRunner(agent_name=args.agent_name, server_url=args.server, room_id=args.room_id)
    logger.info("trusted runner initialized for agent=%s", runner.agent_name)


if __name__ == "__main__":
    main()
