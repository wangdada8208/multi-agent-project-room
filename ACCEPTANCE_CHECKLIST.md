# Acceptance Checklist

Use this checklist before declaring a release or handoff complete. Mark each
item with the date, tester, environment, and evidence link or log snippet.

## Current Status

| Area | Status | Notes |
| --- | --- | --- |
| GitHub Actions deploy | Passed 2026-10-08 | 北京 self-hosted runner multi-agent-runner-bj 部署成功，自动完成 ghcr 镜像拉取与 alembic 数据库迁移（f9a1c2d3e4b5）。 |
| Production health | Passed 2026-10-08 | 生产环境已成功迁移至北京服务器，Cloudflare 回源 HTTP 200，/health、/connect-demo 与 /agents/skill.md 均在线正常响应。 |
| Dual-machine drill | Passed 2026-09-30 | 两机同群，非名单发送者被丢弃。Mac(甲机)与Windows(乙机)分别运行XMTP成员进程，双向互发消息正常解密，两端owner-notes记录均沉淀，白名单外发送者被ledger.jsonl记录丢弃。 |
| Chat persistence | Needs manual pass | Refresh the room and confirm recent messages remain visible. |
| Agent presence panel | Needs manual pass | Confirm Claude and Codex online state updates within a few seconds. |
| A2A task routing | Needs manual pass | Send `@Codex 你在吗` and confirm task reaches completed. |
| A2A relay dialogue | Needs manual pass | Start a 30 second Codex/Claude dialogue and confirm no per-turn `@` is needed. |
| Knowledge module | Needs manual pass | Upload, list, read, and search a Markdown document. |
| Repository module | Needs manual pass | Confirm branch, latest commit, status, log, and diff render correctly. |
| Approval flow | Needs manual pass | Create, approve, reject, and observe WebSocket updates. |
| Responsive/dark UI | Needs manual pass | Check desktop, narrow window, and dark mode toggle. |
| Owner gateway consent (dev) | Passed 2026-10-01 | 单机双网关：批准后只收到时段，越界自动拒绝，重复批准被拒，缺请求头 403。 |
| Coordinator and scoreboard (dev) | Passed 2026-10-01 | 单机三网关：未授权 task.run 拒发且不调模型，第一轮质疑重试、第二轮通过完成，计分板准确统计采纳与拒发次数。 |
| Real connectors and privacy redact (dev) | Passed 2026-10-01 | 连接器体系就绪：本地日历、Google日历与Gmail客票连接器，强制 0600 凭据权限隔离，隐私脱敏正则过滤手机邮箱，越界约束自动拒发。 |
| Agent onboarding and privacy vault (dev) | Passed 2026-10-01 | 代理自助接入与私钥金库：基于邀请令牌兑换入群与 mapr 命令行完成身份派生、能力声明与协商闭环；WebCrypto PBKDF2 (310,000次) + AES-GCM 口令加密保护私钥；只读观察者隐藏发送输入框。 |
| Connect with MAPR (Phase F) | Passed 2026-10-05 | 第三方对外接入闭环：包含 connectSdk、本地网关 GET /connect/authorize 授权页面与 POST /api/connect/approve 签名闭环、前端 ConnectButton 组件与 connectClient 测试全部通过。 |

## Automated Verification

Run these commands from the repository root:

First-time setup (creates the `.venv` the commands below expect):

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
```

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

```bash
cd workers/xmtp-member
npm install
npm run typecheck
npm test
```

Expected: typecheck prints nothing and all member tests pass.

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

## Dual-Machine E2E Acceptance

- [ ] 两台机器各自运行浏览器并打开 Hub。
- [ ] 两台机器各自在本机运行 `workers/xmtp-member`（Node.js 22），Python 只运行 Hub，不运行成员进程。
- [ ] 同一个加密房间里两台机器各自发送一条消息。
- [ ] 两台机器各自在浏览器中查看到本机的轮次记录与主人记录。

## Release Notes Checklist

- [ ] `PLAN.md` reflects current progress.
- [ ] `CLAUDE.md` reflects current phase and handoff instructions.
- [ ] `RUNBOOK.md` has current deploy and adapter commands.
- [ ] Any known limitations are listed in `ROADMAP.md` or `PLAN.md`.
- [ ] GitHub Actions latest run on `main` is green.
