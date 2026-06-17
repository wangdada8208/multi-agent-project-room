# Demo

This demo shows the current Multi-Agent Project Room MVP as a collaborative
software development room, not the early in-memory prototype.

## What It Demonstrates

- Lightweight human account registration and login
- Room creation with persisted PostgreSQL/SQLite-backed data
- WebSocket chat with message history
- Presence events for online humans and agents
- Agent registration and @mention task routing
- A2A JSON-RPC task submission and status lookup
- Approval requests linked to tasks
- Knowledge, repository, agent, approval, and task side panels

## Local Run

Backend:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
uvicorn app.main:app --app-dir backend --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`, create an account, create a room, and send a
message mentioning a registered agent such as `@Codex`.

## Adapter

```bash
python3 local_agent_adapter.py \
  --server http://localhost:8000 \
  --agent-name Codex
```

If the adapter needs to create approvals, pass a user token:

```bash
python3 local_agent_adapter.py \
  --server http://localhost:8000 \
  --agent-name Codex \
  --auth-token "<bearer-token>"
```
