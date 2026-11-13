#!/usr/bin/env python3
"""Standalone pytest proving prod_legacy_rooms_cleanup.py against a REAL local
PostgreSQL 17 on port 55434 (data dir /tmp/mapr-hygiene-pgdata).

Isolation: this suite uses ONLY port 55434. It never touches 5432 / 55432 /
55433 / 6379, never contacts production, and is fully offline/deterministic.

Run from the repo root:

    .venv/bin/python -m pytest scripts/verify/test_prod_legacy_rooms_cleanup.py -v -s

The suite itself brings up PG, builds the REAL schema via alembic, inserts a
synthetic dataset, and drives the tool in check / backup / execute modes.

NOTE on Python 3.6: the production host runs python3.6. This suite runs under
the repo venv (3.13) for functional execution, and separately proves the tool's
source is Python-3.6-grammar compatible (ast.parse feature_version) and free of
3.7+/3.8+ APIs. The test helper below uses subprocess.run-style conveniences
freely because it is NOT shipped to the 3.6 host; only the tool is.
"""
import ast
import glob
import json
import os
import subprocess
import sys
import time

import pytest

# ---------------------------------------------------------------------------
# Environment / constants
# ---------------------------------------------------------------------------
PGBIN = "/usr/lib/postgresql/17/bin"
PGDATA = "/tmp/mapr-hygiene-pgdata"
PGPORT = "55434"
PGHOST = "127.0.0.1"
PGUSER = "postgres"
DBNAME = "agent_room_hygiene"
PGLOG = "/tmp/mapr-hygiene-pg.log"
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOL = os.path.join(REPO, "scripts", "verify", "prod_legacy_rooms_cleanup.py")

CONFIRM_TOKEN = "DELETE-LEGACY-HUB-ROOMS"
LEGACY_IDS = ["legacy-hub-1", "legacy-hub-2"]
PRESERVED_IDS = ["_agent_internal", "xmtp-room-1", "xmtp-room-2"]

EXPECTED_ROOM_ID_TABLES = [
    "a2a_tasks", "action_grants", "analytics_events", "approvals",
    "knowledge_docs", "messages", "room_files", "room_invites",
    "room_permissions", "room_presences", "room_share_tokens",
]


def psql_argv(db):
    return [
        "psql", "-h", PGHOST, "-p", PGPORT, "-U", PGUSER, "-d", db,
        "-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t",
    ]


def run_sql(env, sql, db=DBNAME):
    proc = subprocess.Popen(
        psql_argv(db), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, env=env,
    )
    out, err = proc.communicate(sql.encode("utf-8"))
    assert proc.returncode == 0, "psql failed: %s" % err.decode("utf-8", "replace")[-800:]
    return out.decode("utf-8", "replace")


def scalar(env, sql):
    return int(run_sql(env, sql).strip())


def base_env(tmp_path_factory):
    root = tmp_path_factory.mktemp("prod_hygiene")
    env = dict(os.environ)
    env["MAPR_HYGIENE_PSQL_CMD"] = (
        "psql -h %s -p %s -U %s -d %s" % (PGHOST, PGPORT, PGUSER, DBNAME)
    )
    # Explicit override so local verification never needs sudo/root or writes /opt.
    env["MAPR_HYGIENE_BACKUP_DIR"] = str(root / "backups")
    env["GITHUB_WORKSPACE"] = str(root / "ghws")
    env.pop("MAPR_HYGIENE_DEBUG", None)
    return env


