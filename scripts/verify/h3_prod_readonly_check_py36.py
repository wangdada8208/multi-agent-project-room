#!/usr/bin/env python3
"""H3 生产库只读查重（Python 3.6 兼容版，在生产部署机上运行）。

与 scripts/verify/prod_readonly_duplicates.py 的区别：那份用了
`from __future__ import annotations` 与 PEP 585 泛型，需要 Python 3.7+/3.9+；
生产宿主机是 Python 3.6，因此这里去掉所有新语法，只保留同一套比较口径。

口径来源：backend/alembic/versions/i90c20261017_add_unique_comparison_username.py
的 comparison_key()。本文件的 comparison_key 必须是它的逐字等价实现，
否则"查重说 0 组、迁移却停下"。

只读保证：
1. psql 会话设成 READ ONLY，写语句会被数据库直接拒绝；
2. 只 select；
3. 不打印账号原文，只打印打码形式；
4. 不打印数据库口令。
"""
import subprocess
import sys
import unicodedata

DB = "agent_room"
CONTAINER = "multi-agent-project-room-postgres-1"

# 与迁移文件逐字一致
_PUNCTUATION = str.maketrans({"_": "-", ".": "-", "·": "-", "・": "-"})

SELECT_SQL = (
    "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;\n"
    "SELECT current_setting('transaction_read_only');\n"
    "SELECT count(*) FROM users;\n"
    "SELECT username FROM users ORDER BY created_at ASC;\n"
)


def comparison_key(value):
    """与迁移的 comparison_key 等价。"""
    if not isinstance(value, str):
        return ""
    folded = unicodedata.normalize("NFKC", value.strip()).casefold()
    return folded.translate(_PUNCTUATION)


def mask(text):
    if not text:
        return "<empty>"
    if len(text) <= 4:
        return "*" * len(text)
    return text[:2] + "*" * (len(text) - 4) + text[-2:]


def query():
    proc = subprocess.Popen(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", DB,
         "-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    out, err = proc.communicate(SELECT_SQL.encode("utf-8"))
    if proc.returncode != 0:
        raise SystemExit("query failed: " + err.decode("utf-8", "replace")[:300])
    lines = [l for l in out.decode("utf-8", "replace").splitlines() if l.strip()]
    if len(lines) < 2:
        raise SystemExit("unexpected output; wrong database?")
    readonly = lines[0].strip()
    if readonly != "on":
        raise SystemExit("session is NOT read-only (transaction_read_only=%s); refusing" % readonly)
    total = int(lines[1].strip())
    rows = [l for l in lines[2:]]
    return readonly, total, rows


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        # 与期望口径对照，证明函数实现正确
        cases = [
            ("\uff21lice", "alice"),          # 全角 A 与半角
            ("race_x_bot", "race_x-bot"),     # 下划线与连字符
            ("a_b-c", "a-b_c"),               # 混合分隔符
            ("gross", "gro\u00df"),           # 德语 eszett
            ("Ag\u03b8", "ag\u03d1"),         # theta 变体
            ("bob", "alice"),                 # 必须不同
        ]
        ok = True
        for a, b in cases:
            ka, kb = comparison_key(a), comparison_key(b)
            same = ka == kb
            expect = (a, b) not in [("bob", "alice")]
            flag = "OK " if same == expect else "BAD"
            if same != expect:
                ok = False
            print("%s %-14r vs %-14r -> %s" % (flag, a, b, "same" if same else "different"))
        print("selftest:", "PASS" if ok else "FAIL")
        return 0 if ok else 1

    readonly, total, rows = query()
    groups = {}
    for name in rows:
        groups.setdefault(comparison_key(name), []).append(name)
    duplicated = dict((k, v) for k, v in groups.items() if len(v) > 1)

    print("=" * 60)
    print("H3 production duplicate check (READ ONLY, nothing modified)")
    print("=" * 60)
    print("read_only mode            : %s" % readonly)
    print("accounts read             : %d" % len(rows))
    print("database reported total   : %d" % total)
    print("distinct identities       : %d" % len(groups))
    print("DUPLICATE GROUPS          : %d" % len(duplicated))
    print()
    if not duplicated:
        print("RESULT: no duplicate accounts. Migration may proceed.")
        return 0
    print("RESULT: duplicates found; the migration would abort. Handle first.")
    for key, members in sorted(duplicated.items()):
        print("  group [%s] has %d accounts:" % (key, len(members)))
        for name in members:
            print("      %s" % mask(name))
    return 1


if __name__ == "__main__":
    sys.exit(main())
