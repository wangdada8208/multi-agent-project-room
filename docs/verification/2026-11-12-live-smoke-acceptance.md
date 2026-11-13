# Live Smoke Acceptance Evidence — 2026-11-12

- **Date / time (UTC):** 2026-11-12 08:18–08:29 (server `date:` header `Thu, 12 Nov 2026 08:18:07 GMT`)
- **Tester:** teammate `smoke-acceptance` (automated HTTP/WebSocket driver)
- **Environment:** local only — `http://127.0.0.1:58000`, temporary SQLite DB `/tmp/mapr-smoke-31722.db`, `MAPR_ENVIRONMENT=test`, `PYTHONPATH=backend`, `.venv/bin/python` (Python 3.13)
- **Scope of this run:** convert `ACCEPTANCE_CHECKLIST.md` "Needs manual pass" items into real, dated, locally-executed evidence.
- **Explicit constraints honoured:** no commit / push; **no production contact** (`https://hub.wangdada8208.xyz` was never called); no edits to repo source, tests, workflows or other docs — the only repo file created is this one; no use of ports 55432 / 55433 / 55434 / 5432 / 6379 by the test harness; only port **58000** and `/tmp` scratch files were used.

## 1. Startup (exact commands)

Primary run A — this is the requested command, with `<pid>` resolved to the launching shell PID `31722` (uvicorn PID `31723`):

```bash
MAPR_DATABASE_URL=sqlite+aiosqlite:////tmp/mapr-smoke-31722.db MAPR_ENVIRONMENT=test PYTHONPATH=backend .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 58000 --log-level warning
```

Actual background invocation used (env assignments are applied to `nohup`, which forwards them to python):

```bash
DBNAME="mapr-smoke-$$.db"          # -> mapr-smoke-31722.db
MAPR_DATABASE_URL="sqlite+aiosqlite:////tmp/$DBNAME" MAPR_ENVIRONMENT=test PYTHONPATH=backend nohup .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 58000 --log-level warning > /tmp/mapr-smoke-uvicorn.log 2>&1 &
echo $! > /tmp/mapr-smoke-uvicorn.pid
```

Readiness wait: `curl -fsS http://127.0.0.1:58000/health` succeeded on the 3rd one-second retry.

- **SQLite was accepted without any fallback.** `MAPR_TESTING=1` was **not needed** (a separate probe confirmed it is accepted as an extra env var and ignored by `pydantic-settings`). No migration was run: `init_db()` uses `Base.metadata.create_all` on the SQLite / test path.
- Startup log (whole file, `/tmp/mapr-smoke-uvicorn.log`):
  ```
  rate limiter Redis circuit breaker: closed -> open (Redis unavailable, using in-process fallback)
  ```
  No Redis service was consumed; the app's own default probe failed and it fell back in-process.

Supplementary run B (repository module only), after stopping run A. Same SQLite DB, one extra documented env var so the repository panel has a real git repo at `/tmp/<room_id>`:

```bash
nohup env MAPR_DATABASE_URL=sqlite+aiosqlite:////tmp/mapr-smoke-31722.db MAPR_ENVIRONMENT=test MAPR_REPOSITORY_ROOT=/tmp PYTHONPATH=backend .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 58000 --log-level warning > /tmp/mapr-smoke-uvicorn-runB.log 2>&1 &
```

`/health` succeeded on the 3rd retry again. Run B reused the **same DB**, so data created in run A was still present (see §5, run C).

## 2. Driver

Single throwaway driver: `/tmp/mapr-smoke-driver.py` (httpx + websockets from `.venv/bin/python`), plus two small throwaway helpers `/tmp/mapr-smoke-repo-driver.py` and `/tmp/mapr-smoke-durability.py`. Full raw outputs: `/tmp/mapr-smoke-run1.txt`, `/tmp/mapr-smoke-runB.txt`, `/tmp/mapr-smoke-runC.txt`, `/tmp/mapr-smoke-output.txt`, `/tmp/mapr-smoke-results.json`. Every printed body passes through a redactor that masks `access_token`, `token_type`, `Authorization`, passwords and enrollment keys — **no token or password is printed or stored in this document**.

Driver summary line:

```
=== SUMMARY: 46 PASS / 0 FAIL out of 46 checks ===
```

