#!/usr/bin/env python3
"""Production legacy hub-room cleanup tool (Python 3.6 compatible).

Run on the self-hosted production host, or against a local PostgreSQL for
verification.  See docs/verification/2026-11-12-prod-legacy-room-cleanup-tool.md.

Deletion scope (docs/superpowers/plans/2026-09-23-delete-legacy-rooms.md Task 3):
    rooms with transport='hub' whose id does NOT start with '_agent_',
    plus every dependent child row.  `_agent_` internal channels and ALL xmtp
    rooms MUST be preserved.

Safety properties:
    * `check` is strictly READ ONLY (session default read-only); zero writes.
    * `execute` requires --confirm DELETE-LEGACY-HUB-ROOMS exactly.
    * `execute` takes a FRESH pg_dump backup first and aborts if it fails.
    * All deletes run in ONE transaction: BEGIN ... COMMIT.
    * Child tables and FK columns are discovered from the catalog, never from
      a hardcoded list, so an unknown child table cannot be missed.
    * No credentials, room ids (masked on errors) or message bodies are printed.

Python 3.6 constraints (production host python3 is 3.6): use only the low-level
Popen(...).communicate() API; no run helper, no assignment expressions, no
debug f-strings, no future-annotations import.
"""
import datetime
import json
import os
import re
import shlex
import subprocess
import sys
from collections import OrderedDict

CONFIRM_TOKEN = "DELETE-LEGACY-HUB-ROOMS"
# Both can be overridden by the dispatch workflow. The host's docker socket is
# often root-only, so the workflow sets MAPR_HYGIENE_DOCKER_CMD="sudo -n docker".
CONTAINER = os.environ.get(
    "MAPR_HYGIENE_PG_CONTAINER", "multi-agent-project-room-postgres-1"
)
PROD_DB = os.environ.get("MAPR_HYGIENE_PG_DB", "agent_room")
PRIMARY_BACKUP_BASE = "/opt/multi-agent-project-room/backups"
PSQL_FLAGS = ["-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t"]

# One canonical definition of "legacy hub room", used by every read/query/delete.
LEGACY = (
    "SELECT \"id\" FROM \"public\".\"rooms\" "
    "WHERE \"transport\" = 'hub' AND left(\"id\", 7) <> '_agent_'"
)

DELTYPE = {
    "a": "NO ACTION",
    "r": "RESTRICT",
    "c": "CASCADE",
    "n": "SET NULL",
    "d": "SET DEFAULT",
}


def deltype_name(code):
    return DELTYPE.get(code, code or "?")


def q(ident):
    """quote_ident semantics: double-quote an SQL identifier."""
    return '"' + str(ident).replace('"', '""') + '"'


def lit(value):
    """Single-quoted SQL string literal."""
    return "'" + str(value).replace("'", "''") + "'"


def qtable(schema, table):
    return q(schema) + "." + q(table)


def mask(value):
    """Mask an identifier so it is never printed in full."""
    value = "" if value is None else str(value)
    if len(value) <= 4:
        return "*" * len(value)
    return value[:2] + "*" * (len(value) - 4) + value[-2:]


def scrub(text):
    """Mask key=(value) details that psql FK/unique errors may embed (room ids)."""
    if not text:
        return ""
    return re.sub(
        r"\(([^()]*)\)=\(([^()]*)\)",
        lambda m: "(" + m.group(1) + ")=(" + mask(m.group(2)) + ")",
        text,
    )


def is_local_mode():
    """True when MAPR_HYGIENE_PSQL_CMD overrides the docker production default."""
    return bool(os.environ.get("MAPR_HYGIENE_PSQL_CMD"))


def docker_cmd():
    """docker executable (possibly wrapped in sudo -n on the production host)."""
    return shlex.split(os.environ.get("MAPR_HYGIENE_DOCKER_CMD", "docker"))


def psql_base():
    env = os.environ.get("MAPR_HYGIENE_PSQL_CMD")
    if env:
        return shlex.split(env)
    return docker_cmd() + ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", PROD_DB]


