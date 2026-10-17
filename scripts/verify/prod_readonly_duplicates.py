#!/usr/bin/env python3
"""H3 生产库只读查重（部署机版）。

和 scripts/verification/h3_check_duplicates_readonly.py 的区别：
那份要人提供连接串；这份在部署机上跑，自己从 .env 和 compose 里找到数据库，
在 postgres 容器里执行只读 SQL，然后把结果交给迁移里的同一个比较函数判定。

为什么不再在 SQL 里写比较规则：
SQL 的 lower/trim 做不了全角转半角。全角的 Ａlice_owner 和 alice-owner
在 SQL 里是两个人，在迁移里是同一个人。两份规则一旦分叉，就会出现
「查重说 0 组、迁移却停下」。现在只保留一个来源：迁移里的 comparison_key。

只读保证：
1. psql 会话设成 READ ONLY，任何写语句会被数据库直接拒绝。
2. 只 select，不 update/delete/insert。
3. 不打印账号名原文，只打印打码后的形式。
4. 不打印数据库口令。
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION = REPO_ROOT / "backend/alembic/versions/i90c20261017_add_unique_comparison_username.py"
DEFAULT_RELEASE_DIR = Path("/opt/multi-agent-project-room")

MASK_KEEP = 2

SELECT_SQL = """
SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;
SELECT current_setting('transaction_read_only') AS readonly_mode;
SELECT count(*) AS users_total FROM users;
SELECT username, created_at FROM users ORDER BY created_at ASC;
"""


def mask(username: str) -> str:
    text = "" if username is None else str(username)
    if not text:
        return "<空>"
    if len(text) <= MASK_KEEP * 2:
        return "*" * len(text)
    return f"{text[:MASK_KEEP]}{'*' * (len(text) - MASK_KEEP * 2)}{text[-MASK_KEEP:]}"


def load_comparison_key():
    """直接加载迁移文件里的 comparison_key，保证全仓库只有一个口径。"""
    spec = importlib.util.spec_from_file_location("h3_migration", MIGRATION)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"加载不了迁移文件：{MIGRATION}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.comparison_key


def query_accounts(release_dir: Path) -> tuple[str, int, list[tuple[str, str]]]:
    """在 postgres 容器里执行只读查询，返回 (只读模式, 账号总数, [(名字, 注册时间)])。"""
    proc = subprocess.run(
        [
            "docker", "compose", "--project-directory", str(release_dir),
            "exec", "-T", "postgres",
            "psql", "-U", "postgres", "-d", "agent_room",
            "-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t", "-F", "\t",
        ],
        input=SELECT_SQL,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"数据库查询失败：{proc.stderr.strip()[:300]}")

    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    if len(lines) < 2:
        raise RuntimeError("数据库返回内容不符合预期，可能没连上正确的库。")

    readonly_mode = lines[0].strip()
    if readonly_mode != "on":
        raise RuntimeError(f"会话不是只读模式（transaction_read_only={readonly_mode}），拒绝继续。")

    total = int(lines[1].strip())
    rows: list[tuple[str, str]] = []
    for line in lines[2:]:
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        rows.append((parts[0], parts[1]))
    return readonly_mode, total, rows


def main() -> int:
    parser = argparse.ArgumentParser(description="H3 生产库只读查重（在部署机上跑）")
    parser.add_argument("--release-dir", default=str(DEFAULT_RELEASE_DIR))
    parser.add_argument(
        "--rows",
        help="调试用：不连数据库，直接读一份制表符分隔的 名字<TAB>时间 文件",
    )
    args = parser.parse_args()

    comparison_key = load_comparison_key()

    if args.rows:
        readonly_mode = "本地文件"
        pairs = [ln.rstrip("\n").split("\t") for ln in open(args.rows, encoding="utf-8") if ln.strip()]
        rows = [(p[0], p[1] if len(p) > 1 else "") for p in pairs]
        total = len(rows)
    else:
        release_dir = Path(args.release_dir)
        env_file = release_dir / ".env"
        if not env_file.is_file():
            print(f"读不到 {env_file}", file=sys.stderr)
            return 2
        try:
            readonly_mode, total, rows = query_accounts(release_dir)
        except Exception as exc:  # noqa: BLE001 - 只报类型和简短原因
            print(f"连接或查询失败：{type(exc).__name__}: {exc}", file=sys.stderr)
            return 2

    groups: dict[str, list[tuple[str, str]]] = {}
    for username, created_at in rows:
        groups.setdefault(comparison_key(username), []).append((username, created_at))

    duplicated = {k: v for k, v in groups.items() if len(v) > 1}

    print("=" * 62)
    print("H3 生产库查重（只读，未修改任何数据）")
    print("=" * 62)
    print(f"只读模式          : {readonly_mode}")
    print(f"读到的账号数      : {len(rows)}")
    print(f"数据库报告总数    : {total}")
    print(f"判为同一个人的组数: {len(groups)}")
    print(f"存在重复的组数    : {len(duplicated)}")
    print()

    if not duplicated:
        print("结论：没有发现重复账号。可以执行加唯一约束的迁移。")
        return 0

    print("结论：发现重复账号。必须先处置，不能直接加唯一约束。")
    print()
    for key, members in sorted(duplicated.items()):
        print(f"组 [{key}] 共 {len(members)} 个账号：")
        for username, created_at in sorted(members, key=lambda x: x[1]):
            print(f"    {mask(username):<24} 注册时间 {created_at}")
        print()
    print("脚本本身不会删除或修改任何账号。处置方案见 H3-执行手册第 4 节。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