Run B: `7 PASS / 1 FAIL`. Run C: `5 PASS / 0 FAIL`.

## 3. Exact live outputs (trimmed, no secrets)

### Health / readiness / discovery

```
[PASS] GET /health :: status=200 body={"status":"ok","service":"Multi-Agent Project Room"}
[PASS] GET /ready :: status=200 body={"status":"ready","service":"Multi-Agent Project Room","database":"connected","revision":"i90c20261017"}
[PASS] GET /openapi.json :: status=200 documented_paths=55
```

Honesty note on `/ready`: on SQLite, `check_database_readiness()` cannot find an `alembic_version` table and substitutes the constant `EXPECTED_ALEMBIC_HEAD = "i90c20261017"`. The 200 is real and live, but it is **not** proof that a real Alembic migration head exists in this scratch DB.

### Auth (two human users)

```
[PASS] POST /api/v1/auth/register (alice) :: status=200 body={"user":{"id":"fcdcf723-...","username":"smoke_alice_0c6fdbdb","display_name":"Smoke Alice","user_type":"human",...},"access_token":"[REDACTED]","token_type":"[REDACTED]"}
[PASS] POST /api/v1/auth/login (alice) :: status=200 body={... "access_token":"[REDACTED]" ...}
[PASS] POST /api/v1/auth/register (bob) :: status=200 ...
[PASS] POST /api/v1/auth/login (bob) :: status=200 ...
[PASS] GET /api/v1/auth/me WITH token :: status=200 body={"user":{"id":"fcdcf723-...","username":"smoke_alice_0c6fdbdb",...}}
[PASS] GET /api/v1/auth/me WITHOUT token :: status=401 body={"detail":"Authentication required"}
```

### Rooms / transport policy

```
[PASS] POST /api/v1/rooms (create) :: status=200 body={"room":{"id":"4f9702e8-47f8-4e2a-acad-50c551b67266","name":"LiveSmoke-0c6fdbdb","transport":"xmtp","xmtp_group_id":null,...}}
[PASS] created room transport is xmtp :: room_id=4f9702e8-... transport=xmtp xmtp_group_id=None
[PASS] POST /api/v1/rooms transport=hub rejected (xmtp-only) :: status=422 body={"detail":[{"type":"literal_error","loc":["body","transport"],"msg":"Input should be 'xmtp'","input":"hub","ctx":{"expected":"'xmtp'"}}]}
[PASS] GET /api/v1/rooms (list) :: status=200 room_count=1 contains_created=True
[PASS] POST /api/v1/rooms/{id}/invite (2nd human) :: status=200 body={"permission":{...,"role":"member",...}}
[PASS] GET /api/v1/rooms/{id}/permissions :: status=200 members=2 ...
```

The API only accepts `transport="xmtp"` — expected per `decisions.md` §"2026-09-23 删除用户可见的历史明文房间" item 2 and enforced by `CreateRoomRequest.transport: Literal["xmtp"]`.

### WebSocket (`/ws/chat/{room_id}?token=...`)

Two authenticated sockets, `identify` + `ping` frames sent:

```
[PASS] WS /ws/chat/{room_id} with token (client 1) :: url=ws://127.0.0.1:58000/ws/chat/4f9702e8-...?token=<REDACTED len=147> frame_types=['system','system','pong','room_updated','presence_snapshot','presence_snapshot']
[PASS] WS /ws/chat/{room_id} with token (client 2) :: frame_types=['system','room_updated','presence_snapshot']
[PASS] WS presence_snapshot reports 2 online humans :: presence_snapshot_frames=3 max_participants=2 sample={"type":"presence_snapshot","participants":[{"sender_id":"fcdcf723-...","sender_name":"Smoke Alice","sender_type":"human",...}],"online_count":1,...}
[PASS] WS ping -> pong :: pong_in_client1=True pong_in_client2=False
[PASS] WS WITHOUT token rejected :: rejected with InvalidStatus: server rejected WebSocket connection: HTTP 403
```

### Approval flow (HTTP + live WebSocket updates)

