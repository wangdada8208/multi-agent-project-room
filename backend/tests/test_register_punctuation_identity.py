"""H4 前置回归：注册判重必须把标点变体视为同一个人（不依赖并发、不改数据库结构）。

审计 H3 的原始复现是 `race_x_bot` 与 `race_x-bot` 并发注册都返回 200。
先分清两层：

1. **判重口径**：这两种写法是否被当成同一个人。以前不是——`canonical_identity`
   只做大小写折叠，`_` 与 `-` 被保留，两者算出两个不同的身份键。
   本文件证明这一层已修好：**先后**注册（没有任何并发）就应当被拒。
2. **并发原子性**：两个请求同时到达时的检-插窗口，需要数据库唯一约束才能关掉。
   那一条由 `test_register_race_linux.py::test_comparison_username_has_unique_index`
   守着（唯一索引建在 `users.comparison_username` 上，名字
   `ux_users_comparison_username`，**不是** `normalized_username`：后者的口径
   不折叠标点，形状与 H3 的语义不符），本文件不越权代替它。
   「真跑过迁移再注册」的那一层由 `test_migration_after_upgrade_linux.py` 守着。

这里只用 SQLite 默认测试库即可跑，因为验证的是判重口径，不是并发。
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from httpx import AsyncClient

from conftest import test_session
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from app.agent.identity import comparison_identity
from app.agent.service import _enum_punctuation_variants, find_username_matches
from app.models.user import User


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


# ---------------------------------------------------------------------------
# 模型层：comparison_username 的维护（含绕过验证器的 Core/bulk 写入）
# ---------------------------------------------------------------------------
#
# `@validates("username")` 只在 ORM 属性赋值时触发；`users.insert()` /
# `bulk_insert_mappings` 这类写入绕过它。如果 comparison_username 用常量
# `default=""`，这些路径的每一行都会落 `""`，第二个不同名账号就撞唯一索引 ——
# 原 P0 的翻版。所以默认值改成按**本行** username 推导
# (`_default_comparison_username`)。下面两条钉住这个行为。


@pytest.mark.asyncio
async def test_core_insert_derives_a_distinct_comparison_key_per_row(db):
    """Core 批量插入两行**不同**用户名：各自拿到自己的比较键，不互相撞。"""
    prefix = _prefix()
    first, second = f"{prefix}_core-one", f"{prefix}.core.two"

    await db.execute(
        User.__table__.insert(),
        [
            {"id": "core-one", "username": first, "display_name": "core one", "user_type": "human"},
            {"id": "core-two", "username": second, "display_name": "core two", "user_type": "human"},
        ],
    )
    await db.commit()

    stored = dict((await db.execute(select(User.username, User.comparison_username))).all())
    assert stored[first] == comparison_identity(first) != ""
    assert stored[second] == comparison_identity(second) != ""
    assert stored[first] != stored[second]


@pytest.mark.asyncio
async def test_core_insert_of_two_rows_with_the_same_comparison_key_is_refused(db):
    """Core 批量插入两行**比较键相同**的用户名：仍必须被唯一索引拒绝。"""
    prefix = _prefix()
    first, second = f"{prefix}_core_x", f"{prefix}-core-x"
    assert comparison_identity(first) == comparison_identity(second)

    with pytest.raises(IntegrityError):
        await db.execute(
            User.__table__.insert(),
            [
                {"id": "dup-one", "username": first, "display_name": "dup one", "user_type": "human"},
                {"id": "dup-two", "username": second, "display_name": "dup two", "user_type": "human"},
            ],
        )
        await db.commit()
    await db.rollback()

    assert (await db.execute(select(User))).scalars().all() == []


# ---------------------------------------------------------------------------
# 混合分隔符排列：SQL 预筛选必须命中，而不是靠数据库唯一索引兜底
# ---------------------------------------------------------------------------
#
# `comparison_identity` 把 _ - . · ・ 折成同一个分隔符，所以
# `a_b-c` 与 `a-b_c` 是同一个人。但 `_enum_punctuation_variants()` 只能生成
# 「所有分隔符统一成同一个字符」的变体，**不含混合排列**：
# 查询 `a-b_c` 时候选集里没有老账号 `a_b-c`。于是应用层漏判，只有数据库唯一
# 索引在写路径上兜底 —— 而登录、agent 授权这些只读路径没有任何兜底。
#
# 修法：预筛选直接等值匹配 `User.comparison_username`（带唯一索引），
# 一次索引等值查询覆盖全部排列，不再枚举。


@pytest.mark.asyncio
async def test_mixed_separator_arrangement_is_found_by_sql_prefilter(db):
    """老账号 `zz…_a_b-c` 用新写法 `zz…-a-b_c` 查询，必须命中（真实 SQL）。"""
    prefix = _prefix()
    legacy_username = f"{prefix}_a_b-c"
    other_spelling = f"{prefix}-a-b_c"
    assert comparison_identity(legacy_username) == comparison_identity(other_spelling)

    db.add(User(username=legacy_username, display_name="legacy", user_type="human"))
    await db.commit()

    matches = await find_username_matches(db, other_spelling)
    assert [m.username for m in matches] == [legacy_username], (
        "混合分隔符排列没有被 SQL 预筛选命中："
        f"{other_spelling!r} 应当找到老账号 {legacy_username!r}"
    )


def test_uniform_variant_enumeration_does_not_cover_mixed_arrangements():
    """钉住旧实现的边界：混合排列本来就不在候选集里，所以索引等值是必需的。"""
    name = "zz123-a-b_c"
    variants = _enum_punctuation_variants(name)
    assert "zz123_a_b-c" not in variants, "如果这里变了，说明兜底枚举的语义被改动了"
    assert comparison_identity("zz123_a_b-c") == comparison_identity(name)


@pytest.mark.asyncio
async def test_mixed_separator_variant_can_log_in(client: AsyncClient):
    """只读路径没有数据库约束兜底：老账号必须能用另一种写法登录成功。

    这条是**有区分度**的端到端断言：若应用层漏判，`find_username_matches`
    返回空，登录就是 401（而不是像注册那样被唯一索引兜成 409）。
    """
    prefix = _prefix()
    legacy_username = f"{prefix}_b_c-d"
    other_spelling = f"{prefix}-b-c_d"
    assert comparison_identity(legacy_username) == comparison_identity(other_spelling)
    assert (await _register(client, legacy_username)).status_code == 200

    login = await client.post(
        "/api/v1/auth/login",
        json={"username": other_spelling, "password": "punct-secret-123"},
        headers={"X-Forwarded-For": "198.51.100.93"},
    )
    assert login.status_code == 200, login.text


@pytest.mark.asyncio
async def test_mixed_separator_variant_registration_is_rejected(client: AsyncClient):
    """端到端：老账号存在时，用混合排列的新写法注册必须 409。

    注意这条不是区分性断言：应用层判对是 409，判漏也会被 comparison_username
    上的唯一索引兜成 409。应用层判对的证据在
    `test_mixed_separator_arrangement_is_found_by_sql_prefilter` 与
    `test_mixed_separator_variant_can_log_in` 两条里。
    """
    prefix = _prefix()
    first_username = f"{prefix}_c_d-e"
    second_username = f"{prefix}-c-d_e"
    assert comparison_identity(first_username) == comparison_identity(second_username)

    assert (await _register(client, first_username)).status_code == 200
    rejected = await _register(client, second_username)
    assert rejected.status_code == 409, rejected.text
