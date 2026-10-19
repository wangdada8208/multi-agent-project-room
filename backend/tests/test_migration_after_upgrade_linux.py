"""H3 核心交付：**真跑 alembic 迁移**之后，注册判重与唯一约束是否真的成立。

为什么单独一个文件
------------------
其它 H3 回归用的是 SQLite + `Base.metadata.create_all()`
（`conftest.py` 的默认测试路径）。那条路径按**模型**建表，根本不经过
`alembic/versions/` 里的迁移脚本；而生产环境恰恰只走迁移。于是会出现一种
最危险的偏差：模型和迁移不一致时，测试全绿、生产第二条注册就撞唯一索引。

本文件因此换一种形状：**不调用 create_all()**，而是
1. 从当前 `MAPR_TEST_DATABASE_URL` 推导出一个一次性独立数据库
   （库名带 `_test` 与随机后缀）；
2. 在该库上执行 `alembic upgrade head`（真正跑迁移脚本）；
3. 在**升级后的真实表结构**上，通过真实的 `/api/v1/auth/register` 端点注册；
4. 结束时 DROP DATABASE。

安全护栏（清理必须守住）
------------------------
* 只接受名字里带 `test` 的库名；`postgres`/`template0`/`template1` 以及任何
  不含 `test` 的名字一律 refuse 并 skip，不建也不删。
* 新建的库名 = 推导出的基名 + `_` + 随机后缀，绝不复用已存在的库。
* `DROP DATABASE` 只针对**本测试自己建**的那个名字（内存里记着），并且只在本
  测试确实 CREATE 成功之后才会执行。
* 绝不触碰 `mapr_lead_test` 这类共享库本身：只在它旁边建同前缀的临时库。

非 PostgreSQL（例如默认的 SQLite 测试路径）必须 skip 并写明原因，
不能假装通过——SQLite 上跑不了 `CREATE DATABASE`，也跑不了生产形态的迁移。
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from conftest import engine as isolated_engine
from app.core import database as core_database
from app.core.database import get_db
from app.main import app
from httpx import AsyncClient, ASGITransport

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
ALEMBIC_INI = REPO_ROOT / "alembic.ini"

# 生产环境期望的 Alembic 头（迁移脚本的最终状态）。
HEAD_REVISION = "i90c20261017"
# 回填用例的起点：h80 是「只有 normalized_username」的上一层，
# 从它 upgrade 到 head 正好只跑 i90c20261017 这一个迁移。
PRE_BACKFILL_REVISION = "h80c20261015"
COMPARISON_INDEX = "ux_users_comparison_username"

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(
        isolated_engine.dialect.name != "postgresql",
        reason=(
            "skip: 本测试需要一个真实 PostgreSQL 才能 CREATE DATABASE 并执行 "
            "alembic upgrade head。当前 MAPR_TEST_DATABASE_URL 是 "
            f"{isolated_engine.dialect.name}，SQLite 上既没有 CREATE DATABASE，"
            "也没有生产形态的迁移，因此不能假装通过。"
        ),
    ),
]


# ---------------------------------------------------------------------------
# 库名推导与安全护栏
# ---------------------------------------------------------------------------

_FORBIDDEN_DATABASE_NAMES = {"postgres", "template0", "template1", ""}


def _base_database_name() -> str:
    """从 MAPR_TEST_DATABASE_URL 推导出可用的库名基名。"""
    url = isolated_engine.url
    name = url.database or ""
    if name in _FORBIDDEN_DATABASE_NAMES or "test" not in name:
        pytest.skip(
            "skip: 推导出的库名不含 test 或属于系统库，拒绝建库/删库。"
            f"当前库名={name!r}，请把 MAPR_TEST_DATABASE_URL 指向一个 *_test 库。"
        )
    return name


def _fresh_database_url(base: str) -> tuple[str, str]:
    """返回 (一次性库名, 指向该库的 asyncpg URL)。"""
    name = f"{base[:40]}_{uuid.uuid4().hex[:10]}"
    assert "test" in name and name not in _FORBIDDEN_DATABASE_NAMES
    url = isolated_engine.url.set(database=name)
    return name, url.render_as_string(hide_password=False)


async def _pg_connect_admin():
    """连到共享库（MAPR_TEST_DATABASE_URL 指向的那个）执行 CREATE/DROP DATABASE。

    只用到它作为管理连接的入口：一次性库名单独推导，绝不删共享库本身。
    """
    try:
        import asyncpg
    except ImportError:  # pragma: no cover - requirements pin asyncpg
        pytest.skip("skip: asyncpg 不可用，无法管理一次性数据库")
    base = isolated_engine.url
    # 去掉库名再显式指定 database=：asyncpg 的 DSN 里两者只保留一份即可。
    plain = base.set(drivername="postgresql", database=None).render_as_string(
        hide_password=False
    )
    return await asyncpg.connect(plain, database=base.database)


async def _quote_ident(connection, name: str) -> str:
    return await connection.fetchval("SELECT quote_ident($1)", name)


# ---------------------------------------------------------------------------
# alembic
# ---------------------------------------------------------------------------


def _alembic_run(args: list[str], database_url: str) -> subprocess.CompletedProcess:
    """在仓库根（放 alembic.ini 的地方）用当前解释器跑 alembic。

    数据库由 MAPR_DATABASE_URL 注入，不碰全局环境：
    只给这一条子进程改环境变量。
    """
    assert ALEMBIC_INI.is_file(), f"找不到 alembic.ini: {ALEMBIC_INI}"
    env = os.environ.copy()
    env["MAPR_DATABASE_URL"] = database_url
    env["PYTHONPATH"] = str(BACKEND_DIR)
    return subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ALEMBIC_INI), *args],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )


def _alembic_upgrade(database_url: str, revision: str = "head") -> None:
    result = _alembic_run(["upgrade", revision], database_url)
    assert result.returncode == 0, (
        f"alembic upgrade {revision} 失败\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
    )


# ---------------------------------------------------------------------------
# Fixture：一次性数据库，升级到 head 之后把 app 的 session 指向它
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def migrated_database(monkeypatch):
    """建一个一次性库 -> alembic upgrade head -> 把应用依赖指向它 -> 用完删库。

    yield 一个小对象，带着：
    * ``name`` / ``url``：本次一次性库的名字与连接串；
    * ``session``：指向该库的 session 工厂（查库断言必须用它，
      不能用 conftest 里那份指向共享库的工厂）。
    """
    base = _base_database_name()
    admin = await _pg_connect_admin()
    created: str | None = None
    try:
        created, url = _fresh_database_url(base)
        ident = await _quote_ident(admin, created)
        # 一次性库 + 模板 template0：不受共享库里其它会话影响。
        await admin.execute(f"CREATE DATABASE {ident} TEMPLATE template0")
        _alembic_upgrade(url)

        engine = create_async_engine(url, poolclass=NullPool)
        factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

        async def override_get_db():
            async with factory() as session:
                try:
                    yield session
                finally:
                    await session.close()

        # 只在这个用例期间把 app 的 DB 依赖切到迁移出来的库，
        # 其它模块级常量（如 a2a 的 session 工厂）保持原样，避免污染相邻测试。
        # 必须保存并恢复原有 override：conftest 在导入时注册了一份指向共享库的
        # override，直接 pop 会让同进程后续用例的 app.dependency_overrides[get_db]
        # 消失（后续用例 KeyError）。
        previous_override = app.dependency_overrides.get(get_db)
        monkeypatch.setattr(core_database, "async_session", factory)
        app.dependency_overrides[get_db] = override_get_db
        try:
            yield SimpleNamespace(name=created, url=url, session=factory)
        finally:
            if previous_override is None:
                app.dependency_overrides.pop(get_db, None)
            else:
                app.dependency_overrides[get_db] = previous_override
            await engine.dispose()
    finally:
        if created is not None:
            ident = await _quote_ident(admin, created)
            # 先踢掉残留连接，再删库；只删本测试自己建的那个名字。
            await admin.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = $1 AND pid <> pg_backend_pid()",
                created,
            )
            await admin.execute(f"DROP DATABASE IF EXISTS {ident}")
        await admin.close()


@pytest_asyncio.fixture
async def migrated_client(migrated_database) -> AsyncGenerator[AsyncClient, None]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _unique_ip() -> dict[str, str]:
    """每个用例一个独立来源 IP，避免共享的注册限流桶把用例互相打穿。"""
    octet = uuid.uuid4().int % 200 + 20
    return {"X-Forwarded-For": f"198.18.{octet}.{uuid.uuid4().int % 200 + 20}"}


async def _register(client: AsyncClient, username: str, headers: dict[str, str]):
    return await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": "migration-secret-123",
            "display_name": username,
        },
        headers=headers,
    )


async def _comparison_rows(factory, usernames: list[str]) -> dict[str, str]:
    """直接查库：返回 {username: comparison_username}。

    ``factory`` 必须是 ``migrated_database.session`` —— 指向本次一次性库。
    """
    from sqlalchemy import bindparam, text

    async with factory() as db:
        result = await db.execute(
            text(
                "SELECT username, comparison_username FROM users "
                "WHERE username IN :names"
            ).bindparams(bindparam("names", expanding=True)),
            {"names": usernames},
        )
        return {row[0]: row[1] for row in result.all()}


# ---------------------------------------------------------------------------
# 用例 A：迁移后的默认值不能让两个新账号互相撞死
# ---------------------------------------------------------------------------


async def test_two_different_usernames_both_register_after_migration(migrated_database, migrated_client):
    """A：连续注册两个**不同**用户名，都必须 200。

    这是本次 P0 的直接后果验证。如果模型没映射 comparison_username，
    两行的值都会落到 server_default 的 ""，第二次注册就撞唯一索引。
    """
    prefix = f"mig{uuid.uuid4().hex[:8]}"
    first, second = f"{prefix}_alpha", f"{prefix}_beta"
    headers = _unique_ip()

    resp_first = await _register(migrated_client, first, headers)
    assert resp_first.status_code == 200, resp_first.text

    resp_second = await _register(migrated_client, second, headers)
    assert resp_second.status_code == 200, (
        f"第二个不同名字的新账号应当注册成功，实际 {resp_second.status_code}: "
        f"{resp_second.text}。说明 comparison_username 没有被写入，"
        "落到了空串并撞上唯一索引。"
    )

    rows = await _comparison_rows(migrated_database.session, [first, second])
    assert set(rows) == {first, second}
    assert rows[first] and rows[second], "comparison_username 不应为空串"


# ---------------------------------------------------------------------------
# 用例 B：标点变体只允许一个成功
# ---------------------------------------------------------------------------


async def test_punctuation_variant_cannot_register_twice_after_migration(migrated_database, migrated_client):
    """B：`race_x_bot` 与 `race_x-bot` 是同一个人的两种写法，只能成功一个。

    先先后注册（决定性的 409 来自应用层判重），再并发注册（决定性防线是
    迁移建出来的唯一索引，会以 IntegrityError 的形式冲突并被转成 409）。
    """
    prefix = f"race{uuid.uuid4().hex[:8]}"
    left, right = f"{prefix}_x_bot", f"{prefix}_x-bot"
    headers = _unique_ip()

    # 先后：第一个成功，变体被拒
    assert (await _register(migrated_client, left, headers)).status_code == 200
    sequential = await _register(migrated_client, right, headers)
    assert sequential.status_code == 409, (
        f"标点变体应当被判为同一个人，实际 {sequential.status_code}: {sequential.text}"
    )
    # 第一个成功者必须仍然只有一行
    rows = await _comparison_rows(migrated_database.session, [left, right])
    assert set(rows) == {left}

    # 并发：另一个前缀，两个请求同时打过去，只能有一个成功
    prefix2 = f"race{uuid.uuid4().hex[:8]}"
    names = (f"{prefix2}_x_bot", f"{prefix2}_x-bot")
    responses = await asyncio.gather(
        *(_register(migrated_client, name, headers) for name in names)
    )
    codes = sorted(r.status_code for r in responses)
    assert codes == [200, 409], (
        f"并发注册标点变体应当恰好一个 200 一个 409，实际 {codes}。"
        "若出现 [200, 200]，说明迁移建出来的唯一索引没有生效。"
    )


# ---------------------------------------------------------------------------
# 用例 C：唯一索引确实存在，且新注册行的值等于 comparison_identity(username)
# ---------------------------------------------------------------------------


async def test_unique_index_exists_and_values_match_comparison_identity(migrated_database, migrated_client):
    """C：直接查数据库确认 (1) 唯一索引存在 (2) 回填/写入的是比较键而不是空串。"""
    from app.agent.identity import comparison_identity

    prefix = f"idx{uuid.uuid4().hex[:8]}"
    names = [f"{prefix}_one", f"{prefix}_two"]
    headers = _unique_ip()
    for name in names:
        resp = await _register(migrated_client, name, headers)
        assert resp.status_code == 200, resp.text

    # (1) 唯一索引
    from sqlalchemy import text

    async with migrated_database.session() as db:
        result = await db.execute(
            text(
                "SELECT i.relname, pg_get_indexdef(i.oid) "
                "FROM pg_index x "
                "JOIN pg_class i ON i.oid = x.indexrelid "
                "JOIN pg_class t ON t.oid = x.indrelid "
                "WHERE t.relname = 'users' AND x.indisunique"
            )
        )
        unique_indexes = {row[0]: row[1] for row in result.all()}

    assert COMPARISON_INDEX in unique_indexes, (
        f"迁移没有建出唯一索引 {COMPARISON_INDEX!r}；users 上的唯一索引有 "
        f"{sorted(unique_indexes)}"
    )
    assert "comparison_username" in unique_indexes[COMPARISON_INDEX], (
        f"{COMPARISON_INDEX} 应当建在 comparison_username 上，实际定义："
        f"{unique_indexes[COMPARISON_INDEX]}"
    )

    # (2) 写入的值 = comparison_identity(username)，不是空串也不是 username 原样
    rows = await _comparison_rows(migrated_database.session, names)
    assert set(rows) == set(names)
    for name in names:
        assert rows[name] == comparison_identity(name), (
            f"{name!r} 的 comparison_username 应为 {comparison_identity(name)!r}，"
            f"实际 {rows[name]!r}"
        )
    # 存库的 username 必须保持原样（绝不能被比较键改写）
    assert all(rows[name] != "" for name in names)
    async with migrated_database.session() as db:
        stored = (
            await db.execute(
                text("SELECT username FROM users WHERE username LIKE :p").bindparams(p=f"{prefix}%")
            )
        ).scalars().all()
    assert sorted(stored) == sorted(names), "username 被改写了：比较键不得回写 username"


# ---------------------------------------------------------------------------
# 用例 D：迁移回填老账号
# ---------------------------------------------------------------------------


async def test_backfill_uses_comparison_key_for_legacy_rows(migrated_database):
    """D：upgrade 到 h80 之后、i90 之前插入几条老账号，再 upgrade head。

    老账号在 i90 之前不可能有 comparison_username 的值（列都还不存在），
    所以这里验证的是**迁移自己的回填**，而不是应用层写入路径。

    用 ``migrated_database`` fixture 只为复用「建库 / 联库 / 删库」这套护栏；
    建库之后、alembic upgrade head 之前由本用例接管。
    """
    from sqlalchemy import text

    from app.agent.identity import comparison_identity

    legacy = [
        ("legacy-a", "Legacy_Alpha"),   # 大小写混合
        ("legacy-b", "legacy.beta"),    # 点号
        ("legacy-c", "LEGACY_C"),       # 下划线
        ("legacy-d", "plain-human"),    # 无特殊字符
    ]

    base = _base_database_name()
    admin = await _pg_connect_admin()
    created: str | None = None
    try:
        created, url = _fresh_database_url(base)
        ident = await _quote_ident(admin, created)
        await admin.execute(f"CREATE DATABASE {ident} TEMPLATE template0")

        # 1) 先升到 h80：此时 users 还没有 comparison_username 列
        _alembic_upgrade(url, PRE_BACKFILL_REVISION)

        engine = create_async_engine(url, poolclass=NullPool)
        try:
            async with engine.begin() as conn:
                columns = (
                    await conn.execute(
                        text(
                            "SELECT column_name FROM information_schema.columns "
                            "WHERE table_name = 'users'"
                        )
                    )
                ).scalars().all()
                assert "comparison_username" not in columns, (
                    "h80 阶段的 users 表不应已经有 comparison_username；"
                    "迁移链形状变了，本用例的前提需要重新核对"
                )
                for uid, uname in legacy:
                    await conn.execute(
                        text(
                            "INSERT INTO users (id, username, display_name, user_type) "
                            "VALUES (:id, :username, :display_name, 'human')"
                        ),
                        {"id": uid, "username": uname, "display_name": uname},
                    )

            # 2) 再升到 head：i90 回填 comparison_username
            _alembic_upgrade(url)

            async with engine.connect() as conn:
                revision = (
                    await conn.execute(text("SELECT version_num FROM alembic_version"))
                ).scalar_one()
                result = await conn.execute(
                    text(
                        "SELECT username, comparison_username FROM users "
                        "WHERE id LIKE 'legacy-%'"
                    )
                )
                backfilled = {row[0]: row[1] for row in result.all()}
        finally:
            await engine.dispose()

        assert revision == HEAD_REVISION, (
            f"upgrade head 之后 alembic_version 应为 {HEAD_REVISION!r}，实际 {revision!r}"
        )
        assert set(backfilled) == {uname for _, uname in legacy}
        for _, uname in legacy:
            assert backfilled[uname] == comparison_identity(uname), (
                f"回填值错误：{uname!r} -> {backfilled[uname]!r}，"
                f"期望 {comparison_identity(uname)!r}"
            )
            assert backfilled[uname] != ""
    finally:
        if created is not None:
            ident = await _quote_ident(admin, created)
            await admin.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = $1 AND pid <> pg_backend_pid()",
                created,
            )
            await admin.execute(f"DROP DATABASE IF EXISTS {ident}")
        await admin.close()
