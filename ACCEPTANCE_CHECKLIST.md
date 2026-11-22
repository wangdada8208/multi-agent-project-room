# Acceptance Checklist

Use this checklist before declaring a release or handoff complete. Mark each
item with the date, tester, environment, and evidence link or log snippet.

## Current Status

| Area | Status | Notes |
| --- | --- | --- |
| GitHub Actions deploy | Passed 2026-11-13 | 北京 self-hosted runner `multi-agent-runner-bj` 在线。2026-11-13 三次 push 触发的真实 Deploy 运行 `43458558843` / `43459786523` 均 success（`test` + `build` 通过、`deploy` 按设计跳过）；最新 `b007ff1` 运行见 `docs/verification/2026-11-12-合并门禁与CI证据.md`。 |
| Production health | Passed 2026-11-12/13 | `https://hub.wangdada8208.xyz/health` 实测 200 `{"status":"ok","service":"Multi-Agent Project Room"}`；生产库 `alembic_version = i90c20261017`，`/ready` 200（2026-10-19 迁移验收）。 |
| Dual-machine drill | Passed 2026-09-30 | 两机同群，非名单发送者被丢弃。Mac(甲机)与Windows(乙机)分别运行XMTP成员进程，双向互发消息正常解密，两端owner-notes记录均沉淀，白名单外发送者被ledger.jsonl记录丢弃。 |
| Fourth-round audit closeout | Passed 2026-10-19 / 2026-11-12 | 真实 CI `39194420306`：后端 `791 passed, 30 skipped, 0 failed`、前端 `64 passed`、构建成功。2026-11-12 本地隔离 PG17+Redis 全量复核 `795 passed, 30 skipped, 0 failed`（含新增 4 项回归用例），见 `docs/verification/2026-11-12-local-full-verification.md`。 |
| TLS verification (local runner) | Passed 2026-11-12 | 4 处 `verify=False` 全部清除；方案 A（默认系统信任库 + CA/指纹显式放开 + 到期提醒）；新增 25 项测试通过，变异验证生效，见 `docs/verification/2026-11-12-tls-hardening.md`。 |
| main branch merge gate | Passed 2026-11-12 | 经典分支保护：4 项必需检查、`strict`、`enforce_admins=true`、1 名评审、禁 force push/删除、要求会话解决。回读证据见 `docs/verification/2026-11-12-合并门禁与CI证据.md`。 |
| `alembic check` drift | Passed 2026-11-12 | 真实迁移库上 `alembic check` → `No new upgrade operations detected.`（exit 0），单 head 仍为 `i90c20261017`，未新增迁移、未改生产 schema，见 `docs/verification/2026-11-12-schema-drift-fix.md`。 |
| Production legacy hub-room cleanup | Passed 2026-11-14 | 只读盘点 `43460928682` → 备份＋单事务删除 `43462676253`：7 个旧明文房间删除，4 个 `_agent_` 与 1 个 xmtp 房间保留，零孤儿行，`/health` 200、`/ready` `i90c20261017`，见 `docs/verification/2026-11-12-prod-legacy-room-cleanup-tool.md`。 |
| Live backend smoke | Passed 2026-11-12 | 本机起真实 FastAPI，`/health`、`/ready`、注册登录鉴权、房间与权限、双 WS 客户端、审批流 4 个实时帧、知识库增删查搜、仓库面板、Agent Card 等共 17 项 PASS；见 `docs/verification/2026-11-12-live-smoke-acceptance.md`。 |
| Repository panel defect | Fixed 2026-11-12 | 实跑发现 `git/status` 把 `SMOKE.md` 报成 `MOKE.md`（`_git()` 的 `strip()` 吃掉首列状态位），已修并加 4 项回归测试，见 `docs/verification/2026-11-12-live-smoke-acceptance.md`。 |
| Chat persistence | By design / needs manual pass | 加密房间正文不落 Hub（已由 `backend/tests/test_xmtp_room_storage.py` 与实跑双重确认）；刷新后可见依赖本机 XMTP 历史，需在浏览器人工确认。 |
| Agent presence panel | Passed (live WS) 2026-11-12 | 实跑 2 个 WS 客户端收到 `presence_snapshot` 含 2 名参与者。 |
| A2A task routing | Needs manual pass | 无本地 AI 命令/适配器时不能完成 `@Codex -> completed`；实跑中 `agent/list` 为空。需人工在接好适配器后确认。 |
| A2A relay dialogue | Needs manual pass | 30 秒 Codex/Claude 连续对话未覆盖（无本地 AI 命令）。 |
| Knowledge module | Passed 2026-11-12 | 实跑 create/list/read/search 唯一关键字，且服务重启后仍在。 |
| Repository module | Passed 2026-11-12 | 实跑 `/git/{status,branch,log,diff}` 均 200；`git/status` 文件名截断缺陷已修并回归。 |
| Approval flow | Passed 2026-11-12 | 实跑 create/pending/approve/reject，并收到 4 个 `approval_update` WS 帧（`pending`/`approved`/`rejected`）。 |
| Responsive/dark UI | Needs manual pass | 浏览器专属：`frontend/src` 只有 `[data-theme="light"]` 覆盖、没有主题切换按钮；按 `docs/verification/2026-11-12-live-smoke-acceptance.md` 的 DevTools 步骤人工确认。 |
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

