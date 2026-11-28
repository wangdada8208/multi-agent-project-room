---
name: verify-parlor
description: Verify real Parlor user journeys through the browser, Hub API, and local mapr CLI. Use for changes to sign-in, encrypted rooms, helper and MCP setup, cloud agents, or team invites.
---

# Verify Parlor

Drive the React site as a user. Use the Hub API for read-only confirmation and the `mapr` CLI where the journey calls for it. Start with the [feature map](features/README.md).

## Launch

Use a non-root Linux checkout with Python 3.13, Node.js 22, PostgreSQL 17 server and client binaries, Redis, Chromium, `ss`, and `browser-harness` on `PATH`. Use `PARLOR_PG_BIN` for a non-default PostgreSQL binary directory and `PARLOR_CHROMIUM` for a Chromium executable with a different name. Install CJK fonts for legible Chinese screenshots.

From the repository root, install the pinned frontend dependencies and the backend requirements:

```bash
python3.13 -m venv .venv
. .venv/bin/activate
python -m pip install -r backend/requirements.txt
npm ci --prefix frontend
```

In the launch terminal, keep the supervisor in the foreground:

```bash
export PARLOR_RUN=$(mktemp -d /tmp/parlor-verify.XXXXXX)
.cursor/skills/verify-parlor/scripts/stack.py launch "$PARLOR_RUN"
```

Set `PARLOR_RUN` to that same path in the drive terminal and activate the same virtualenv there. Wait for `Parlor ready at http://127.0.0.1:PORT`. The helper initializes an empty PostgreSQL cluster, runs `alembic upgrade head`, starts the Hub, and checks that system room templates were seeded. Vite proxies to the owned Hub. PostgreSQL and Redis use private Unix sockets. Each run gets separate loopback ports and a fresh Chromium profile. Hub and Vite omit checkout `.env` files.

The baseline starts with empty accounts and rooms and enables username authentication. Email delivery, Google identity, and joined XMTP members require the separate fixtures listed in the relevant feature. Run only one browser driver per run. The local helper uses fixed port 8790. Run the helper-specific paths only when that port is free on a disposable machine or isolated environment.

## Doctor

```bash
set -o pipefail
.cursor/skills/verify-parlor/scripts/stack.py doctor "$PARLOR_RUN" | tee "$PARLOR_RUN/evidence/doctor.json"
```

Require exit 0, the current checkout revision, owned listeners, Hub readiness with the Alembic revision, at least one system template through the Vite proxy, and HTTP 401 for anonymous `/api/v1/auth/me`. For an authenticated run, require the browser's `GET /api/v1/rooms` to return HTTP 200 after login.

## Drive

Run the username authentication journey once per fresh instance:

```bash
.cursor/skills/verify-parlor/scripts/drive-auth.sh "$PARLOR_RUN"
```

The helper drives landing, registration, logout, password rejection, login, and reload through Chromium. A read-only PostgreSQL query confirms account persistence. For other features, use each feature's steps with the browser-harness wrapper. It runs doctor first and points the harness at the run's dedicated Chromium:

```bash
.cursor/skills/verify-parlor/scripts/stack.py browser "$PARLOR_RUN" <<'PY'
import os
print(new_tab(os.environ["PARLOR_WEB_URL"]))
wait_for_load()
print(page_info())
PY
```

Reuse the tab across calls with `goto_url(...)` or `switch_tab(tab_id)`. Inspect the accessibility tree via `cdp("Accessibility.getFullAXTree")` and select the control by role and label. Use `DOM.scrollIntoViewIfNeeded`, `DOM.getBoxModel`, and `click_at_xy` for pointer input. Focus fields and use `cdp("Input.insertText", text=value)` for text. Close your tab with `close_tab(tab_id)` when finished. Follow the product entry points, including submitted forms and generated links.

## Evidence

Keep results under `$PARLOR_RUN/evidence/`. The auth helper records actions, final paths, and HTTP status codes in `01-auth-trace.jsonl`. It captures accessibility names at every main state in `01-*.aria.json` and attempts a Chromium screenshot of the resulting room list in `01-rooms.png`. The SQL result goes to `01-auth-db.txt`. Launch logs and `cleanup.json` stay in the same directory.

For each path, record the feature ID, entry point, action, and resulting screen or command status. Verify mutations from a second view, such as a fresh tab or a read-only query. Capture sanitized statuses and counts instead of exporting network bodies or credential files. Use only synthetic room text and accounts. Mask tokens, passwords, wallet keys, and private message text in retained output. For any external boundary stub or dry run, identify the skipped calls and prove their absence with observed requests, process state, or changed files.

## Cleanup

Run cleanup after every successful or failed drive. Stop any additional terminals, helper instances, or cloud seats your feature started before removing the stack.

```bash
.cursor/skills/verify-parlor/scripts/stack.py cleanup "$PARLOR_RUN"
test ! -e "$PARLOR_RUN/runtime"
ls "$PARLOR_RUN/evidence"
```

Use Ctrl+C in the launch terminal if startup failed before `instance.json` appeared. The supervisor stops its browser-harness daemon and owned processes, confirms listeners closed, and removes the database, cache, and browser profile. Check `cleanup.json` and confirm that evidence from your attempted journey survives. A failure before the first browser action can leave only launch and cleanup logs.

## Helpers

| Helper | Invocation |
| --- | --- |
| Stack supervisor | `.cursor/skills/verify-parlor/scripts/stack.py launch "$PARLOR_RUN"` |
| Read-only probe | `.cursor/skills/verify-parlor/scripts/stack.py doctor "$PARLOR_RUN"` |
| Browser wrapper | `.cursor/skills/verify-parlor/scripts/stack.py browser "$PARLOR_RUN" < journey.py` |
| Auth journey | `.cursor/skills/verify-parlor/scripts/drive-auth.sh "$PARLOR_RUN"` |
| Cleanup | `.cursor/skills/verify-parlor/scripts/stack.py cleanup "$PARLOR_RUN"` |

Use `/maintain-verification-skill` to re-run the map and update its journeys when the product changes.