```
[PASS] POST /api/v1/rooms/{id}/approvals (create #1) :: status=200 ..."status":"pending"...
[PASS] GET /api/v1/rooms/{id}/approvals?status=pending :: status=200 pending_count=1 ...
[PASS] POST /api/v1/approvals/{id}/approve (approve #1) :: status=200 ..."status":"approved"...
[PASS] POST /api/v1/rooms/{id}/approvals (create #2) :: status=200 ..."status":"pending"...
[PASS] POST /api/v1/approvals/{id}/approve (reject #2 via decision=rejected) :: status=200 ..."status":"rejected"...
[PASS] GET /api/v1/rooms/{id}/approvals (observe both decisions) :: status=200 statuses={'811cacbe-...':'rejected','51f976e4-...':'approved'}
[PASS] WS approval_update events observed live :: approval_update_frames=4 statuses_seen=['approved','pending','rejected']
```

Note: there is no separate "reject" endpoint; rejection is `POST /api/v1/approvals/{id}/approve` with `{"decision":"rejected"}` (`approval/routes.py` `DecideRequest`).

### Knowledge module (unique keyword `ZQX0c6fdbdbLIVEKEY`)

```
[PASS] POST /api/v1/rooms/{id}/docs (create Markdown doc) :: status=200 body={"doc":{"id":"a1b651dc-...","content":"# Live Smoke\n\nUnique marker: ZQX0c6fdbdbLIVEKEY\n\nMarkdown **rendering** check.\n",...}}
[PASS] GET /api/v1/rooms/{id}/docs (list) :: status=200 doc_count=1 contains_created=True
[PASS] GET /api/v1/rooms/{id}/docs/{doc_id} (read Markdown) :: status=200 unique_keyword_present=True ...
[PASS] GET /api/v1/rooms/{id}/docs/search?q=<unique keyword> :: status=200 keyword=ZQX0c6fdbdbLIVEKEY hits=1 body={"results":[{"id":"a1b651dc-...","title":"Live Smoke Doc 0c6fdbdb","snippet":"# Live Smoke\n\nUnique marker: ZQX0c6fdbdbLIVEKEY...","updated_at":"..."}]}
```

Note: the API accepts a Markdown document as JSON (`CreateDocRequest.title/content`), not a multipart file upload. "Refresh page and confirm the document remains" was verified at the API level after a full server restart (run C), not in a browser.

### Repository module

Run A (default `repository_root=/data/repos`, no repo attached):

```
[PASS] GET /api/v1/rooms/{id}/git/status (default repository_root=/data/repos) :: status=404 body={"detail":"No repository attached to this room"}
[PASS] GET /api/v1/rooms/{id}/git/branch :: status=404 body={"detail":"No repository attached to this room"}
[PASS] GET /api/v1/rooms/{id}/git/log :: status=404 body={"detail":"No repository attached to this room"}
[PASS] GET /api/v1/rooms/{id}/git/diff :: status=404 body={"detail":"No repository attached to this room"}
```

Run B (real scratch repo `/tmp/4f9702e8-.../.git`, initial branch `master`, commit `236e09f`, one harmless local edit to `SMOKE.md`):

```
[setup] scratch repo=/tmp/4f9702e8-... baseline_commit=236e09f branch=master
[PASS] GET /api/v1/rooms/{id}/git/status (real repo) :: status=200 fields=['branch','changes','last_commit'] body={"branch":"master","changes":[{"path":"MOKE.md","status":"M"}],"last_commit":{"hash":"236e09fc85652f4d860968e8ae41ef59b36c62dd","short_hash":"236e09f","author":"Smoke Test","email":"smoke@local.invalid","date":"2026-11-12T08:25:24Z","message":"smoke: baseline commit for repository panel"}}
[PASS] GET /api/v1/rooms/{id}/git/branch (real repo) :: status=200 fields=['branch'] body={"branch":"master"}
[PASS] GET /api/v1/rooms/{id}/git/log (real repo) :: status=200 fields=['commits'] body={"commits":[{"hash":"236e09f...","short_hash":"236e09f","author":"Smoke Test","email":"smoke@local.invalid","date":"2026-11-12T08:25:24Z","message":"smoke: baseline commit for repository panel"}]}
[PASS] GET /api/v1/rooms/{id}/git/diff (real repo) :: status=200 fields=['files','patch'] body={"files":[{"status":"M","path":"SMOKE.md"}],"patch":"SMOKE.md | 2 ++\n 1 file changed, 2 insertions(+)"}
[FAIL] git/status shows the harmless local change :: changes=['MOKE.md'] ...
[PASS] git/diff shows the harmless local change :: files=[{'status':'M','path':'SMOKE.md'}] ...
[PASS] git/status clean after reverting harmless change :: status=200 changes=[] branch=master
```

