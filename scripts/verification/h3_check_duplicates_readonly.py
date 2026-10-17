#!/usr/bin/env python3
"""H3 生产库只读查重：加唯一约束之前，先看有没有重复账号。

只读。不会写、不会改、不会删任何数据。
用法见 docs/verification/2026-10-17-H3-执行手册.md。

设计要点：
1. 用「比较键」查重，和注册判重用的是同一套标准（大小写折叠 + 标点 _ - . · ・ 等价）。
   如果改用普通大小写比较，会漏掉 race_x_bot / race_x-bot 这类真正冲突的账号。
2. 不打印密码，一个字都不碰。
3. 用户名打码，只留前后各 2 个字符。
4. 只输出聚合信息（几组、每组几个、什么时候注册），不导出账号清单。
"""

from __future__ import annotations

import argparse
import os
import sys

MASK_KEEP = 2


def mask(username: str) -> str:
    """只留前后各 2 个字符，中间全部用 * 代替。"""
    if username is None:
        return "<空>"
    text = str(username)
    if len(text) <= MASK_KEEP * 2:
        return "*" * len(text) if text else "<空>"
    return f"{text[:MASK_KEEP]}{'*' * (len(text) - MASK_KEEP * 2)}{text[-MASK_KEEP:]}"


def comparison_key(username: str) -> str:
    """与 backend/app/agent/identity.py 的 comparison_identity 保持一致。

    刻意在这里重写一遍而不从应用导入：查重脚本要能独立跑，不依赖应用能启动。
    两处必须同步；执行手册里写了如何核对一致性。
    """
    import unicodedata

    if not isinstance(username, str):
        return ""
    folded = unicodedata.normalize("NFKC", username.strip()).casefold()
    table = str.maketrans({"_": "-", ".": "-", "·": "-", "・": "-"})
    return folded.translate(table)


def _fetch_rows(dsn: str) -> list[tuple[str, object]]:
    """用 asyncpg 只读读取账号名与注册时间。不读密码列。"""
    import asyncio

    async def _run() -> list[tuple[str, object]]:
        import asyncpg  # type: ignore

        # asyncpg 只认 postgresql:// 与 postgres://，把 SQLAlchemy 写法的 +asyncpg 去掉。
        clean_dsn = dsn.replace("postgresql+asyncpg://", "postgresql://").replace(
            "postgres+asyncpg://", "postgres://"
        )
        conn = await asyncpg.connect(clean_dsn)
        try:
            # 整条事务设为只读，任何写入语句都会被数据库直接拒绝。
            await conn.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
            records = await conn.fetch(SQL_SELECT)
        finally:
            await conn.close()
        return [(r["username"], r["created_at"]) for r in records]

    return asyncio.run(_run())


def main() -> int:
    parser = argparse.ArgumentParser(description="H3 生产库只读查重")
    parser.add_argument(
        "--dsn",
        default=os.environ.get("MAPR_READONLY_DSN", ""),
        help="只读连接串；也可用环境变量 MAPR_READONLY_DSN",
    )
    parser.add_argument(
        "--sql-only",
        action="store_true",
        help="只打印 SQL 文本，不连接数据库（交给 DBA 或用户在控制台手动执行）",
    )
    args = parser.parse_args()

    if args.sql_only:
        print(SQL_TEXT)
        return 0

    if not args.dsn:
        print("缺少 --dsn 或 MAPR_READONLY_DSN。", file=sys.stderr)
        print("如果不想给连接串，可以用 --sql-only 只打印 SQL。", file=sys.stderr)
        return 2

    try:
        rows = _fetch_rows(args.dsn)
    except Exception as exc:  # noqa: BLE001 - 只用类型名，避免把连接串带进输出
        print(f"连接或查询失败：{type(exc).__name__}", file=sys.stderr)
        print("如果不想给连接串，可以用 --sql-only 只打印 SQL。", file=sys.stderr)
        return 2

    groups: dict[str, list[tuple[str, object]]] = {}
    for username, created_at in rows:
        groups.setdefault(comparison_key(username), []).append((username, created_at))

    duplicated = {k: v for k, v in groups.items() if len(v) > 1}

    print("=" * 62)
    print("H3 查重结果（只读，未修改任何数据）")
    print("=" * 62)
    print(f"扫描到账号总数        : {len(rows)}")
    print(f"判为同一个人的组数    : {len(groups)}")
    print(f"存在重复的组数        : {len(duplicated)}")
    print()

    if not duplicated:
        print("结论：没有发现重复账号。可以继续执行加唯一约束的迁移。")
        return 0

    print("结论：发现重复账号。**必须先处置，不能直接加唯一约束。**")
    print()
    for key, members in sorted(duplicated.items()):
        print(f"组 [{key}] 共 {len(members)} 个账号：")
        for username, created_at in sorted(members, key=lambda x: str(x[1])):
            print(f"    {mask(username):<24} 注册时间 {created_at}")
        print()
    print("处置选项见执行手册第 4 节。脚本本身不会删除或修改任何账号。")
    return 1


SQL_SELECT = """
SELECT username, created_at
FROM users
ORDER BY created_at ASC
"""

SQL_TEXT = """-- H3 生产库只读查重（只读，不改数据）
-- 说明：应用层的「判为同一个人」= 大小写折叠 + 把 _ - . · ・ 视为同一个分隔符。
-- 纯 SQL 表达这个等价关系需要 large object / regexp_replace，下面是等价写法。
-- 用法：从这一行往下整段复制，粘贴到数据库管理界面执行。
--       结果里 n > 1 的行就是重复组；一行都没有表示没有重复。
WITH keys AS (
    SELECT
        username,
        created_at,
        regexp_replace(lower(trim(username)), '[_.·・]', '-', 'g') AS comparison_key
    FROM users
)
SELECT comparison_key, count(*) AS n
FROM keys
GROUP BY comparison_key
HAVING count(*) > 1
ORDER BY n DESC, comparison_key;
"""


if __name__ == "__main__":
    raise SystemExit(main())
