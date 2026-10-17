"""接入层日志不得包含对话正文。

AGENTS.md 规则 4：加密房间的聊天正文不得写入 Hub 数据库、Hub 日志或 Hub 的异常信息。
trusted_runner 是主人本机执行者，它的日志同样不得记录正文、讨论主题。
本用例先追求"改前的原版会失败"，再追求"改完会通过"。
"""

import asyncio
import logging

import pytest

from trusted_runner import TrustedRunner

SECRET_BODY = "客户合同金额是 480 万元，账号尾号 8813，这是私密正文"


class _CaptureHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record.getMessage())


class _FakeWS:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, payload: str) -> None:
        self.sent.append(payload)


@pytest.fixture()
def captured() -> _CaptureHandler:
    handler = _CaptureHandler()
    root = logging.getLogger()
    old_level = root.level
    root.setLevel(logging.DEBUG)
    root.addHandler(handler)
    try:
        yield handler
    finally:
        root.removeHandler(handler)
        root.setLevel(old_level)


def _assert_no_leak(records: list[str], needle: str) -> None:
    leaked = [r for r in records if needle in r]
    assert leaked == [], f"日志里出现了正文片段：{leaked}"


@pytest.mark.asyncio
async def test_room_mention_log_has_no_body(captured):
    """房间 @ 消息：日志只记身份与长度，不记正文。"""
    runner = TrustedRunner(agent_name="Codex-1")
    ws = _FakeWS()
    msg = {
        "id": "msg-log-1",
        "sender_name": "主人甲",
        "sender_id": "user-jia",
        "sender_type": "human",
        "content": f"@Codex-1 {SECRET_BODY}",
        "msg_type": "text",
    }

    await runner.handle_room_message(msg, ws)

    # 消息确实被处理了（产生了回复），说明走到了打日志那条分支
    assert ws.sent, "用例无效：消息未被处理"
    _assert_no_leak(captured.records, "480 万元")
    _assert_no_leak(captured.records, "8813")
    _assert_no_leak(captured.records, "私密正文")


@pytest.mark.asyncio
async def test_dialogue_message_log_has_no_body(captured):
    """A2A 对话消息：日志不记正文，连前 60 字也不记。"""
    runner = TrustedRunner(agent_name="Claude-1", server_url="http://127.0.0.1:9")
    runner.token = "t"
    dialogue = {"dialogue_id": "dlg-log-2", "current_turn": 1, "max_turns": 4, "room_id": "room-x"}
    msg = {
        "id": "msg-log-2",
        "sender_name": "Codex-1",
        "target_agent": "Claude-1",
        "content": f"{SECRET_BODY}，请评估",
    }

    # 只关心日志：发送失败无所谓，用短超时避免卡住
    try:
        await asyncio.wait_for(runner.handle_dialogue_message(dialogue, msg), timeout=5)
    except Exception:
        pass

    _assert_no_leak(captured.records, "480 万元")
    _assert_no_leak(captured.records, "8813")


@pytest.mark.asyncio
async def test_dialogue_topic_log_has_no_body(captured):
    """发起 A2A 讨论时，讨论主题取自正文，也不得写进日志。"""
    runner = TrustedRunner(agent_name="Codex-1", server_url="http://127.0.0.1:9")
    runner.token = "t"
    runner.room_id = "room-x"
    ws = _FakeWS()
    msg = {
        "id": "msg-log-3",
        "sender_name": "主人甲",
        "sender_id": "user-jia",
        "sender_type": "human",
        "content": f"@Codex-1 请和 @Claude-1 讨论{SECRET_BODY}",
        "msg_type": "text",
    }

    try:
        await asyncio.wait_for(runner.handle_room_message(msg, ws), timeout=5)
    except Exception:
        pass

    _assert_no_leak(captured.records, "480 万元")
    _assert_no_leak(captured.records, "8813")
