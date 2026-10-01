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
3. Wait for the configured task timeout. Default:
   `MAPR_A2A_TASK_TIMEOUT_SECONDS=300`.
4. Querying tasks now opportunistically marks stale `submitted` / `working`
   tasks as `failed`.
5. To trigger expiry manually through A2A JSON-RPC:

```bash
curl -sS https://hub.wangdada8208.xyz/a2a \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tasks/expire","params":{"timeout_seconds":300},"id":"expire-now"}'
```

6. If the target Agent has no active A2A route, direct `tasks/send` now fails
   quickly instead of creating a permanent `working` task.

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

## 主人网关

本机文件（都在 workers/xmtp-member/.state/，不要提交）：

- policy.json：谁能申请什么。示例：{"allow": {"0x对方地址小写": ["calendar.free_busy"]}, "max_range_days": 14}。缺少 policy.json 时默认无人可申请任何范围（自动回复 out_of_scope 拒绝）。
- calendar.json：本机日历，JSON 数组，每项至少有 start、end（ISO 时间）。也可以用 MAPR_CALENDAR_FILE 指向别处。
- consents.json、inbox.json、ledger.jsonl：网关自己写，不要手改。

控制台：启动成员进程后打开 http://127.0.0.1:8787/（端口由 OWNER_NOTES_PORT 决定）。控制台所有写操作（批准、拒绝、发起申请）均受 localGuard 保护，必须来自本机回环地址且必须携带 `X-MAPR-Owner: 1` 请求头，跨站表单无法伪造。

从命令行发申请：

```bash
curl -s -X POST http://127.0.0.1:8787/api/requests -H 'X-MAPR-Owner: 1' -H 'Content-Type: application/json' \
  -d '{"to":"0x对方地址","scope":"calendar.free_busy","purpose":"用途","date_from":"2026-10-05","date_to":"2026-10-09"}'
```