def run_psql(sql, readonly, label):
    """Run SQL via one psql session.  When readonly, the session begins with
    SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY and is verified 'on'.
    Never echoes the psql command (which may contain a password)."""
    cmd = psql_base() + PSQL_FLAGS
    prefix = ""
    if readonly:
        prefix = (
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;\n"
            "SELECT '__READONLY__', current_setting('transaction_read_only');\n"
        )
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    out, err = proc.communicate((prefix + sql).encode("utf-8"))
    out_text = out.decode("utf-8", "replace")
    err_text = scrub(err.decode("utf-8", "replace"))
    lines = [ln for ln in out_text.splitlines() if ln.strip() != ""]
    if readonly:
        if not lines or not lines[0].startswith("__READONLY__|"):
            raise RuntimeError(
                "readonly session not established [%s]: %s" % (label, err_text[:200])
            )
        marker = lines[0].split("|", 1)[1].strip() if "|" in lines[0] else ""
        if marker != "on":
            raise RuntimeError(
                "session is NOT read-only (transaction_read_only=%s) [%s]"
                % (marker, label)
            )
        lines = lines[1:]
    if proc.returncode != 0:
        raise RuntimeError(
            "psql failed [%s] rc=%d: %s" % (label, proc.returncode, err_text[:400])
        )
    return lines, err_text


# Catalog introspection.  Every dynamic statement is built from these results.
INTROSPECT_SQL = (
    "SELECT 'RT', c.table_schema, c.table_name "
    "FROM information_schema.columns c "
    "JOIN information_schema.tables t ON t.table_schema=c.table_schema "
    "  AND t.table_name=c.table_name AND t.table_type='BASE TABLE' "
    "WHERE c.table_schema='public' AND c.column_name='room_id' "
    "ORDER BY c.table_name;\n"
    "SELECT 'FK', n.nspname, cl.relname, co.conname, pn.nspname, pcl.relname, "
    "  a.attname, af.attname, co.confdeltype "
    "FROM pg_constraint co "
    "JOIN pg_class cl ON cl.oid=co.conrelid "
    "JOIN pg_namespace n ON n.oid=cl.relnamespace "
    "JOIN pg_class pcl ON pcl.oid=co.confrelid "
    "JOIN pg_namespace pn ON pn.oid=pcl.relnamespace "
    "JOIN LATERAL unnest(co.conkey) WITH ORDINALITY AS k(attnum,ord) ON TRUE "
    "JOIN pg_attribute a ON a.attrelid=co.conrelid AND a.attnum=k.attnum "
    "JOIN LATERAL unnest(co.confkey) WITH ORDINALITY AS f(attnum,ord) ON f.ord=k.ord "
    "JOIN pg_attribute af ON af.attrelid=co.confrelid AND af.attnum=f.attnum "
    "WHERE co.contype='f' AND n.nspname='public' AND pn.nspname='public' "
    "ORDER BY cl.relname, co.conname, k.ord;\n"
    "SELECT 'HP', count(*) FROM information_schema.columns "
    "WHERE table_schema='public' AND table_name='messages' AND column_name='parent_id';\n"
)


def order_room_id_tables(cat, nodes):
    """Topologically order room_id tables so a child table (e.g. action_grants,
    which FKs approvals) is deleted BEFORE its parent, satisfying NO ACTION FKs
    between child tables regardless of alphabetical order. Catalog-driven."""
    depends_on = {}
    for n in cat["room_id_tables"]:
        depends_on[n] = set()
    for f in cat["fks"]:
        child, parent = f["child"], f["parent"]
        if child == parent:
            continue  # self-ref handled by UPDATEs, not by delete ordering
        if child in nodes and parent in nodes:
            depends_on[parent].add(child)
    emitted = []
    remaining = set(cat["room_id_tables"])
    while remaining:
        ready = [
            n for n in cat["room_id_tables"]
            if n in remaining and not (depends_on[n] & remaining)
        ]
        if not ready:  # cycle: deterministic fallback
            emitted.extend(sorted(remaining))
            break
        ready = sorted(ready)
        emitted.extend(ready)
        for n in ready:
            remaining.discard(n)
    return emitted


