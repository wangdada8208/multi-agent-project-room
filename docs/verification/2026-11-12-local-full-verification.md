# 2026-11-12 — Local full verification (real PostgreSQL 17 + real Redis)

- **Agent:** `local-verification` (teammate of `lead`)
- **Working directory:** `/data/projects/multi-agent-project-room`
- **Date/time of Phase A:** 2026-11-12 08:03–08:07 UTC
- **Write scope used:** this file only (plus scratch logs under `/tmp/mapr-verify-*`). No repo source, tests, workflows or other docs were edited. No git commit/push was performed.
- **Tree state:** other teammates were editing source files concurrently; all Phase A numbers below are a point-in-time snapshot of the working tree as it existed at the times shown. Phase B is intentionally deferred until the TLS-hardening and schema-drift edits are finished.

---

## Environment / versions actually used

| Component | Local value | Note vs CI (`deploy.yml`) |
|---|---|---|
| PostgreSQL | `postgres (PostgreSQL) 17.11 (Debian 17.11-0+deb13u1)` at `/usr/lib/postgresql/17/bin/` | CI service is PostgreSQL 17 on port 5432; here port 55432 |
| Redis | `Redis server v=8.0.2` (`/usr/bin/redis-server`) | CI uses Redis on 6379; here port 56379 |
| Python | `.venv/bin/python` = 3.13.5 | CI step uses `python3`; local deps live in `.venv` |
| Node / npm | `v26.13.0` / `11.20.0` | CI `actions/setup-node@v6` uses Node 22 |
| Vitest | `v5.0.1` | — |
| Vite | `v7.3.5` | — |
| OS user | `user` | `initdb` requires non-root; OK |

## Ports used (isolation)

| Service | Port | Data dir | PID | Socket |
|---|---|---|---|---|
| PostgreSQL 17 | **55432** | `/tmp/mapr-verify-pgdata` | 20878 | `/tmp/.s.PGSQL.55432` |
| Redis | **56379** | `/tmp/mapr-verify-redis` | 21001 | TCP `*:56379` |

Forbidden ports **5432, 55433, 6379 were never used by this agent**.
`ss -ltnp` at 08:07 UTC showed:

```
LISTEN 0      0          127.0.0.1:55433      0.0.0.0:*    users:(("postgres",pid=20925,fd=6))
LISTEN 0      0          127.0.0.1:55432      0.0.0.0:*    users:(("postgres",pid=20878,fd=6))
LISTEN 0      0            0.0.0.0:56379      0.0.0.0:*    users:(("redis-server",pid=21001,fd=8))
```

The `55433` listener is a **separate teammate instance** (`/tmp/mapr-drift-pgdata`, pid 20925, started 08:04:10 UTC), not started or used by this agent. The two clusters have distinct data directories.

---

# Phase A — COMPLETED

## A.1 Start PostgreSQL 17 and Redis; create `agent_room_test`

Commands (exact):

```sh
/usr/lib/postgresql/17/bin/initdb -D /tmp/mapr-verify-pgdata -U postgres --auth=trust
/usr/lib/postgresql/17/bin/pg_ctl -D /tmp/mapr-verify-pgdata -o "-p 55432 -k /tmp" -l /tmp/mapr-verify-pg.log start
/usr/lib/postgresql/17/bin/createdb -h 127.0.0.1 -p 55432 -U postgres agent_room_test
mkdir -p /tmp/mapr-verify-redis
redis-server --port 56379 --dir /tmp/mapr-verify-redis --daemonize yes --save ''
redis-cli -p 56379 ping
```

`initdb` tail (exit 0):

```
The files belonging to this database system will be owned by user "user".
The database cluster will be initialized with locale "C".
The default database encoding has accordingly been set to "SQL_ASCII".
...
Success. You can now start the database server using:
    /usr/lib/postgresql/17/bin/pg_ctl -D /tmp/mapr-verify-pgdata -l logfile start
```

`pg_ctl start` (exit 0): `waiting for server to start.... done` / `server started`.
Excerpt of server log `/tmp/mapr-verify-pg.log` (exact lines):

