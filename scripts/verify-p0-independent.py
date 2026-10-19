"""Lead 独立验证：P0（i90 迁移后的 comparison_username）真实端到端行为。

不依赖任何同事写的测试断言，直接用真实迁移过的 PostgreSQL 库 + 真实 ASGI 应用
调用注册端点，验证三件事：
  A. 连续注册两个**不同**用户名都必须成功（原 P0 的失效模式是第二个 409/500）
  B. 标点变体（_x_bot / -x-bot）**并发**注册只允许一个成功
  C. 数据库里的 comparison_username 等于 comparison_identity(username)，
     且不存在重复比较键

用法：
  MAPR_DATABASE_URL=.../mapr_lead_p0_test MAPR_TEST_DATABASE_URL=...  \
  MAPR_TESTING=1 MAPR_TEST_REDIS_URL=redis://127.0.0.1:6379/15      \
  PYTHONPATH=backend .venv/bin/python scripts/../<this file>
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(REPO / "backend" / "tests"))

os.environ.setdefault("MAPR_TESTING", "1")

import httpx  # noqa: E402
from sqlalchemy import text  # noqa: E402

from conftest import engine, test_session  # noqa: E402
from app.main import app  # noqa: E402
from app.core.database import Base  # noqa: E402
from app.agent.identity import comparison_identity  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")


async def register(client: httpx.AsyncClient, username: str, ip: str):
    return await client.post(
        "/api/v1/auth/register",
        json={"username": username, "password": "independent-secret-1", "display_name": username},
        headers={"X-Forwarded-For": ip},
    )


async def main() -> int:
    # Fresh schema straight from the real migrations (NOT create_all).
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE IF EXISTS alembic_version"))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        # A. two DIFFERENT usernames must both succeed. Before the fix the second
        #    one collided on the shared "" comparison key.
        a1 = await register(client, "indepalpha01", "203.0.113.11")
        a2 = await register(client, "indepbeta02", "203.0.113.12")
        check(
            "A1 第一个不同用户名注册成功",
            a1.status_code == 200,
            f"got {a1.status_code} {a1.text[:120]}",
        )
        check(
            "A2 第二个不同用户名也注册成功（原 P0 失效点）",
            a2.status_code == 200,
            f"got {a2.status_code} {a2.text[:160]}",
        )

        # B. punctuation variants concurrently: exactly one winner.
        r1, r2 = await asyncio.gather(
            register(client, "indeprace_x_bot", "203.0.113.21"),
            register(client, "indeprace-x-bot", "203.0.113.22"),
        )
        codes = sorted([r1.status_code, r2.status_code])
        check(
            "B1 标点变体并发注册只允许一个成功",
            codes == [200, 409],
            f"got {codes}",
        )

    # C. DB-level invariants on the real table.
    async with test_session() as session:
        rows = (
            await session.execute(
                text("SELECT username, comparison_username FROM users ORDER BY username")
            )
        ).all()
        mismatched = [
            (u, c) for u, c in rows if c != comparison_identity(u)
        ]
        check(
            "C1 comparison_username 等于 comparison_identity(username)",
            not mismatched,
            f"mismatched={mismatched[:3]}",
        )
        keys = [c for _, c in rows]
        check("C2 不存在重复比较键", len(keys) == len(set(keys)), f"rows={len(rows)}")
        check("C3 没有比较键为空串的行", all(k != "" for k in keys), "")

        idx = (
            await session.execute(
                text(
                    "SELECT indexdef FROM pg_indexes WHERE tablename='users' "
                    "AND indexname='ux_users_comparison_username'"
                )
            )
        ).scalar()
        check(
            "C4 唯一索引 ux_users_comparison_username 存在",
            bool(idx) and "UNIQUE" in idx.upper(),
            str(idx),
        )

    failed = [r for r in RESULTS if not r[1]]
    print(f"\n=== {len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed ===")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
