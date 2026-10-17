#!/usr/bin/env bash
# H3 生产库只读查重：在部署机上跑，不写入任何数据。
#
# 只做三件事：读出账号名单、按比较键分组、打印有几组重复（名字打码）。
# 不执行迁移，不改表，不删账号，不打印密码。
set -euo pipefail

RELEASE_DIR="${MAPR_RELEASE_DIR:-/opt/multi-agent-project-room}"

fail() {
    echo "::error::$1"
    exit 1
}

[ -r "$RELEASE_DIR/.env" ] || fail "读不到 $RELEASE_DIR/.env"

# 只取数据库口令这一个变量，不把整个 .env 打出来。
DB_PASSWORD="$(grep -E '^MAPR_DATABASE_PASSWORD=' "$RELEASE_DIR/.env" | tail -n 1 | cut -d= -f2- | tr -d '"'"'")"
[ -n "$DB_PASSWORD" ] || fail ".env 里没有 MAPR_DATABASE_PASSWORD"

echo "部署目录: $RELEASE_DIR"
docker compose --project-directory "$RELEASE_DIR" ps postgres || true

# 在 compose 的 postgres 容器里跑只读 SQL。事务设为只读，写语句会被数据库直接拒绝。
docker compose --project-directory "$RELEASE_DIR" exec -T postgres \
    psql -U postgres -d agent_room -v ON_ERROR_STOP=1 -X -q <<'SQL'
\echo '--- 会话设为只读 ---'
SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;
SHOW transaction_read_only;

\echo '--- 数据库版本 ---'
SELECT version_num FROM alembic_version;

\echo '--- 账号总数 ---'
SELECT count(*) AS users_total FROM users;

\echo '--- 按比较键分组的重复账号（名字打码，只留前后各 2 字）---'
WITH keys AS (
    SELECT
        id,
        left(username, 2) || repeat('*', greatest(length(username) - 4, 0)) || right(username, 2) AS masked,
        created_at,
        regexp_replace(lower(btrim(username)), '[_.·・]', '-', 'g') AS comparison_key
    FROM users
)
SELECT comparison_key, count(*) AS n, string_agg(masked, ' , ' ORDER BY created_at) AS members
FROM keys
GROUP BY comparison_key
HAVING count(*) > 1
ORDER BY n DESC, comparison_key;

\echo '--- 重复组数（0 表示可以加唯一约束）---'
WITH keys AS (
    SELECT regexp_replace(lower(btrim(username)), '[_.·・]', '-', 'g') AS comparison_key
    FROM users
)
SELECT count(*) AS duplicate_groups
FROM (SELECT comparison_key FROM keys GROUP BY comparison_key HAVING count(*) > 1) t;
SQL

echo
echo "只读查重结束：没有写入、没有改表、没有删账号。"