def introspect():
    lines, _ = run_psql(INTROSPECT_SQL, True, "introspect")
    cat = OrderedDict()
    cat["room_id_tables"] = []
    cat["fks"] = []
    cat["has_parent_id"] = False
    for ln in lines:
        p = ln.split("|")
        if p[0] == "RT":
            cat["room_id_tables"].append((p[1], p[2]))
        elif p[0] == "FK":
            cat["fks"].append({
                "child": (p[1], p[2]),
                "child_table": p[2],
                "conname": p[3],
                "parent": (p[4], p[5]),
                "parent_table": p[5],
                "child_col": p[6],
                "parent_col": p[7],
                "deltype": p[8],
            })
        elif p[0] == "HP":
            cat["has_parent_id"] = (int(p[1]) > 0)
    if not cat["room_id_tables"]:
        raise RuntimeError("no public room_id tables found; wrong database?")
    nodes = set(cat["room_id_tables"])
    cat["rooms_messages_fks"] = [
        f for f in cat["fks"] if f["parent_table"] in ("rooms", "messages")
    ]
    cat["message_fks"] = [
        f for f in cat["fks"] if f["parent_table"] == "messages"
    ]
    cat["inter_child_fks"] = [
        f for f in cat["fks"]
        if f["child"] in nodes and f["parent"] in nodes and f["child"] != f["parent"]
    ]
    # Composite FKs to messages are not supported (this schema has none).
    seen = {}
    for f in cat["message_fks"]:
        seen[f["conname"]] = seen.get(f["conname"], 0) + 1
    multi = sorted(k for k, v in seen.items() if v > 1)
    if multi:
        raise RuntimeError(
            "composite FK to messages is not supported: %s" % ", ".join(multi)
        )
    cat["ordered_tables"] = order_room_id_tables(cat, nodes)
    return cat


def build_execute_sql(cat):
    """The exact single transaction used by execute (also printed by check)."""
    stmts = []
    stmts.append("BEGIN;")
    stmts.append(
        "CREATE TEMP TABLE _legacy_rooms AS "
        "SELECT \"id\" FROM \"public\".\"rooms\" "
        "WHERE \"transport\" = 'hub' AND left(\"id\", 7) <> '_agent_';"
    )
    # Abort (ROLLBACK) if there is nothing to do.  ON_ERROR_STOP=1 turns the
    # raised exception into a failed psql call before COMMIT is reached.
    stmts.append(
        "DO $$ BEGIN "
        "IF (SELECT count(*) FROM _legacy_rooms) = 0 THEN "
        "RAISE EXCEPTION 'NO_LEGACY_ROOMS nothing to do; rolling back'; "
        "END IF; END $$;"
    )
    # 1) Null parent_id links to messages in legacy rooms (self-FK on messages).
    if cat["has_parent_id"]:
        m = qtable("public", "messages")
        stmts.append(
            "UPDATE " + m + " SET \"parent_id\" = NULL "
            "WHERE \"parent_id\" IN (SELECT \"id\" FROM " + m +
            " WHERE \"room_id\" IN (SELECT \"id\" FROM _legacy_rooms));"
        )
    legacy_msg_ids = (
        "SELECT \"id\" FROM " + qtable("public", "messages") +
        " WHERE \"room_id\" IN (SELECT \"id\" FROM _legacy_rooms)"
    )
    # 2) For EVERY FK referencing messages, clean the referencing rows BEFORE
    #    messages are deleted. Self-refs on messages are nulled (never deleted);
    #    external children are deleted by their FK column.
    for f in cat["message_fks"]:
        child = qtable(f["child"][0], f["child"][1])
        col = q(f["child_col"])
        if f["child_table"] == "messages":
            if f["child_col"] == "parent_id":
                continue  # explicit UPDATE above
            stmts.append(
                "UPDATE " + child + " SET " + col + " = NULL "
                "WHERE " + col + " IN (" + legacy_msg_ids + ");"
            )
        else:
            # A message may be referenced by a row that lives in a room we
            # MUST preserve (e.g. an _agent_ task). Deleting that row would
            # destroy data outside the approved scope. Honour the FK's ON DELETE
            # action instead: SET NULL / SET DEFAULT rows are nulled or reset,
            # and only hard-dependency (NO ACTION / RESTRICT / CASCADE) rows are
            # deleted. In the production schema a2a_tasks.source_message_id is
            # ON DELETE SET NULL, so those rows survive with a NULL reference.
            if f["deltype"] == "n":
                stmts.append(
                    "UPDATE " + child + " SET " + col + " = NULL "
                    "WHERE " + col + " IN (" + legacy_msg_ids + ");"
                )
            elif f["deltype"] == "d":
                stmts.append(
                    "UPDATE " + child + " SET " + col + " = DEFAULT "
                    "WHERE " + col + " IN (" + legacy_msg_ids + ");"
                )
            else:
                stmts.append(
                    "DELETE FROM " + child + " WHERE " + col + " IN (" +
                    legacy_msg_ids + ");"
                )
    # 3) Every public room_id table (messages included), topologically ordered.
    for schema, table in cat["ordered_tables"]:
        stmts.append(
            "DELETE FROM " + qtable(schema, table) +
            " WHERE \"room_id\" IN (SELECT \"id\" FROM _legacy_rooms);"
        )
    # 4) Delete the rooms last.
    stmts.append(
        "DELETE FROM " + qtable("public", "rooms") +
        " WHERE \"id\" IN (SELECT \"id\" FROM _legacy_rooms);"
    )
    stmts.append("COMMIT;")
    return "\n".join(stmts) + "\n"