def ensure_pg(env):
    if not os.path.isfile(os.path.join(PGDATA, "PG_VERSION")):
        subprocess.check_call(
            [os.path.join(PGBIN, "initdb"), "-D", PGDATA, "-U", PGUSER, "--auth=trust"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
        )
    running = subprocess.call(
        [os.path.join(PGBIN, "pg_ctl"), "-D", PGDATA, "status"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
    ) == 0
    if not running:
        subprocess.check_call(
            [os.path.join(PGBIN, "pg_ctl"), "-D", PGDATA,
             "-o", "-p %s -k /tmp" % PGPORT, "-l", PGLOG, "start"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
        )
    for _ in range(40):
        ok = subprocess.call(
            psql_argv("postgres") + ["-Atc", "select 1;"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
        ) == 0
        if ok:
            return
        time.sleep(0.25)
    raise RuntimeError("PostgreSQL did not become ready on port %s" % PGPORT)


def create_db(env):
    run_sql(env, "DROP DATABASE IF EXISTS %s WITH (FORCE);" % DBNAME, db="postgres")
    run_sql(env, "CREATE DATABASE %s;" % DBNAME, db="postgres")


def alembic_upgrade(env):
    aenv = dict(env)
    aenv["MAPR_DATABASE_URL"] = (
        "postgresql+asyncpg://%s@%s:%s/%s" % (PGUSER, PGHOST, PGPORT, DBNAME)
    )
    aenv["PYTHONPATH"] = "backend"
    proc = subprocess.Popen(
        [os.path.join(REPO, ".venv", "bin", "python"), "-m", "alembic", "upgrade", "head"],
        cwd=REPO, env=aenv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    out, err = proc.communicate()
    assert proc.returncode == 0, "alembic upgrade head failed:\n%s" % (
        (out + err).decode("utf-8", "replace")[-1500:]
    )


# ---------------------------------------------------------------------------
# Synthetic dataset (2 legacy hub, 1 _agent_ hub, 2 xmtp rooms)
# ---------------------------------------------------------------------------
DATASET_SQL = """
BEGIN;

-- Users: comparison_username has a UNIQUE index (H3), so give distinct values.
INSERT INTO public.users
    (id, username, display_name, normalized_username, comparison_username)
VALUES
    ('u-seed-1','seed-one','Seed One','seed-one','seed-one'),
    ('u-seed-2','seed-two','Seed Two','seed-two','seed-two'),
    ('u-seed-3','seed-three','Seed Three','seed-three','seed-three');

-- Rooms. _agent_internal is transport='hub' but MUST be preserved because its
-- id starts with _agent_. The two xmtp rooms MUST be preserved.
INSERT INTO public.rooms (id, name, transport, created_by)
VALUES
    ('legacy-hub-1','Legacy One','hub','u-seed-1'),
    ('legacy-hub-2','Legacy Two','hub','u-seed-1'),
    ('_agent_internal','Agent Channel','hub','u-seed-1'),
    ('xmtp-room-1','Xmtp One','xmtp','u-seed-1'),
    ('xmtp-room-2','Xmtp Two','xmtp','u-seed-1');

-- Messages (content is test data only; the TOOL never prints bodies).
-- room_seq is part of the UNIQUE index uq_message_room_seq(room_id, room_seq)
-- and defaults to 0, so every message in the same room needs an explicit,
-- distinct sequence number or the fixture itself violates the constraint.
INSERT INTO public.messages (id, room_id, sender_id, content, parent_id, room_seq)
VALUES
    ('m-l1-1','legacy-hub-1','u-seed-1','legacy body 1', NULL, 1),
    ('m-l1-2','legacy-hub-1','u-seed-1','legacy body 2', NULL, 2),
    ('m-l2-1','legacy-hub-2','u-seed-1','legacy body 3', NULL, 1),
    ('m-ag-1','_agent_internal','u-seed-1','agent body', NULL, 1),
    ('m-x1-1','xmtp-room-1','u-seed-1','xmtp body 1', NULL, 1),
    ('m-x2-1','xmtp-room-2','u-seed-1','xmtp body 2', NULL, 1);
-- A legacy message referencing another legacy message through parent_id
-- (self-FK). This exercises the parent_id UPDATE path.
UPDATE public.messages SET parent_id = 'm-l1-1' WHERE id = 'm-l1-2';

-- Approvals (one per room) needed by action_grants.approval_id (NOT NULL FK).
INSERT INTO public.approvals (id, room_id, requestor_id, title)
VALUES
    ('appr-l1','legacy-hub-1','u-seed-1','Approval L1'),
    ('appr-l2','legacy-hub-2','u-seed-1','Approval L2'),
    ('appr-ag','_agent_internal','u-seed-1','Approval AG'),
    ('appr-x1','xmtp-room-1','u-seed-1','Approval X1'),
    ('appr-x2','xmtp-room-2','u-seed-1','Approval X2');

-- Action grants (inter-child FK approval_id -> approvals, CASCADE).
INSERT INTO public.action_grants
    (id, approval_id, room_id, granted_to_agent, scope, params_hash, expires_at)
VALUES
    ('ag-l1','appr-l1','legacy-hub-1','agent-a','read','hash-l1', now() + interval '1 day'),
    ('ag-l2','appr-l2','legacy-hub-2','agent-a','read','hash-l2', now() + interval '1 day'),
    ('ag-ag','appr-ag','_agent_internal','agent-a','read','hash-ag', now() + interval '1 day'),
    ('ag-x1','appr-x1','xmtp-room-1','agent-a','read','hash-x1', now() + interval '1 day'),
    ('ag-x2','appr-x2','xmtp-room-2','agent-a','read','hash-x2', now() + interval '1 day');

-- A2A tasks: task-l1 has source_message_id pointing at a legacy message
-- (FK -> messages, SET NULL). Non-legacy tasks have NULL so they stay intact.
INSERT INTO public.a2a_tasks (id, query, room_id, source_message_id)
VALUES
    ('task-l1','task query 1','legacy-hub-1','m-l1-1'),
    ('task-l2','task query 2','legacy-hub-2', NULL),
    ('task-ag','task query 3','_agent_internal', NULL),
    ('task-x1','task query 4','xmtp-room-1', NULL),
    ('task-x2','task query 5','xmtp-room-2', NULL);

-- analytics_events has room_id but NO FK to rooms: only catalog-driven
-- deletion removes these rows.
INSERT INTO public.analytics_events (id, event_type, room_id, user_id)
VALUES
    ('ev-l1','room_view','legacy-hub-1','u-seed-1'),
    ('ev-l2','room_view','legacy-hub-2','u-seed-1'),
    ('ev-ag','room_view','_agent_internal','u-seed-1'),
    ('ev-x1','room_view','xmtp-room-1','u-seed-1'),
    ('ev-x2','room_view','xmtp-room-2','u-seed-1');

INSERT INTO public.knowledge_docs (id, room_id, title, content)
VALUES
    ('kd-l1','legacy-hub-1','Doc L1','doc body'),
    ('kd-l2','legacy-hub-2','Doc L2','doc body'),
    ('kd-ag','_agent_internal','Doc AG','doc body'),
    ('kd-x1','xmtp-room-1','Doc X1','doc body'),
    ('kd-x2','xmtp-room-2','Doc X2','doc body');

INSERT INTO public.room_files (id, room_id, filename, stored_name, size, uploaded_by)
VALUES
    ('rf-l1','legacy-hub-1','f1.txt','s1',10,'u-seed-1'),
    ('rf-l2','legacy-hub-2','f2.txt','s2',10,'u-seed-1'),
    ('rf-ag','_agent_internal','f3.txt','s3',10,'u-seed-1'),
    ('rf-x1','xmtp-room-1','f4.txt','s4',10,'u-seed-1'),
    ('rf-x2','xmtp-room-2','f5.txt','s5',10,'u-seed-1');

INSERT INTO public.room_invites
    (token, room_id, created_by, proposed_scopes, expires_at, created_at)
VALUES
    ('inv-l1','legacy-hub-1','u-seed-1','[]', now() + interval '1 day', now()),
    ('inv-l2','legacy-hub-2','u-seed-1','[]', now() + interval '1 day', now()),
    ('inv-ag','_agent_internal','u-seed-1','[]', now() + interval '1 day', now()),
    ('inv-x1','xmtp-room-1','u-seed-1','[]', now() + interval '1 day', now()),
    ('inv-x2','xmtp-room-2','u-seed-1','[]', now() + interval '1 day', now());

INSERT INTO public.room_permissions (id, room_id, user_id)
VALUES
    ('rp-l1','legacy-hub-1','u-seed-2'),
    ('rp-l2','legacy-hub-2','u-seed-2'),
    ('rp-ag','_agent_internal','u-seed-2'),
    ('rp-x1','xmtp-room-1','u-seed-2'),
    ('rp-x2','xmtp-room-2','u-seed-2');

INSERT INTO public.room_presences
    (connection_id, room_id, user_id, hub_id, joined_at, last_seen_at, lease_until)
VALUES
    ('cp-l1','legacy-hub-1','u-seed-2','hub-a',now(),now(), now() + interval '1 hour'),
    ('cp-l2','legacy-hub-2','u-seed-2','hub-a',now(),now(), now() + interval '1 hour'),
    ('cp-ag','_agent_internal','u-seed-2','hub-a',now(),now(), now() + interval '1 hour'),
    ('cp-x1','xmtp-room-1','u-seed-2','hub-a',now(),now(), now() + interval '1 hour'),
    ('cp-x2','xmtp-room-2','u-seed-2','hub-a',now(),now(), now() + interval '1 hour');

INSERT INTO public.room_share_tokens (id, room_id, token, created_by, expires_at)
VALUES
    ('rst-l1','legacy-hub-1','tok-l1','u-seed-1', now() + interval '1 day'),
    ('rst-l2','legacy-hub-2','tok-l2','u-seed-1', now() + interval '1 day'),
    ('rst-ag','_agent_internal','tok-ag','u-seed-1', now() + interval '1 day'),
    ('rst-x1','xmtp-room-1','tok-x1','u-seed-1', now() + interval '1 day'),
    ('rst-x2','xmtp-room-2','tok-x2','u-seed-1', now() + interval '1 day');

COMMIT;
"""


def all_base_tables(env, exclude_alembic=False):
    sql = (
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='public' AND table_type='BASE TABLE' "
    )
    if exclude_alembic:
        sql += "AND table_name <> 'alembic_version' "
    sql += "ORDER BY table_name;"
    return [ln.strip() for ln in run_sql(env, sql).splitlines() if ln.strip()]


def room_id_tables(env):
    sql = (
        "SELECT table_name FROM information_schema.columns "
        "WHERE table_schema='public' AND column_name='room_id' ORDER BY table_name;"
    )
    return [ln.strip() for ln in run_sql(env, sql).splitlines() if ln.strip()]


def reset_dataset(env):
    tables = all_base_tables(env, exclude_alembic=True)
    trunc = "TRUNCATE TABLE " + ", ".join(
        '"public"."%s"' % t for t in tables
    ) + " RESTART IDENTITY CASCADE;"
    run_sql(env, trunc)
    run_sql(env, DATASET_SQL)


def fingerprint(env):
    """Row count of every public table: detects ANY insert/delete."""
    result = {}
    for t in all_base_tables(env):
        result[t] = scalar(env, 'SELECT count(*) FROM "public"."%s";' % t)
    return result


def rooms_snapshot(env):
    return {
        "total": scalar(env, "SELECT count(*) FROM public.rooms;"),
        "xmtp": scalar(env, "SELECT count(*) FROM public.rooms WHERE transport='xmtp';"),
        "agent": scalar(env, "SELECT count(*) FROM public.rooms WHERE left(id,7)='_agent_';"),
        "legacy": scalar(
            env, "SELECT count(*) FROM public.rooms "
                 "WHERE transport='hub' AND left(id,7) <> '_agent_';"
        ),
    }


def per_table_counts(env, room_ids):
    ids = ", ".join("'" + r + "'" for r in room_ids)
    result = {}
    for t in room_id_tables(env):
        result[t] = scalar(
            env, 'SELECT count(*) FROM "public"."%s" WHERE "room_id" IN (%s);' % (t, ids)
        )
    return result


def room_orphans(env):
    total = 0
    for t in room_id_tables(env):
        total += scalar(
            env, 'SELECT count(*) FROM "public"."%s" WHERE "room_id" IS NOT NULL '
                 'AND "room_id" NOT IN (SELECT "id" FROM "public"."rooms");' % t
        )
    return total


def message_orphans(env):
    # messages.parent_id -> messages.id and a2a_tasks.source_message_id -> messages.id
    total = scalar(
        env, "SELECT count(*) FROM public.messages WHERE parent_id IS NOT NULL "
             "AND parent_id NOT IN (SELECT id FROM public.messages);"
    )
    total += scalar(
        env, "SELECT count(*) FROM public.a2a_tasks WHERE source_message_id IS NOT NULL "
             "AND source_message_id NOT IN (SELECT id FROM public.messages);"
    )
    return total


def run_tool(env, mode, confirm=""):
    cmd = [sys.executable, TOOL, "--mode", mode, "--confirm", confirm]
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, env=env,
    )
    out, err = proc.communicate()
    return (
        proc.returncode,
        out.decode("utf-8", "replace"),
        err.decode("utf-8", "replace"),
    )


def parse_summary(stdout):
    for line in stdout.splitlines():
        if line.startswith("JSON_SUMMARY "):
            return json.loads(line[len("JSON_SUMMARY "):])
    raise AssertionError("no JSON_SUMMARY line in tool output:\n" + stdout)


def backup_path_from(stdout):
    lines = [l[len("BACKUP_PATH "):].strip() for l in stdout.splitlines()
             if l.startswith("BACKUP_PATH ")]
    assert lines, "no BACKUP_PATH line in tool output:\n" + stdout
    return lines[0]


def assert_dump_ok(path):
    assert os.path.isfile(path), "backup dump missing: %s" % path
    assert os.path.getsize(path) > 0, "backup dump is empty"
    with open(path, "rb") as fh:
        assert fh.read(5) == b"PGDMP", "backup dump does not start with PGDMP"


# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def db(tmp_path_factory):
    env = base_env(tmp_path_factory)
    ensure_pg(env)
    create_db(env)
    alembic_upgrade(env)
    return env


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def test_tool_is_python36_compatible():
    """The tool is 3.6-grammar compatible and uses no 3.7+/3.8+ APIs."""
    with open(TOOL, "r") as fh:
        src = fh.read()
    tree = ast.parse(src, feature_version=(3, 6))  # rejects walrus, pos-only, etc.
    # No f-strings at all (the tool uses %-formatting); also rules out f"{x=}".
    assert not any(isinstance(n, ast.JoinedStr) for n in ast.walk(tree))
    for bad in [
        "from __future__ import annotations",
        "subprocess.run(",
        "capture_output=",
        "text=True",
        "encoding=",
    ]:
        assert bad not in src, "forbidden 3.7+/3.8+ construct present: %s" % bad
    assert ":=" not in src
    assert "subprocess.Popen(" in src
    assert ".communicate(" in src
    assert 'CONFIRM_TOKEN = "DELETE-LEGACY-HUB-ROOMS"' in src


def test_check_mode_is_read_only_and_reports_correct_counts(db):
    env = db
    reset_dataset(env)
    assert room_id_tables(env) == EXPECTED_ROOM_ID_TABLES
    before = fingerprint(env)
    assert rooms_snapshot(env) == {"total": 5, "xmtp": 2, "agent": 1, "legacy": 2}
    assert message_orphans(env) == 0 and room_orphans(env) == 0

    rc, out, err = run_tool(env, "check", "")
    print("\n===== check mode output =====\n" + out)
    assert rc == 0, err
    assert "CHECK OK" in out
    assert "read_only session         : on" in out
    summary = parse_summary(out)
    assert summary["mode"] == "check"
    assert summary["read_only"] is True
    assert summary["rooms_total"] == 5
    assert summary["rooms_xmtp"] == 2
    assert summary["rooms_agent"] == 1
    assert summary["rooms_legacy"] == 2
    assert summary["msgs_in_legacy"] == 3
    assert summary["msgs_parent_ref"] == 1
    assert summary["room_id_tables"] == 11
    assert summary["fk_constraints"] == 12
    # The exact SQL is printed for review, including the no-FK table.
    assert "CREATE TEMP TABLE _legacy_rooms" in out
    assert "BEGIN;" in out and "COMMIT;" in out
    assert 'DELETE FROM "public"."rooms"' in out
    assert 'DELETE FROM "public"."analytics_events"' in out
    assert 'DELETE FROM "public"."messages"' in out
    # Zero writes: every table's row count is unchanged.
    assert fingerprint(env) == before
    assert set(r.strip() for r in run_sql(
        env, "SELECT id FROM public.rooms WHERE left(id,7)='_agent_' OR transport='xmtp' "
             "ORDER BY id;"
    ).splitlines() if r.strip()) == set(PRESERVED_IDS)


def test_backup_mode_writes_dump_and_does_not_delete(db):
    env = db
    reset_dataset(env)
    before = fingerprint(env)
    rc, out, err = run_tool(env, "backup", "")
    print("\n===== backup mode output =====\n" + out)
    assert rc == 0, err
    path = backup_path_from(out)
    assert_dump_ok(path)
    summary = parse_summary(out)
    assert summary["mode"] == "backup"
    assert summary["backup_ok"] is True
    assert summary["deletes"] == 0
    assert summary["dump_bytes"] > 0
    # No deletes: DB unchanged.
    assert fingerprint(env) == before
    assert rooms_snapshot(env) == {"total": 5, "xmtp": 2, "agent": 1, "legacy": 2}


def test_execute_with_wrong_confirm_is_noop(db):
    env = db
    reset_dataset(env)
    before = fingerprint(env)
    bdir = env["MAPR_HYGIENE_BACKUP_DIR"]
    n_before = len(glob.glob(os.path.join(bdir, "legacy-room-backup-*")))
    rc, out, err = run_tool(env, "execute", "WRONG-CONFIRM-STRING")
    print("\n===== execute (wrong confirm) output =====\n" + out)
    assert rc != 0
    assert "ZERO writes" in out or "REFUSING" in out
    summary = parse_summary(out)
    assert summary["aborted"] is True
    assert summary["reason"] == "bad_confirm"
    assert summary["deletes"] == 0
    # Absolutely no DB writes, and not even a backup directory was created.
    assert fingerprint(env) == before
    n_after = len(glob.glob(os.path.join(bdir, "legacy-room-backup-*")))
    assert n_after == n_before


def test_execute_with_correct_confirm_deletes_legacy_only(db):
    env = db
    reset_dataset(env)
    legacy_before = per_table_counts(env, LEGACY_IDS)
    preserved_before = per_table_counts(env, PRESERVED_IDS)
    assert legacy_before["messages"] == 3
    assert all(v == 2 for k, v in legacy_before.items() if k != "messages")
    assert all(v == 3 for v in preserved_before.values())

    rc, out, err = run_tool(env, "execute", CONFIRM_TOKEN)
    print("\n===== execute (correct confirm) output =====\n" + out)
    assert rc == 0, err + "\n" + out
    assert "EXECUTE OK" in out
    assert "BACKUP_PATH " in out
    assert_dump_ok(backup_path_from(out))  # fresh backup was taken first

    summary = parse_summary(out)
    assert summary["mode"] == "execute"
    assert summary["backup_ok"] is True
    assert summary["assertions_ok"] is True
    assert summary["before"]["rooms_legacy"] == 2
    assert summary["after"]["rooms_legacy"] == 0
    assert summary["after"]["rooms_xmtp"] == 2
    assert summary["after"]["rooms_agent"] == 1
    assert summary["after"]["rooms_total"] == 3
    assert summary["after"]["room_orphans"] == 0
    assert summary["after"]["message_orphans"] == 0

    # Room-level invariants.
    assert rooms_snapshot(env) == {"total": 3, "xmtp": 2, "agent": 1, "legacy": 0}
    # _agent_ room (transport='hub', preserved by the _agent_ id prefix) survives.
    assert run_sql(env, "SELECT transport FROM public.rooms WHERE id='_agent_internal';").strip() == "hub"
    # All legacy child rows are gone from every room_id table.
    assert all(v == 0 for v in per_table_counts(env, LEGACY_IDS).values())
    # All preserved rooms' child rows are intact (same counts).
    assert per_table_counts(env, PRESERVED_IDS) == preserved_before
    # No orphan rows remain.
    assert room_orphans(env) == 0
    assert message_orphans(env) == 0
    # Value-level checks: preserved rows were not modified.
    assert run_sql(
        env, "SELECT content || '|' || COALESCE(parent_id,'NULL') "
             "FROM public.messages WHERE id='m-x1-1';"
    ).strip() == "xmtp body 1|NULL"
    assert run_sql(
        env, "SELECT COALESCE(source_message_id,'NULL') "
             "FROM public.a2a_tasks WHERE id='task-x1';"
    ).strip() == "NULL"
    # The legacy task that referenced a legacy message is gone; the legacy
    # self-referencing message is gone; the FK never blocked deletion.
    assert scalar(env, "SELECT count(*) FROM public.a2a_tasks WHERE id='task-l1';") == 0
    assert scalar(env, "SELECT count(*) FROM public.messages WHERE id='m-l1-2';") == 0


if __name__ == "__main__":
    sys.exit(pytest.main([os.path.abspath(__file__), "-v", "-s"]))