```
2026-11-12 08:04:05.621 UTC [20878] LOG:  starting PostgreSQL 17.11 (Debian 17.11-0+deb13u1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
2026-11-12 08:04:05.621 UTC [20878] LOG:  listening on IPv4 address "127.0.0.1", port 55432
2026-11-12 08:04:05.621 UTC [20878] LOG:  could not create IPv6 socket for address "::1": Address family not supported by protocol
2026-11-12 08:04:05.621 UTC [20878] LOG:  listening on Unix socket "/tmp/.s.PGSQL.55432"
2026-11-12 08:04:05.624 UTC [20881] LOG:  database system was shut down at 2026-11-12 08:03:55 UTC
2026-11-12 08:04:05.629 UTC [20878] LOG:  database system is ready to accept connections
```

`pg_isready -h 127.0.0.1 -p 55432` → `127.0.0.1:55432 - accepting connections`.
`createdb` exit 0. `psql -lqt` databases: `agent_room_test`, `postgres`, `template0`, `template1`.

`redis-server` exit 0 with the benign warning `WARNING Memory overcommit must be enabled!` (no functional failure).
**`redis-cli -p 56379 ping` → `PONG`.** `INFO server`: `redis_version:8.0.2`, `tcp_port:56379`, `process_id:21001`.

## A.2 Alembic migrations on the test DB

Command (exact):

```sh
MAPR_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55432/agent_room_test PYTHONPATH=backend .venv/bin/python -m alembic upgrade head
```

Exit 0. Full output:

```
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade  -> 4282869a120f, create users and rooms tables
INFO  [alembic.runtime.migration] Running upgrade 4282869a120f -> 4023cb379d15, create messages table
INFO  [alembic.runtime.migration] Running upgrade 4023cb379d15 -> 5a935249719e, create a2a_tasks and agent_card_records tables
INFO  [alembic.runtime.migration] Running upgrade 5a935249719e -> fda1d6ee3e5d, create approvals table
INFO  [alembic.runtime.migration] Running upgrade fda1d6ee3e5d -> 7c2d4f9a1b20, create knowledge docs table
INFO  [alembic.runtime.migration] Running upgrade 7c2d4f9a1b20 -> 9e8f7d6c5b4a, add sender_name to messages
INFO  [alembic.runtime.migration] Running upgrade 9e8f7d6c5b4a -> b4e8c7a92f10, add auth fields and task links
INFO  [alembic.runtime.migration] Running upgrade b4e8c7a92f10 -> c5f9d8e10a21, add ondelete set null to messages foreign keys
INFO  [alembic.runtime.migration] Running upgrade c5f9d8e10a21 -> d7e1a9c04b22, add room transport and xmtp_group_id
INFO  [alembic.runtime.migration] Running upgrade d7e1a9c04b22 -> e8f2b1c93a40, default new room transport to xmtp
INFO  [alembic.runtime.migration] Running upgrade e8f2b1c93a40 -> f9a1c2d3e4b5, create room_invites table
INFO  [alembic.runtime.migration] Running upgrade f9a1c2d3e4b5 -> a10c20261010, Agent ownership and one-time binding; finite additive DDL, no data backfill.
INFO  [alembic.runtime.migration] Running upgrade a10c20261010 -> b20c20261010, A2A task events audit log, context_id and atomic event_seq counter.
INFO  [alembic.runtime.migration] Running upgrade b20c20261010 -> c30c20261010, Persistent WS delivery metadata; no message bodies or backfill.
Revision ID: c30c20261010
Revises: b20c20261010
INFO  [alembic.runtime.migration] Running upgrade c30c20261010 -> d40c20261010, Formal baseline migration for historical ORM tables.
INFO  [alembic.runtime.migration] Running upgrade d40c20261010 -> e50c20261011, Commit-consistent room message counters and per-connection presence leases.
INFO  [alembic.runtime.migration] Running upgrade e50c20261011 -> f60c20261011, Independent SSE lease metadata, shared by all PostgreSQL Hubs.
INFO  [alembic.runtime.migration] Running upgrade f60c20261011 -> g70c20261012, Add is_active column to users table.
INFO  [alembic.runtime.migration] Running upgrade g70c20261012 -> h80c20261015, add normalized_username to users
INFO  [alembic.runtime.migration] Running upgrade h80c20261015 -> i90c20261017, add unique constraint on users.comparison_username (H3)
```

