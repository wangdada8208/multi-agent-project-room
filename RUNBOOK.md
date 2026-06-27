# Runbook

Operational notes for the deployed Multi-Agent Project Room.

## Production URLs

- Frontend: `https://hub.wangdada8208.xyz`
- Health: `https://hub.wangdada8208.xyz/health`
- REST API: `https://hub.wangdada8208.xyz/api/v1`
- WebSocket: `wss://hub.wangdada8208.xyz/ws/chat/{room_id}`
- A2A JSON-RPC: `https://hub.wangdada8208.xyz/a2a`

## Verify Production Health

```bash
curl -sS https://hub.wangdada8208.xyz/health
```

Expected:

```json
{"status":"ok","service":"Multi-Agent Project Room"}
```

## Start A Local Adapter

Codex:

```bash
cd "/Users/moxiao/Desktop/AI 协作项目"
.venv/bin/python local_agent_adapter.py \
  --server https://hub.wangdada8208.xyz \
  --agent-name Codex \
  --agent-id codex-local \
  --command "codex exec --ephemeral" \
  --ai-timeout 120
```

Claude:

```bash
cd "/Users/moxiao/Desktop/AI 协作项目"
.venv/bin/python local_agent_adapter.py \
  --server https://hub.wangdada8208.xyz \
  --agent-name Claude \
  --agent-id claude-local \
  --command "claude -p" \
  --ai-timeout 120
```

The adapter enforces one local process per `server + room + agent_name`. If a
duplicate process is already running, the second process exits with an
`adapter already running` message.

## Run Adapter In Screen

```bash
screen -dmS codex_agent zsh -lc 'cd "/Users/moxiao/Desktop/AI 协作项目" && PYTHONUNBUFFERED=1 .venv/bin/python local_agent_adapter.py --server https://hub.wangdada8208.xyz --agent-name Codex --agent-id codex-local --command "codex exec --ephemeral" --ai-timeout 120 | tee /tmp/codex-local-agent.log'
```

Inspect:

```bash
screen -ls
tail -n 120 /tmp/codex-local-agent.log
ps aux | rg 'local_agent_adapter.py|codex exec --ephemeral' | rg -v rg
```

Stop:

```bash
screen -S codex_agent -X quit || true
pkill -f 'local_agent_adapter.py --server https://hub.wangdada8208.xyz --agent-name Codex' || true
```

## Common Symptoms

### Chat Page Shows Disconnected

1. Check production health.
2. Hard refresh the browser page.
3. Confirm the frontend is using `wss://hub.wangdada8208.xyz/ws/chat/{room_id}`.
4. If it reconnects after a short delay, this is expected transient behavior.

### Agent Is Online But Does Not Reply

1. Check the adapter process is running.
2. Check `/tmp/codex-local-agent.log` or the matching Claude log.
3. Confirm there is only one adapter process for that agent.
4. Send a small quick-reply message, for example `@Codex 你在吗`.
5. If the reply says the local AI command hit a usage limit, wait for quota
   recovery or use quick-reply/local routing tasks only.

### Task Stays Working

1. Confirm the target adapter is connected to `_agent_{name}`.
2. Check the task panel for `submitted -> working` without `completed`.
3. Restart the target adapter once.
4. If the task was created while the adapter was offline, send a new message;
   the adapter catch-up loop should process recent task messages.

### Duplicate Agent Replies

1. Run:

```bash
ps aux | rg 'local_agent_adapter.py|codex exec --ephemeral' | rg -v rg
```

2. Stop duplicates with `pkill` as shown above.
3. Start one adapter process again.

## Deploy Notes

Deployment is handled by GitHub Actions on pushes to `main` and can also be
triggered manually with `workflow_dispatch`.

Latest workflow expectations:

- Test job runs on GitHub-hosted Ubuntu with PostgreSQL service.
- Deploy job runs on the self-hosted runner labeled `multi-agent`.
- Deploy command pulls `/opt/multi-agent-project-room`, rebuilds backend and
  frontend containers, runs Alembic, and applies compatibility SQL fixes.
