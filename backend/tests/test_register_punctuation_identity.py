"""H4 前置回归：注册判重必须把标点变体视为同一个人（不依赖并发、不改数据库结构）。

审计 H3 的原始复现是 `race_x_bot` 与 `race_x-bot` 并发注册都返回 200。
先分清两层：

1. **判重口径**：这两种写法是否被当成同一个人。以前不是——`canonical_identity`
   只做大小写折叠，`_` 与 `-` 被保留，两者算出两个不同的身份键。
   本文件证明这一层已修好：**先后**注册（没有任何并发）就应当被拒。
2. **并发原子性**：两个请求同时到达时的检-插窗口，需要数据库唯一约束才能关掉。
   那一条由 `test_register_race_linux.py::test_normalized_username_has_unique_index`
   守着，需要用户批准迁移后才能转绿，本文件不越权代替它。

这里只用 SQLite 默认测试库即可跑，因为验证的是判重口径，不是并发。
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from httpx import AsyncClient

from conftest import test_session
from app.agent.identity import comparison_identity
from app.agent.service import find_username_matches


def _prefix() -> str:
    return f"punct{uuid4().hex[:8]}"


async def _register(client: AsyncClient, username: str):
    return await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": "punct-secret-123",
            "display_name": username,
        },
        headers={"X-Forwarded-For": "198.51.100.91"},
    )


def test_comparison_identity_folds_name_punctuation():
    """比较键：下划线、连字符、点号视为同一个分隔符；大小写仍然折叠。"""
    assert comparison_identity("race_x_bot") == comparison_identity("race_x-bot")
    assert comparison_identity("race_x_bot") == comparison_identity("race.x.bot")
    assert comparison_identity("Race_X_Bot") == comparison_identity("race-x-bot")
    # 不能过度折叠：不同名字必须仍然是不同的人
    assert comparison_identity("race_x_bot") != comparison_identity("race_xbot")
    assert comparison_identity("alice") != comparison_identity("bob")


@pytest.mark.parametrize(
    "first,second",
    [
        ("_x_bot", "-x-bot"),   # 审计原始复现：标点变体
        ("_x_bot", ".x.bot"),   # 点号变体
        ("_x_bot", "_X_BOT"),   # 标点 + 大小写混合
    ],
)
@pytest.mark.asyncio
async def test_sequential_punctuation_variant_registration_is_rejected(
    client: AsyncClient, first: str, second: str
):
    """先后注册（无并发）：第一个成功，标点变体必须 409。"""
    prefix = _prefix()
    first_username = prefix + first
    second_username = prefix + second

    first_resp = await _register(client, first_username)
    assert first_resp.status_code == 200, first_resp.text

    second_resp = await _register(client, second_username)
    assert second_resp.status_code == 409, (
        f"{second_username!r} 应被判为与 {first_username!r} 同一个人，"
        f"实际 {second_resp.status_code}"
    )


@pytest.mark.asyncio
async def test_punctuation_variant_can_still_log_in_with_original_spelling(
    client: AsyncClient,
):
    """现有账号没有被锁外：用原账号的原写法登录仍然成功。"""
    prefix = _prefix()
    username = prefix + "_owner"
    assert (await _register(client, username)).status_code == 200

    login = await client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": "punct-secret-123"},
        headers={"X-Forwarded-For": "198.51.100.92"},
    )
    assert login.status_code == 200, login.text


@pytest.mark.asyncio
async def test_login_is_not_ambiguous_after_punctuation_fix(client: AsyncClient):
    """登录路径与注册共用判重：标点变体只能解析到唯一账号，不会命中两个。"""
    prefix = _prefix()
    username = prefix + "_only"
    assert (await _register(client, username)).status_code == 200

    async with test_session() as db:
        matches = await find_username_matches(db, username.replace("_only", "-only"))
    assert [m.username for m in matches] == [username]