- [x] `PLAN.md` reflects current progress. — 2026-11-12 第 0 节重写为 A–F 交付 + 第四轮修复 + 收尾状态。
- [x] `CLAUDE.md` reflects current phase and handoff instructions. — 2026-11-12 修正「阶段 C 尚未开始」等陈旧描述。
- [x] `RUNBOOK.md` has current deploy and adapter commands. — 2026-11-13 补 Redis service、作业依赖与 `prod-hygiene.yml` 入口。
- [x] Any known limitations are listed in `ROADMAP.md` or `PLAN.md`. — 见 `ROADMAP.md` 第 0/1/4 节与 `docs/verification/2026-11-12-*.md`。
- [x] GitHub Actions latest run on `main` is green. — 2026-11-13 三次 push 触发的 Deploy 运行见 `docs/verification/2026-11-12-合并门禁与CI证据.md` 与下方「2026-11-12 收尾验证」。

## 2026-11-12 收尾验证（证据索引）

| 事项 | 证据 |
| --- | --- |
| 接入层证书校验改严（方案 A） | `docs/verification/2026-11-12-tls-hardening.md` |
| `main` 合并门禁与真实 CI 证据 | `docs/verification/2026-11-12-合并门禁与CI证据.md` |
| 生产库旧明文房间清理工具、本地验证与执行记录 | `docs/verification/2026-11-12-prod-legacy-room-cleanup-tool.md` |
| 仓库级 `alembic check` 漂移治理 | `docs/verification/2026-11-12-schema-drift-fix.md` |
| 本地全量 CI 等价验证 | `docs/verification/2026-11-12-local-full-verification.md` |
| 实跑后端验收映射（含仓库面板缺陷） | `docs/verification/2026-11-12-live-smoke-acceptance.md` |

仍需人工完成的浏览器/AI 适配器验收项见上表标为 `Needs manual pass` 的行，
以及 `docs/verification/2026-11-12-live-smoke-acceptance.md` 的「remaining human-only checks」一节。

## 2026-11-20 安全与功能对齐门禁（离线已测 / 真网待批）

### 已在本机离线验证（详单见 `docs/现行能力对照与安全契约.md`）

- [x] **S1–S3 / R0 安全收口**：加密房附件/知识库/Hub 审批明文拦截（409）、会话作用域撤销、出站请求-回执绑定、`GroupMemberCache` 代数防竞态，以及 L1–L4 修复回归。
- [x] **WP1–WP3 / WP7 Worker**：统一规则引擎与硬禁区、`gmail.send` 参数校验/头注入拦截/`result_signature` 绑定、崩溃 `uncertain` 补签发回执（M1）、过期 Grant 重签（M2）、多账户与触发器首轮基线（L6）。
- [x] **WP4 审计与活动流**：哈希链防篡改账本、本地检查点锚定（M5）、Hub m2 `activity_events`/`activity_checkpoints`（`extra="forbid"` + EIP-191 验签）与前端 `ActivityPanel`。
- [x] **m1 / WP5 / WP6 / WP8 / WP9**：`l20c20261120` 与 `m30c20261120` PostgreSQL 17 升降级与 `alembic check`、席位暂停/恢复、EIP-191 地址绑定与可复用邀请审批、加密草稿与本地搜索、模板建议规则下发与降权。

### 仍需人类批准的现场验收（未执行，不得标为已验）

- [ ] **双机 XMTP 真网群驱逐**：移除席位及已绑定人类成员后，在真实 XMTP 网络验证 `removeMembersByIdentifiers` 生效、被移除方无法解密新消息且收到 `member_revoked`。
- [ ] **双机邀请签名与云端 `mapr join`**：使用真实 `mapr join` 完成 `requires_approval=True` 待批→批准→入群→撤权自停闭环。
- [ ] **真实 Gmail 发信与 `uncertain` 对账**：使用专用测试账号验证 OAuth `0600` 凭据发信恰好 1 封、401 报 `auth_required`、以及 `X-MAPR-Request-Id` 在 Sent 中的人工核对。
- [ ] **生产数据库迁移**：人类单独批准后在生产 PostgreSQL 执行 `k10c20261118` → `l20c20261120` → `m30c20261120`。
