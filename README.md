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

For manual release verification, follow `DEMO_CHECKLIST.md`.

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

## Tests

```bash
pytest backend/tests
cd frontend && npm run build
```