def snapshot(cat):
    """Read-only counts used by check (report) and execute (before/after)."""
    sql = []
    r = qtable("public", "rooms")
    m = qtable("public", "messages")
    sql.append("SELECT 'R', 'total', count(*) FROM " + r + ";")
    sql.append("SELECT 'R', 'xmtp', count(*) FROM " + r + " WHERE \"transport\"='xmtp';")
    sql.append("SELECT 'R', 'agent', count(*) FROM " + r + " WHERE left(\"id\",7)='_agent_';")
    sql.append(
        "SELECT 'R', 'legacy', count(*) FROM " + r +
        " WHERE \"transport\"='hub' AND left(\"id\",7) <> '_agent_';"
    )
    for schema, table in cat["room_id_tables"]:
        sql.append(
            "SELECT 'C', " + lit(table) + ", count(*) FROM " + qtable(schema, table) +
            " WHERE \"room_id\" IN (" + LEGACY + ");"
        )
    sql.append(
        "SELECT 'M', 'in_legacy', count(*) FROM " + m +
        " WHERE \"room_id\" IN (" + LEGACY + ");"
    )
    if cat["has_parent_id"]:
        sql.append(
            "SELECT 'M', 'parent_ref', count(*) FROM " + m +
            " WHERE \"parent_id\" IN (SELECT \"id\" FROM " + m +
            " WHERE \"room_id\" IN (" + LEGACY + "));"
        )
    rooms_ids = "SELECT \"id\" FROM " + r
    for schema, table in cat["room_id_tables"]:
        sql.append(
            "SELECT 'RO', " + lit(table) + ", count(*) FROM " + qtable(schema, table) +
            " WHERE \"room_id\" IS NOT NULL AND \"room_id\" NOT IN (" + rooms_ids + ");"
        )
    msgs_ids = "SELECT \"id\" FROM " + m
    for f in cat["message_fks"]:
        sql.append(
            "SELECT 'MO', " + lit(f["child_table"] + "." + f["child_col"]) +
            ", count(*) FROM " + qtable(f["child"][0], f["child"][1]) +
            " WHERE " + q(f["child_col"]) + " IS NOT NULL AND " + q(f["child_col"]) +
            " NOT IN (" + msgs_ids + ");"
        )
    lines, _ = run_psql("\n".join(sql) + "\n", True, "snapshot")
    snap = OrderedDict()
    snap["rooms_total"] = 0
    snap["rooms_xmtp"] = 0
    snap["rooms_agent"] = 0
    snap["rooms_legacy"] = 0
    snap["msgs_in_legacy"] = 0
    snap["msgs_parent_ref"] = 0
    snap["legacy_child_counts"] = OrderedDict()
    snap["room_orphans"] = 0
    snap["message_orphans"] = 0
    for ln in lines:
        p = ln.split("|")
        t = p[0]
        if t == "R":
            snap["rooms_" + p[1]] = int(p[2])
        elif t == "C":
            snap["legacy_child_counts"][p[1]] = int(p[2])
        elif t == "M":
            snap["msgs_" + p[1]] = int(p[2])
        elif t == "RO":
            snap["room_orphans"] += int(p[2])
        elif t == "MO":
            snap["message_orphans"] += int(p[2])
    return snap


def counts_dict(snap):
    return OrderedDict([
        ("rooms_total", snap["rooms_total"]),
        ("rooms_xmtp", snap["rooms_xmtp"]),
        ("rooms_agent", snap["rooms_agent"]),
        ("rooms_legacy", snap["rooms_legacy"]),
        ("msgs_in_legacy", snap["msgs_in_legacy"]),
        ("room_orphans", snap["room_orphans"]),
        ("message_orphans", snap["message_orphans"]),
    ])


