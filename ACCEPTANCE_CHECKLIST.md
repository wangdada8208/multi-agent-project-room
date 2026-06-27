# Acceptance Checklist

Use this checklist before declaring a release or handoff complete. Mark each
item with the date, tester, environment, and evidence link or log snippet.

## Current Status

| Area | Status | Notes |
| --- | --- | --- |
| GitHub Actions deploy | Verified | Latest `main` deploy should be green before release. |
| Production health | Verified | `GET https://hub.wangdada8208.xyz/health` returns `status: ok`. |
| Chat persistence | Needs manual pass | Refresh the room and confirm recent messages remain visible. |
| Agent presence panel | Needs manual pass | Confirm Claude and Codex online state updates within a few seconds. |
| A2A task routing | Needs manual pass | Send `@Codex 你在吗` and confirm task reaches completed. |
| A2A relay dialogue | Needs manual pass | Start a 30 second Codex/Claude dialogue and confirm no per-turn `@` is needed. |
| Knowledge module | Needs manual pass | Upload, list, read, and search a Markdown document. |
| Repository module | Needs manual pass | Confirm branch, latest commit, status, log, and diff render correctly. |
| Approval flow | Needs manual pass | Create, approve, reject, and observe WebSocket updates. |
| Responsive/dark UI | Needs manual pass | Check desktop, narrow window, and dark mode toggle. |

## Automated Verification

Run these commands from the repository root:

```bash
cd backend
../.venv/bin/pytest tests -q
```

Expected: all backend tests pass.

```bash
.venv/bin/pytest tests/test_local_agent_adapter.py -q
```

Expected: adapter tests pass.

```bash
cd frontend
npm run build
```

Expected: TypeScript and Vite production build pass.

## Production Smoke Test

Target: `https://hub.wangdada8208.xyz`

- [ ] `GET /health` returns `{"status":"ok","service":"Multi-Agent Project Room"}`.
- [ ] Register or log in as a human user.
- [ ] Create or open a test room.
- [ ] Open the same room in a second browser/private window.
- [ ] Confirm both humans appear in the online members panel.
- [ ] Send a normal message and confirm both windows receive it.
- [ ] Refresh the page and confirm recent messages still show.
- [ ] Start the Codex adapter with the command in `RUNBOOK.md`.
- [ ] Send `@Codex 你在吗`.
- [ ] Confirm the task moves `submitted -> working -> completed`.
- [ ] Confirm exactly one Codex reply appears.
- [ ] Start the Claude adapter on another machine/session.
- [ ] Send `@Codex 和 Claude 持续讨论 30 秒：介绍当前项目状态`.
- [ ] Confirm both agents continue through Hub relay without requiring every turn to include `@`.

## Knowledge Acceptance

- [ ] Upload a Markdown document with a unique keyword.
- [ ] Confirm it appears in the knowledge list.
- [ ] Open the document and confirm Markdown content renders.
- [ ] Search the unique keyword and confirm the document appears.
- [ ] Refresh the page and confirm the document remains available.

## Repository Acceptance

- [ ] Open a room with repository panel visible.
- [ ] Confirm current branch is shown.
- [ ] Confirm latest commit hash, author, message, and date are shown.
- [ ] Make a harmless local change in a test branch or fixture.
- [ ] Confirm changed file appears in status/diff output.
- [ ] Revert the harmless local change after verification.

## Approval Acceptance

- [ ] Trigger or create an approval request.
- [ ] Confirm pending approval appears in the UI.
- [ ] Approve it and confirm the card status updates.
- [ ] Create another approval request.
- [ ] Reject it and confirm the card status updates.
- [ ] Confirm linked task state updates when approval events are emitted.

## Release Notes Checklist

- [ ] `PLAN.md` reflects current progress.
- [ ] `CLAUDE.md` reflects current phase and handoff instructions.
- [ ] `RUNBOOK.md` has current deploy and adapter commands.
- [ ] Any known limitations are listed in `ROADMAP.md` or `PLAN.md`.
- [ ] GitHub Actions latest run on `main` is green.
