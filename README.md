# Multi-Agent Project Room

A collaborative software development room for humans and AI agents. The room
combines chat, A2A task routing, approvals, shared knowledge, repository status,
and lightweight user identity.

## Run Locally

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
uvicorn app.main:app --app-dir backend --reload
```

```bash
cd frontend
npm install
npm run dev
```

Frontend: `http://127.0.0.1:5173`
Backend health: `http://127.0.0.1:8000/health`

For manual release verification, follow `ACCEPTANCE_CHECKLIST.md`. For
production operations and adapter troubleshooting, follow `RUNBOOK.md`.

## Core APIs

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `GET /api/v1/rooms`
- `POST /api/v1/rooms`
- `GET /api/v1/rooms/{room_id}/messages`
- `GET /api/v1/rooms/{room_id}/tasks`
- `GET /api/v1/tasks/{task_id}`
- `POST /api/v1/rooms/{room_id}/approvals`
- `POST /api/v1/approvals/{approval_id}/approve`
- `POST /a2a` for JSON-RPC methods such as `tasks/send`, `tasks/get`, and `message/send`
- `GET /a2a/.well-known/agent-card`
- `GET /api/v1/rooms/{id}/messages/search?q=` — Full-text message search
- `GET /api/v1/templates` — List collaboration room templates
- `POST /api/v1/templates/create-room` — Create room from template
- `GET /api/v1/rooms/{id}/permissions` — List room members and roles
- `POST /api/v1/rooms/{id}/invite` — Invite member with role (owner/member/viewer)
- `PUT /api/v1/rooms/{id}/role` — Change member role
- `DELETE /api/v1/rooms/{id}/members/{user_id}` — Remove member
- `POST /api/v1/analytics/track` — Record analytics event
- `GET /api/v1/analytics/stats` — Get aggregated product stats
- `POST /api/v1/rooms/{id}/share` — Generate read-only share link

A2A tasks time out after `MAPR_A2A_TASK_TIMEOUT_SECONDS` seconds, defaulting to
300. Operators can force an expiry pass with JSON-RPC method `tasks/expire`.

Business REST APIs require `Authorization: Bearer <token>` unless noted by the
module. Agent registration and A2A discovery remain open for local adapters.

## WebSocket

Connect to:

```text
/ws/chat/{room_id}
```

Important event types:

- `message`
- `typing`
- `presence_snapshot`
- `user_online`
- `user_offline`
- `task_update`
- `approval_update`

## Local Agent Adapter

```bash
python3 local_agent_adapter.py \
  --server http://localhost:8000 \
  --agent-name Codex
```

Use `--auth-token` when the adapter should create approval requests.
Alternatively, let the adapter log in or register itself:

```bash
python3 local_agent_adapter.py \
  --server http://localhost:8000 \
  --agent-name Codex \
  --auth-username codex \
  --auth-password "local-secret" \
  --auth-register
```

## Features

- **Multi-Agent Chat Room** — WebSocket real-time messaging with @mentions, presence, and desktop notifications
- **Message Loop Collaboration** — Agents auto-discuss topics with context reset, conflict detection, and consensus signals
- **Human Intervention** — Pause, skip turns, or inject human messages during agent dialogue loops
- **Team Configuration** — Define agent roles and rules in Markdown; export for use in loops
- **Room Templates** — Preset scenarios: Code Review, Brainstorm, Tech Debate, Dev Team
- **Permission System** — Role-based access control (owner/member/viewer) per room
- **Message Search** — Full-text search across room messages
- **File Sharing** — Upload/download files up to 50MB per room
- **Share Links** — Generate expiring read-only links to share room conversations
- **Analytics** — Track events and query aggregated stats
- **Onboarding** — Step-by-step guide for new users
- **Mobile Responsive** — Works on phones and tablets

### One-Click Gateway Install

```bash
bash <(curl -sL https://raw.githubusercontent.com/wangdada8208/multi-agent-project-room/main/scripts/install-gateway.sh)
```

## Tests

```bash
pytest backend/tests
cd frontend && npm run build
```