def print_json(obj):
    # Final machine-readable line: counts/booleans only, never ids or content.
    print("JSON_SUMMARY " + json.dumps(obj, separators=(",", ":")))


def banner(title):
    print("=" * 72)
    print("prod_legacy_rooms_cleanup - %s" % title)
    print("=" * 72)


def mode_label():
    return "local/test (MAPR_HYGIENE_PSQL_CMD set)" if is_local_mode() \
        else "docker exec (production default)"


def mode_check():
    cat = introspect()
    snap = snapshot(cat)
    banner("CHECK (READ ONLY, zero writes)")
    print("psql mode                 : %s" % mode_label())
    print("read_only session         : on")
    print("public tables with room_id: %d" % len(cat["room_id_tables"]))
    print()
    print("Room counts:")
    print("  total rooms             : %d" % snap["rooms_total"])
    print("  xmtp rooms              : %d" % snap["rooms_xmtp"])
    print("  _agent_ rooms           : %d" % snap["rooms_agent"])
    print("  legacy hub rooms        : %d  (DELETE TARGET)" % snap["rooms_legacy"])
    print()
    print("Rows whose room_id belongs to a legacy hub room (per public table):")
    for t in sorted(snap["legacy_child_counts"]):
        print("  %-30s %d" % (t, snap["legacy_child_counts"][t]))
    print()
    print("messages in legacy rooms                 : %d" % snap["msgs_in_legacy"])
    print("messages referencing them via parent_id   : %d" % snap["msgs_parent_ref"])
    print()
    print("FK constraints referencing rooms or messages (dependency graph):")
    for f in cat["rooms_messages_fks"]:
        print("  %s.%s -> %s.%s  [%s, on delete %s]" % (
            f["child_table"], f["child_col"], f["parent_table"], f["parent_col"],
            f["conname"], deltype_name(f["deltype"])))
    print()
    print("Inter-child FKs used to order DELETEs (both endpoints are room_id tables):")
    if cat["inter_child_fks"]:
        for f in cat["inter_child_fks"]:
            print("  %s.%s -> %s.%s  [%s, on delete %s]" % (
                f["child_table"], f["child_col"], f["parent_table"], f["parent_col"],
                f["conname"], deltype_name(f["deltype"])))
    else:
        print("  (none)")
    print()
    print("Exact SQL execute mode would run:")
    print(build_execute_sql(cat))
    print("CHECK OK - session was READ ONLY, nothing modified.")
    print_json(OrderedDict([
        ("mode", "check"),
        ("read_only", True),
        ("rooms_total", snap["rooms_total"]),
        ("rooms_xmtp", snap["rooms_xmtp"]),
        ("rooms_agent", snap["rooms_agent"]),
        ("rooms_legacy", snap["rooms_legacy"]),
        ("msgs_in_legacy", snap["msgs_in_legacy"]),
        ("msgs_parent_ref", snap["msgs_parent_ref"]),
        ("room_id_tables", len(cat["room_id_tables"])),
        ("fk_constraints", len(cat["rooms_messages_fks"])),
    ]))
    return 0


def _run_quiet(cmd):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    proc.communicate()
    return proc.returncode


def _ensure_dir(path):
    if not os.path.isdir(path):
        os.makedirs(path)


def _sudo_prepare(base):
    uid = str(os.getuid())
    gid = str(os.getgid())
    if _run_quiet(["sudo", "-n", "mkdir", "-p", base]) != 0:
        return False
    if _run_quiet(["sudo", "-n", "chown", uid + ":" + gid, base]) != 0:
        return False
    return os.path.isdir(base) and os.access(base, os.W_OK)


def backup_dir(ts):
    """Timestamped dir. Production: /opt/.../backups (sudo -n if needed, else
    $GITHUB_WORKSPACE fallback). MAPR_HYGIENE_BACKUP_DIR is an explicit override
    used by local verification so tests never need root or touch /opt."""
    override = os.environ.get("MAPR_HYGIENE_BACKUP_DIR")
    if override:
        _ensure_dir(override)
        target = os.path.join(override, "legacy-room-backup-" + ts)
        _ensure_dir(target)
        return target
    base = PRIMARY_BACKUP_BASE
    if not (os.path.isdir(base) and os.access(base, os.W_OK)):
        if not _sudo_prepare(base):
            gw = os.environ.get("GITHUB_WORKSPACE") or "/tmp"
            target = os.path.join(gw, "legacy-room-backup-" + ts)
            _ensure_dir(target)
            return target
    target = os.path.join(base, "legacy-room-backup-" + ts)
    _ensure_dir(target)
    return target