**Defect found (exact error, reported to lead):** `GET /git/status` returns the changed file as `"MOKE.md"` instead of `"SMOKE.md"`. Reproduced independently:

```
$ git -C /tmp/4f9702e8-... status --short | cat -A
 M SMOKE.md$
$ .venv/bin/python -c "from pathlib import Path; from app.repository.service import GitService; print(GitService(Path('/tmp/4f9702e8-...')).changes())"
changes() = [{'path': 'MOKE.md', 'status': 'M'}]
```

Root cause (read-only diagnosis, **no source edited**): `GitService._git()` in `backend/app/repository/service.py:24` applies `.strip()` to stdout, removing the leading space of `" M SMOKE.md"`; `GitService.changes()` at `backend/app/repository/service.py:59` then slices `line[3:]`, chopping the `S`. `/git/diff` is unaffected. This is the only FAIL assertion in the whole exercise.

### A2A

```
[PASS] GET /.well-known/agent-card.json :: status=200 keys=['capabilities','defaultInputModes','defaultOutputModes','description','name','securityRequirements','securitySchemes','skills','supportedInterfaces','version'] body={"name":"Multi-Agent Room Hub","version":"2.0.0","supportedInterfaces":[{"url":"http://localhost:8000/a2a/rpc","protocolBinding":"JSONRPC","protocolVersion":"1.0"},...],"capabilities":{"streaming":true,"pushNotifications":false},...}
[PASS] POST /a2a/rpc method=tasks/send (legacy tasks/send-style RPC) :: status=200 body={"error":{"code":-32601,"message":"Method not found"},"id":"smoke-1","jsonrpc":"2.0"}
[PASS] POST /a2a/rpc method=SendMessage (A2A v1 send) :: status=200 body={"error":{"code":-32602,"message":"Encrypted room plaintext is not accepted"},"id":"smoke-2","jsonrpc":"2.0"}
[PASS] GET /api/v1/rooms/{id}/tasks (task routing/list pipeline) :: status=200 body={"tasks":[]}
[PASS] POST /a2a/dialogue-rpc method=agent/list :: status=200 body={"jsonrpc":"2.0","result":{"agents":[]},"id":"d1"}
[PASS] POST /a2a/dialogue-rpc method=dialogues/create (control plane reachable) :: status=200 body={"jsonrpc":"2.0","result":{"dialogue_id":"623d3687-...","participants":["hub","claude","codex"],"status":"active","max_turns":8,...},"id":"d2"}
[PASS] POST /a2a/dialogue-rpc method=dialogues/status :: status=200 ..."status":"active"...
```