`alembic heads` (exit 0):

```
i90c20261017 (head)
```

`alembic current` (exit 0):

```
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
i90c20261017 (head)
```

DB cross-check: `SELECT * FROM alembic_version;` → `i90c20261017`; `information_schema.tables` in schema `public` → **20 tables**.

## A.3 CI-equivalent "Prove real PostgreSQL and real Redis are wired (no silent skip)"

Workflow source: `.github/workflows/deploy.yml:139-154` (read verbatim). The script body was copied unchanged; only the interpreter (`.venv/bin/python`) and the env were adapted to the isolated ports.

Command (exact):

```sh
MAPR_TESTING=1 \
MAPR_TEST_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55432/agent_room_test \
MAPR_TEST_REDIS_URL=redis://127.0.0.1:56379/15 \
PYTHONPATH=backend \
.venv/bin/python - <<'PY'
import sys
sys.path.insert(0, "backend/tests"); sys.path.insert(0, "backend")
import app.main  # noqa: register all models
import conftest as C
from app.auth import rate_limit
assert C.engine.dialect.name == "postgresql", f"tests would run on {C.engine.dialect.name}, not PostgreSQL"
client = rate_limit._get_redis_sync()
assert client is not None, "Redis is unreachable: rate-limit tests would silently skip"
assert client.ping() is True
url = rate_limit._get_effective_redis_url()
assert url.rstrip("/").endswith("/15"), f"tests must use the dedicated Redis DB, got {url}"
print("OK: PostgreSQL dialect =", C.engine.dialect.name, "| Redis DB =", url)
PY
```

Exit 0. **Exact printed line:**

```
OK: PostgreSQL dialect = postgresql | Redis DB = redis://127.0.0.1:56379/15
```

All four assertions passed: dialect `postgresql`, Redis client exists, `PING` returned `True`, effective URL ends in `/15` (dedicated DB 15). `redis-cli -p 56379 -n 15 dbsize` → `0` (clean, isolated DB).

## A.4 Frontend

Commands (exact):

```sh
cd frontend && npm test -- --run
cd frontend && npm run build
```

`npm test -- --run` exit 0 — full output:

```
> multi-agent-project-room-frontend@0.1.0 test
> vitest run --run

 RUN  v5.0.1 /data/projects/multi-agent-project-room/frontend

 ✓ src/lib/envelopeView.test.ts (6 tests) 7ms
 ✓ src/lib/connectClient.test.ts (4 tests) 13ms
 ✓ src/lib/xmtpSend.test.ts (8 tests) 18ms
 ✓ src/lib/sharedRoom.test.ts (4 tests) 66ms
 ✓ src/lib/requestId.test.ts (5 tests) 69ms
 ✓ src/lib/ownerNotes.test.ts (2 tests) 6ms
 ✓ src/lib/xmtpEnv.test.ts (2 tests) 3ms
 ✓ src/hooks/useWebSocket.test.ts (21 tests) 266ms
 ✓ src/lib/xmtpGroup.test.ts (2 tests) 8ms
 ✓ src/lib/xmtpLocalIdentity.test.ts (10 tests) 78ms

 Test Files  10 passed (10)
      Tests  64 passed (64)
   Start at  08:05:47
   Duration  2.18s (import 59%, transform 30%, tests 9%, worker 1%)
```

**Frontend tests: 10 files passed, 64 tests passed, 0 failed.**

`npm run build` exit 0 — full output:

```
> multi-agent-project-room-frontend@0.1.0 build
> tsc -b && vite build

vite v7.3.5 building client environment for production...
transforming...
✓ 2295 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                                  0.57 kB │ gzip:     0.40 kB
dist/assets/opfs-92QNiyhO.js                    50.53 kB
dist/assets/client-BDki0SnJ.js                  82.06 kB
dist/assets/bindings_wasm_bg-DwF1mzFa.wasm  12,759.23 kB │ gzip: 4,486.35 kB
dist/assets/index-CKf_2q_k.css                  27.87 kB │ gzip:     5.56 kB
dist/assets/index-CN2Huv_H.js                  491.67 kB │ gzip:   152.41 kB
✓ built in 5.31s
```