def pg_dump_cmd():
    if not is_local_mode():
        return docker_cmd() + ["exec", "-i", CONTAINER, "pg_dump",
                               "-U", "postgres", "-d", PROD_DB, "-Fc"]
    base = psql_base()
    args = ["pg_dump"]
    i = 0
    n = len(base)
    while i < n:
        tok = base[i]
        if tok in ("-h", "--host", "-p", "--port", "-U", "--username",
                   "-d", "--dbname") and i + 1 < n:
            args.append(tok)
            args.append(base[i + 1])
            i += 2
            continue
        i += 1
    args.append("-Fc")
    return args


def take_backup():
    ts = datetime.datetime.now().strftime("%Y%m%dT%H%M%S%f")
    target = backup_dir(ts)
    dump_path = os.path.join(target, "database.dump")
    proc = subprocess.Popen(
        pg_dump_cmd(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    out, err = proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError("pg_dump rc=%d: %s" % (
            proc.returncode, scrub(err.decode("utf-8", "replace"))[:300]))
    with open(dump_path, "wb") as fh:
        fh.write(out)
    with open(dump_path, "rb") as fh:
        head = fh.read(5)
    size = os.path.getsize(dump_path)
    if size <= 0 or head != b"PGDMP":
        raise RuntimeError(
            "backup dump is empty or not custom format (head=%r size=%d)" % (head, size)
        )
    return dump_path


def mode_backup():
    banner("BACKUP (no deletes)")
    print("psql mode                 : %s" % mode_label())
    path = take_backup()
    size = os.path.getsize(path)
    print("BACKUP_PATH " + path)
    print("backup dump bytes         : %d" % size)
    print("verified                  : non-empty and starts with PGDMP")
    print("No deletes performed.")
    print_json(OrderedDict([
        ("mode", "backup"),
        ("backup_ok", True),
        ("dump_bytes", size),
        ("deletes", 0),
    ]))
    return 0


def assert_invariants(before, after, cat):
    problems = []
    if after["rooms_legacy"] != 0:
        problems.append("legacy hub rooms remain: %d" % after["rooms_legacy"])
    if after["rooms_xmtp"] != before["rooms_xmtp"]:
        problems.append("xmtp room count changed %d -> %d" % (
            before["rooms_xmtp"], after["rooms_xmtp"]))
    if after["rooms_agent"] != before["rooms_agent"]:
        problems.append("_agent_ room count changed %d -> %d" % (
            before["rooms_agent"], after["rooms_agent"]))
    expected_total = before["rooms_total"] - before["rooms_legacy"]
    if after["rooms_total"] != expected_total:
        problems.append("unexpected total rooms: expected %d got %d" % (
            expected_total, after["rooms_total"]))
    for t in sorted(after["legacy_child_counts"]):
        if after["legacy_child_counts"][t] != 0:
            problems.append("legacy child rows remain in %s: %d" % (
                t, after["legacy_child_counts"][t]))
    if after["room_orphans"] != before["room_orphans"]:
        problems.append("room_id orphans increased %d -> %d" % (
            before["room_orphans"], after["room_orphans"]))
    if after["message_orphans"] != before["message_orphans"]:
        problems.append("message-FK orphans increased %d -> %d" % (
            before["message_orphans"], after["message_orphans"]))
    return problems


def print_before_after(before, after):
    print("Before / After counts:")
    keys = [
        ("rooms_total", "total rooms"),
        ("rooms_xmtp", "xmtp rooms"),
        ("rooms_agent", "_agent_ rooms"),
        ("rooms_legacy", "legacy hub rooms"),
        ("msgs_in_legacy", "messages in legacy rooms"),
        ("room_orphans", "room_id orphans"),
        ("message_orphans", "message-FK orphans"),
    ]
    for k, label in keys:
        print("  %-30s %6d -> %6d" % (label, before.get(k, 0), after.get(k, 0)))
    print()
    print("Per-room_id-table rows in legacy rooms (before -> after):")
    for t in sorted(before["legacy_child_counts"]):
        print("  %-30s %6d -> %6d" % (
            t, before["legacy_child_counts"][t], after["legacy_child_counts"].get(t, 0)))


def mode_execute(confirm):
    if confirm != CONFIRM_TOKEN:
        print("REFUSING execute: --confirm did not match the required exact string.")
        print("Aborting with ZERO writes (no backup, no DB connection, no deletes).")
        print_json(OrderedDict([
            ("mode", "execute"),
            ("aborted", True),
            ("reason", "bad_confirm"),
            ("deletes", 0),
        ]))
        return 2
    banner("EXECUTE")
    print("psql mode                 : %s" % mode_label())
    cat = introspect()
    before = snapshot(cat)
    if before["rooms_legacy"] == 0:
        print("Nothing to do: 0 legacy hub rooms. "
              "Aborting with ZERO writes (no backup, no transaction).")
        print_json(OrderedDict([
            ("mode", "execute"), ("nothing_to_do", True), ("deletes", 0),
        ]))
        return 0
    print("Taking a FRESH pg_dump backup BEFORE any deletes ...")
    try:
        backup_path = take_backup()
    except Exception as exc:
        print("BACKUP FAILED: %s" % scrub(str(exc))[:300])
        print("Aborting execute BEFORE any deletes.")
        print_json(OrderedDict([
            ("mode", "execute"), ("aborted", True),
            ("reason", "backup_failed"), ("deletes", 0),
        ]))
        return 4
    print("BACKUP_PATH " + backup_path)
    print("backup verified: non-empty, starts with PGDMP")
    print()
    print("Running ONE transaction (BEGIN ... COMMIT) ...")
    sql = build_execute_sql(cat)
    try:
        run_psql(sql, False, "execute")
    except RuntimeError as exc:
        if "NO_LEGACY_ROOMS" in str(exc):
            print("Transaction guard fired (temp table empty) -> ROLLBACK, zero writes.")
            print_json(OrderedDict([
                ("mode", "execute"), ("nothing_to_do", True), ("deletes", 0),
            ]))
            return 0
        print("TRANSACTION FAILED: %s" % scrub(str(exc))[:400])
        print("Transaction rolled back (BEGIN ... COMMIT not completed).")
        print_json(OrderedDict([
            ("mode", "execute"), ("aborted", True),
            ("reason", "transaction_failed"), ("deletes", 0),
        ]))
        return 5
    after = snapshot(cat)
    print()
    print_before_after(before, after)
    print()
    problems = assert_invariants(before, after, cat)
    if problems:
        print("ASSERTION FAILURES:")
        for p in problems:
            print("  - " + p)
        print("EXECUTE FAILED - invariant violated (backup retained above).")
        print_json(OrderedDict([
            ("mode", "execute"), ("backup_ok", True), ("assertions_ok", False),
            ("before", counts_dict(before)), ("after", counts_dict(after)),
            ("problems", len(problems)),
        ]))
        return 3
    print("EXECUTE OK - legacy hub rooms deleted; _agent_ and xmtp rooms preserved;")
    print("             no orphan rows; single transaction committed.")
    print_json(OrderedDict([
        ("mode", "execute"), ("backup_ok", True), ("assertions_ok", True),
        ("before", counts_dict(before)), ("after", counts_dict(after)),
    ]))
    return 0


def main(argv):
    mode = None
    confirm = ""
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--mode" and i + 1 < len(argv):
            mode = argv[i + 1]
            i += 2
            continue
        if a == "--confirm" and i + 1 < len(argv):
            confirm = argv[i + 1]
            i += 2
            continue
        if a.startswith("--mode="):
            mode = a.split("=", 1)[1]
            i += 1
            continue
        if a.startswith("--confirm="):
            confirm = a.split("=", 1)[1]
            i += 1
            continue
        i += 1
    if mode not in ("check", "backup", "execute"):
        print("ERROR: --mode must be one of check|backup|execute")
        return 64
    if mode == "check":
        return mode_check()
    if mode == "backup":
        return mode_backup()
    return mode_execute(confirm)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:
        sys.stderr.write("FATAL: %s: %s\n" % (
            type(exc).__name__, scrub(str(exc))[:400]))
        if os.environ.get("MAPR_HYGIENE_DEBUG"):
            raise
        sys.exit(1)