`tasks/send` is not an exposed method on this A2A v1 server; the allowed JSON-RPC methods are `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `SubscribeToTask`, `ListTasks` (`backend/app/a2a/http_protocol.py:784`). The `SendMessage` refusal (`-32602 Encrypted room plaintext is not accepted`) is **expected**: `check_send()` rejects plaintext task sends into `transport="xmtp"` rooms (`http_protocol.py:235`). `decisions.md:66` moves `@`-wakeup and turn scheduling into the XMTP member process.

The relay dialogue **control plane** is reachable and returns real dialogue objects, but `agent/list` returned `{"agents":[]}` — no Claude/Codex adapter was started. **A full 30-second multi-agent dialogue is NOT COVERED.**

### Chat persistence (xmtp room)

```
[PASS] WS send message in xmtp room -> body_not_on_hub :: frame_types=['error'] error_codes=['body_not_on_hub']
[PASS] GET /api/v1/rooms/{id}/messages (Hub history for xmtp room) :: status=200 body={"messages":[],"next_cursor":0,"has_more":false,"retention_days":15}
[PASS] GET /api/v1/rooms/{id}/messages/search?q=<sent marker> :: status=200 body={"results":[],"reason":"body_not_on_hub","query":"LIVEPERSIST-0c6fdbdb","total":0}
[PASS] GET /api/v1/agents (presence panel backing API) :: status=200 body={"agents":[]}
```

Hub correctly has **no** chat body. Not a failure: by design (`decisions.md:64`), verified by `backend/tests/test_xmtp_room_storage.py`.

### Durability across restart (run C, after run A → run B restart)

```
[PASS] GET /api/v1/rooms after restart :: status=200 rooms=1
[PASS] GET /docs/{id} after restart (knowledge durability) :: status=200 unique_keyword_present=True
[PASS] GET /docs list after restart :: status=200 doc_count=1
[PASS] GET /approvals after restart (approved+rejected persist) :: status=200 statuses=['approved','rejected']
[PASS] GET /messages after restart (xmtp Hub has no body) :: status=200 body={"messages":[],"next_cursor":0,"has_more":false,"retention_days":15}
=== RUN C SUMMARY: 5 PASS / 0 FAIL ===
```

## 4. Status mapping for every ACCEPTANCE_CHECKLIST item

Legend:
- **PASS** — real command output from this live run.
- **COVERED BY AUTOMATED TEST** — existing test file cited; not re-executed here (would need PostgreSQL/postgres fixtures and is outside this run's scope).
- **BY DESIGN / NOT APPLICABLE** — the behaviour is intentionally absent or unreachable on this backend.
- **REQUIRES HUMAN BROWSER CHECK** — UI-only: a human must open the app and click/see it.
- **NOT COVERED** — no local AI command / adapter / second machine was available; explicitly not claimed.
- **FAIL (defect found)** — live endpoint returned a wrong value; exact output above.

### 4.1 Current Status — "Needs manual pass" rows

| # | Checklist item | Status | Live evidence / citation | What a human must still do |
| --- | --- | --- | --- | --- |
| 1 | Chat persistence — refresh the room, confirm recent messages remain | BY DESIGN / NOT APPLICABLE | `GET /messages` → `{"messages":[],...,"retention_days":15}`; WS `message` → `body_not_on_hub`; search → `reason:"body_not_on_hub"`. `backend/tests/test_xmtp_room_storage.py` (`test_xmtp_room_rejects_message_body`, `test_ws_persist_skips_xmtp_body`, `test_search_xmtp_room_has_no_body`) | Confirm client-side XMTP message history in a browser after refresh (requires `workers/xmtp-member`). |
| 2 | Agent presence panel — Claude/Codex online state within seconds | REQUIRES HUMAN BROWSER CHECK | Supporting backend evidence: 2 WS clients received `presence_snapshot` with `max_participants=2`; `GET /api/v1/agents` → 200 `{"agents":[]}` | Start real Claude + Codex adapters, open the room, watch the presence panel change within a few seconds. |
| 3 | A2A task routing — `@Codex 你在吗` reaches completed | COVERED BY AUTOMATED TEST | Live reachability: agent card 200, `tasks/send` → `-32601 Method not found`, `SendMessage` → `-32602 Encrypted room plaintext is not accepted`, `GET /rooms/{id}/tasks` → 200 `{"tasks":[]}`. Tests: `backend/tests/test_a2a_protocol_v1_linux.py` (`test_standard_send_get_cancel_cas`, `test_encrypted_plaintext_rejected_and_artifacts_hidden`), `backend/tests/test_task_lifecycle_linux.py`, `backend/tests/test_agent_mention.py` | Start the Codex adapter and drive `@Codex 你在吗` to `completed` end-to-end. **No local AI command was started — that end-to-end path is NOT COVERED here.** |
| 4 | A2A relay dialogue — 30 s Codex/Claude dialogue, no per-turn `@` | NOT COVERED | `POST /a2a/dialogue-rpc` `dialogues/create` / `dialogues/status` returned real dialogue objects; `agent/list` → `{"agents":[]}`. Tests: `backend/tests/test_a2a_dialogues.py` (`test_dialogue_start_send_and_end`) | Start both adapters on two sessions, send the 30-second topic, confirm relay continues without `@` each turn. **Explicitly NOT COVERED — no local AI command / adapters available.** |
| 5 | Knowledge module — upload, list, read, search a Markdown doc | PASS | POST /docs 200, list 200 (count 1), read 200 with unique keyword, search 200 with 1 hit; doc still present after restart (run C). Also `backend/tests/test_codex_modules.py::test_knowledge_create_list_search` | Visually confirm Markdown rendering in the knowledge panel and a browser refresh. |
| 6 | Repository module — branch, latest commit, status, log, diff render | PASS (1 defect found) | Run B: `/git/status`, `/git/branch`, `/git/log`, `/git/diff` all 200 with real fields; scratch commit + harmless change + revert. Defect: `/git/status` `changes[].path` truncated to `MOKE.md`. Also `backend/tests/test_codex_modules.py::test_repository_status` | Visually confirm the repository panel renders branch/commit/status/diff; verify the `path` fix once a maintainer patches it. |
| 7 | Approval flow — create, approve, reject, observe WebSocket updates | PASS | Create #1/#2 200, `?status=pending` 200 (count 1), approve 200 `status=approved`, reject 200 `status=rejected`, list 200 with both statuses, **4 live `approval_update` WS frames** with `pending/approved/rejected`. Also `backend/tests/test_approval.py::test_approval_flow` | Visually confirm the approval card changes colour/state in the UI; verify linked task state updates (see §4.5 item 6). |
| 8 | Responsive/dark UI — desktop, narrow window, dark mode toggle | REQUIRES HUMAN BROWSER CHECK | No browser was driven. Source is dark-first (`frontend/src/styles.css:3`) with a `[data-theme="light"]` override at `styles.css:69`; responsive breakpoints at `styles.css:1122` (`max-width:768px`) and `styles.css:1145` (`max-width:480px`). **No theme-toggle button exists in `frontend/src`** (only the `data-theme` attribute). | Open the app at ~1440 px, then drag the window to ~700 px and ~400 px; check sidebar/panel/chat layout. For light/dark, set `document.documentElement.setAttribute('data-theme','light')` in DevTools (no UI toggle exists) and confirm text/contrast; remove the attribute to return to dark. |

### 4.2 Production Smoke Test (target `https://hub.wangdada8208.xyz` — **not contacted**)