**Frontend build: success (2295 modules transformed, built in 5.31s).**

## A.5 Member process (`workers/xmtp-member`)

Command (exact):

```sh
cd workers/xmtp-member && npm run typecheck && npm test
```

`npm run typecheck` exit 0, output (complete):

```
> xmtp-member@0.1.0 typecheck
> tsc --noEmit -p . --allowImportingTsExtensions
```

(no diagnostics — TypeScript typecheck clean).

`npm test` exit 0 — summary lines (complete tail):

```
ℹ tests 140
ℹ suites 0
ℹ pass 140
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2030.100565
```

**Member: typecheck clean, 140 tests passed, 0 failed, 0 skipped.**

## A.6 Root-level pytest subset

Command (exact):

```sh
.venv/bin/python -m pytest tests/test_deploy_script.py tests/test_local_agent_adapter.py -q
```

Exit 0 — full output:

```
...........                                                              [100%]
11 passed in 1.32s
```

**11 passed, 0 failed.**

## A.7 Phase A summary

| Check | Result | Exit |
|---|---|---|
| PG17 up on 55432 + `agent_room_test` created | OK | 0 |
| Redis up on 56379 / `PING` → `PONG` | OK | 0 |
| `alembic upgrade head` | OK, head `i90c20261017 (head)`, 20 public tables | 0 |
| `alembic heads` / `alembic current` | both `i90c20261017 (head)` | 0 |
| Real PG/Redis wiring proof (deploy.yml:139-154) | `OK: PostgreSQL dialect = postgresql \| Redis DB = redis://127.0.0.1:56379/15` | 0 |
| Frontend `npm test -- --run` | 10 files / **64 passed** | 0 |
| Frontend `npm run build` | success, 2295 modules, 5.31s | 0 |
| Member `npm run typecheck` | clean | 0 |
| Member `npm test` | **140 passed**, 0 failed | 0 |
| Root pytest subset | **11 passed** in 1.32s | 0 |

**Phase A: all steps completed, no failures, no command was skipped due to a missing binary/dependency.**

### Phase A deviations / caveats (recorded, not hidden)

1. CI steps use `npm ci` and `python3`; local `node_modules` were already present (frontend, member), so `npm ci` was not re-run. Python deps exist only in `.venv`, so `.venv/bin/python` was used instead of `python3`.
2. The CI "Frontend checks" step also runs `node scripts/validate-release-config.mjs`, which requires the repository variables `VITE_XMTP_WORKER_ADDRESS` (a valid non-zero `0x…40hex`) and `VITE_XMTP_ENV` — these are not available locally. It was **not** part of the Phase A instructions and was **not** run; no result is claimed for it.
3. `initdb` was run exactly as instructed (no `--encoding`), so the cluster came up with locale `C` / encoding `SQL_ASCII`. No Phase A step depends on UTF-8 validation. If Phase B shows encoding-related failures, re-init with `--encoding=UTF8 --locale=C.UTF-8` is the remedy (would require re-running migrations).
4. CI runs the full pytest suite with `-v`; Phase B is instructed with `-q`, and Phase A's root subset with `-q`.
5. Node 26.13.0 locally vs CI's Node 22; Redis 8.0.2 vs CI's Redis service; PostgreSQL 17.11 specifically. All are real services, not mocks/skips.

---

# Phase B — PENDING (awaiting `lead`'s go-ahead)

**Do not run until all source edits (TLS hardening + schema-drift fix) are finished and `lead` sends the go-ahead message.**

Planned exact command:

```sh
MAPR_TESTING=1 \
MAPR_TEST_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55432/agent_room_test \
MAPR_TEST_REDIS_URL=redis://127.0.0.1:56379/15 \
PYTHONPATH=backend \
.venv/bin/python -m pytest backend/tests/ tests/test_local_agent_adapter.py tests/test_deploy_script.py -q
```

When Phase B runs, this file will be **appended** (not rewritten) with:
- the exact command and its final summary line (`N passed, M failed, K skipped in …`),
- any failures with their root cause,
- confirmation that the same isolated ports/services were used,
- and a report sent to `lead`.

Status at time of writing: **NOT STARTED — waiting for lead's message.**
