# Demo Checklist

Use this checklist after local changes or production deployment. The goal is a
five-minute confidence pass through the core collaboration loop.

## Production Smoke Test

Target: `https://hub.wangdada8208.xyz`

1. Open `https://hub.wangdada8208.xyz/health/details`.
2. Confirm the response includes `"status":"ok"` and `"database":{"status":"connected"}`.
3. Open `https://hub.wangdada8208.xyz`.
4. Register or log in with a human account.
5. Create a room named `Smoke Test`.
6. Open the same room in a second browser or private window with a second account.
7. Confirm both users appear in the online members panel.
8. Send a normal chat message and confirm it appears in both windows.
9. Start an adapter in another terminal:

```bash
python3 local_agent_adapter.py \
  --server https://hub.wangdada8208.xyz \
  --agent-name Codex \
  --auth-username codex \
  --auth-password "<password>" \
  --auth-register
```

10. Send `@Codex 你好，确认你在线并回复一句。`
11. Confirm a task appears in the task panel.
12. Confirm Codex replies in the chat.
13. Send a message that asks for approval, for example:

```text
@Codex 这个操作需要审批，请创建一个审批请求。
```

14. Confirm an approval card appears.
15. Approve it, then confirm the approval status and linked task update.

## Local Smoke Test

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

Adapter:

```bash
python3 local_agent_adapter.py \
  --server http://localhost:8000 \
  --agent-name Codex \
  --auth-username codex \
  --auth-password "local-secret" \
  --auth-register
```

Run the same room, message, task, and approval steps from the production smoke
test against `http://127.0.0.1:5173`.

## Expected Results

- Health details returns `status: ok`.
- Login or registration succeeds without console errors.
- Room creation navigates into the new room.
- Presence updates when another browser or adapter joins.
- Chat messages persist after refresh.
- `@Codex` creates a task and routes it to the adapter.
- Adapter replies without requiring manual token copy.
- Approval creation works when adapter auth succeeds.
- Approval approve/reject updates the approval card and linked task.
- No horizontal overflow on a narrow browser window.