All checks below are local equivalents on `127.0.0.1:58000`. Production itself is out of scope by instruction.

| # | Checklist item | Status | Evidence / reason |
| --- | --- | --- | --- |
| 1 | `GET /health` returns `{"status":"ok","service":"Multi-Agent Project Room"}` | PASS | Exact body captured above (local). |
| 2 | Register or log in as a human user | PASS | register + login 200 for two users; `/auth/me` 200 with token, 401 without. |
| 3 | Create or open a test room | PASS | `POST /api/v1/rooms` 200; `GET /api/v1/rooms` lists it. |
| 4 | Open the same room in a second browser/private window | REQUIRES HUMAN BROWSER CHECK | Two authenticated **WebSocket** clients were connected to the same room, not two browser windows. |
| 5 | Confirm both humans appear in the online members panel | REQUIRES HUMAN BROWSER CHECK | Backend proof: `GET /rooms/{id}/permissions` → 2 members; WS `presence_snapshot` → 2 participants. Panel rendering is UI-only. |
| 6 | Send a normal message and confirm both windows receive it | BY DESIGN / NOT APPLICABLE | WS `message` frame in an xmtp room → `{"type":"error","code":"body_not_on_hub"}`; `GET /messages` → `[]`. Encrypted room bodies never pass through Hub (`decisions.md:64`). Requires XMTP member processes + browsers. |
| 7 | Refresh the page and confirm recent messages still show | REQUIRES HUMAN BROWSER CHECK | Client-side XMTP persistence; no browser or member process was run. |
| 8 | Start the Codex adapter with the `RUNBOOK.md` command | NOT COVERED | No local AI command / credentials / adapter process was started (would call an external model). |
| 9 | Send `@Codex 你在吗` | NOT COVERED | Depends on #8. |
| 10 | Confirm the task moves `submitted -> working -> completed` | COVERED BY AUTOMATED TEST | `backend/tests/test_task_lifecycle_linux.py`, `backend/tests/test_a2a_protocol_v1_linux.py::test_standard_send_get_cancel_cas`. Not executed live (needs an adapter). |
| 11 | Confirm exactly one Codex reply appears | NOT COVERED | Depends on #8. |
| 12 | Start the Claude adapter on another machine/session | NOT COVERED | No second machine/session or adapter. |
| 13 | Send `@Codex 和 Claude 持续讨论 30 秒：介绍当前项目状态` | NOT COVERED | No adapters. |
| 14 | Confirm both agents continue through Hub relay without every turn `@` | NOT COVERED | No adapters. **Explicitly NOT COVERED — no 30-second multi-agent dialogue was executed.** |

### 4.3 Knowledge Acceptance

| # | Checklist item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Upload a Markdown document with a unique keyword | PASS | `POST /api/v1/rooms/{id}/docs` 200 with `ZQX0c6fdbdbLIVEKEY`. (API takes JSON title/content, not multipart upload.) |
| 2 | Confirm it appears in the knowledge list | PASS | `GET /docs` 200, `doc_count=1`, contains created id. |
| 3 | Open the document and confirm Markdown content renders | REQUIRES HUMAN BROWSER CHECK | API `GET /docs/{id}` 200 returns raw Markdown; rendering is frontend-only. |
| 4 | Search the unique keyword and confirm the document appears | PASS | `GET /docs/search?q=ZQX0c6fdbdbLIVEKEY` 200, `hits=1`, correct id in results. |
| 5 | Refresh the page and confirm the document remains available | REQUIRES HUMAN BROWSER CHECK | API-level durability proven after a full server restart (run C: 200, keyword present). Browser refresh not driven. |

### 4.4 Repository Acceptance

| # | Checklist item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Open a room with repository panel visible | REQUIRES HUMAN BROWSER CHECK | Panel visibility is UI-only. |
| 2 | Confirm current branch is shown | PASS (API) | `GET /git/branch` 200 `{"branch":"master"}`; `GET /git/status` also returns `branch`. |
| 3 | Confirm latest commit hash, author, message, date are shown | PASS (API) | `GET /git/log` and `GET /git/status` `last_commit` return `hash`, `short_hash`, `author`, `email`, `date`, `message`. |
| 4 | Make a harmless local change in a test branch/fixture | PASS | Scratch repo at `/tmp/<room_id>`: baseline commit `236e09f`, then an edit to `SMOKE.md`. |
| 5 | Confirm changed file appears in status/diff output | **FAIL (defect found)** | `/git/diff` 200 shows `SMOKE.md`; `/git/status` 200 shows **`MOKE.md`** (first character dropped). Exact output and root cause in §3. No source was edited. |
| 6 | Revert the harmless local change after verification | PASS | `git checkout -- SMOKE.md`; `GET /git/status` → `changes=[]`. |

### 4.5 Approval Acceptance

| # | Checklist item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Trigger or create an approval request | PASS | `POST /rooms/{id}/approvals` 200, `status="pending"`. |
| 2 | Confirm pending approval appears in the UI | REQUIRES HUMAN BROWSER CHECK | `GET /rooms/{id}/approvals?status=pending` 200 with `pending_count=1`; UI rendering not driven. |
| 3 | Approve it and confirm the card status updates | PASS (API + WS) | `POST /approvals/{id}/approve` `{"decision":"approved"}` → 200 `status="approved"`; live `approval_update` WS frame with `approved`. Card visual is UI-only. |
| 4 | Create another approval request | PASS | Second create 200, `status="pending"`. |
| 5 | Reject it and confirm the card status updates | PASS (API + WS) | Same endpoint with `{"decision":"rejected"}` → 200 `status="rejected"`; live `approval_update` WS frame with `rejected`. |
| 6 | Confirm linked task state updates when approval events are emitted | NOT COVERED | No A2A task was created (no adapter); `GET /rooms/{id}/tasks` → `{"tasks":[]}`. Requires a live task + adapter. |

### 4.6 Dual-Machine E2E Acceptance

| # | Checklist item | Status | Reason |
| --- | --- | --- | --- |
| 1 | Two machines each open Hub in a browser | REQUIRES HUMAN BROWSER CHECK | Single local machine only. |
| 2 | Each machine runs `workers/xmtp-member` (Node 22), Python runs only Hub | REQUIRES HUMAN BROWSER CHECK | No member process started. |
| 3 | Both machines send a message in the same encrypted room | REQUIRES HUMAN BROWSER CHECK | No XMTP group / member process. |
| 4 | Both machines see their turn records and owner records in the browser | REQUIRES HUMAN BROWSER CHECK | No browser. |

### 4.7 Out of scope for this live run

- **Already-passed Current Status rows** (GitHub Actions deploy, Production health, Dual-machine drill, Owner gateway consent, Coordinator/scoreboard, Real connectors, Agent onboarding, Connect with MAPR) — historical evidence, **not re-tested**; production was not contacted.
- **Release Notes Checklist** (`PLAN.md`, `CLAUDE.md`, `RUNBOOK.md`, `ROADMAP.md`, GitHub Actions green) — documentation/process review by a human maintainer; this task forbids editing other docs, so nothing was changed.
- **Automated Verification commands** (`pytest`, `npm run build`, xmtp-member typecheck/tests) — not executed here; test files are cited, not run, because they need PostgreSQL fixtures / Node toolchains and are outside the granted write scope.

### 4.8 Counts

| Status | Count |
| --- | --- |
| PASS (live evidence) | **17** |
| COVERED BY AUTOMATED TEST | **2** |
| BY DESIGN / NOT APPLICABLE | **2** |
| REQUIRES HUMAN BROWSER CHECK | **13** |
| NOT COVERED (no local AI command / adapter / second machine) | **8** |
| FAIL (defect found) | **1** |
| **Total mapped checklist items** | **43** |

Live driver totals: run A **46 PASS / 0 FAIL**, run B **7 PASS / 1 FAIL**, run C **5 PASS / 0 FAIL**.

## 5. Teardown

```
=== stopping run B uvicorn pid=3833 ===
3833 .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 58000 --log-level warning
--- process check ---  process gone
--- port 58000 listeners ---  port 58000 free
--- curl after stop ---  curl: (7) Failed to connect to 127.0.0.1 port 58000 after 0 ms: Could not connect to server
```

Run A (pid 31723) was stopped before run B with the same `kill` + `ps`/`ss` confirmation. Temp DB `/tmp/mapr-smoke-31722.db` (and `-wal`/`-shm`) and the scratch git repo `/tmp/4f9702e8-...` were removed. Raw logs and drivers remain under `/tmp/mapr-smoke-*` for review.

## 6. Remaining human-only checks (explicit)

1. **Responsive/dark UI** — open the app in a browser at ~1440 px; drag to ~700 px then ~400 px. Check the sidebar collapses, `.side-panel` moves below the chat, tabs/chat input remain usable, and no horizontal scroll. For theme: no toggle button exists in `frontend/src`; in DevTools run `document.documentElement.setAttribute('data-theme','light')` and back, and visually confirm contrast on login, room list, chat, knowledge, repository and approval panels.
2. **Both humans in a second browser window** — open the same room in a private window with the second account and confirm both names appear in the online members panel within a few seconds.
3. **Knowledge panel rendering + refresh** — open the created doc, confirm Markdown (`#`, `**bold**`) renders, press F5, confirm the doc is still listed and searchable.
4. **Repository panel rendering** — open a room with a repo attached; confirm branch, latest commit (hash/author/message/date), status, log and diff render. Confirm the `git/status` `path` truncation defect once fixed.
5. **Approval card visuals + linked task state** — confirm the card changes on approve/reject and that a linked A2A task moves state when approval events are emitted.
6. **Adapter-driven A2A** — start the Codex adapter (`RUNBOOK.md`), send `@Codex 你在吗`, watch `submitted -> working -> completed` and exactly one reply; start Claude on a second session and run the 30-second relay dialogue. **Not covered by this run.**
7. **Dual-machine XMTP E2E** — two machines, each with `workers/xmtp-member`, same encrypted room, verify turn/owner records in each browser.
8. **Production smoke** — re-run the Production Smoke Test list against `https://hub.wangdada8208.xyz` only with the owner's approval; this run deliberately never contacted production.
9. **Release notes / CI** — human maintainer confirms `PLAN.md`, `CLAUDE.md`, `RUNBOOK.md`, `ROADMAP.md` and the latest `main` GitHub Actions run.
