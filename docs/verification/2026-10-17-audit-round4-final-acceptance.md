# MAPR 第四轮审计 — 最终集成与独立验收报告

> 执行时间：2026-10-17
> 分支：`integration/audit-round4`
> 最终 commit：`f8496d5a59a84112be6e02c00942299c5c234826`
> 基线：`integration/audit-round3` @ `5f261b4`
> Pull Request：[#5](https://github.com/wangdada8208/multi-agent-project-room/pull/5)（**OPEN，未合并**）

---

## 0. 结论摘要（先说最重要的）

| 项目 | 结果 |
|---|---|
| 三组修复合并完整性 | ✅ 全部合入，无遗漏提交 |
| `main` 是否被修改 | ✅ 未修改（本地与远端均为 `c720474`） |
| 是否触发生产部署 | ✅ 未触发（唯一一次 Deploy 为 2026-10-11 的历史记录） |
| 后端全量 pytest | ❌ **未达到 0 failed**（见 §3，30 failed / 766 passed） |
| Alembic 迁移 | ✅ 真实 PG17 上 upgrade / downgrade / 再 upgrade 全通 |
| 真实 Redis 限流与故障恢复 | ✅ 22/22 通过 + 真实宕机恢复演练通过 |
| A2A 幂等 / SSE 补偿 / 分页 | ✅ 核心正确，⚠️ 发现 2 项新缺陷 |
| WebSocket / Agent 身份 | ⚠️ 通过但存在 2 项真实缺陷与覆盖缺口 |
| 日志脱敏 | ❌ **发现 High 级真实泄露**（access log 裸 token） |
| 指标内存边界 | ✅ 严格有界（实测数据） |
| 前端 `npm test` / `npm run build` | ✅ 55/55 通过，构建成功 |
| `git diff --check` | ✅ 通过（本地与 CI 双重确认） |
| skipped 核查 | ✅ 逐项核查；CI 环境 30 个门禁未执行已明确标注 |
| 敏感信息误入 Git | ✅ 未发现真实密钥 |
| 真实 CI | ⚠️ 已运行 6 次，**backend 作业未通过**（见 §9） |

**总体判定：本轮集成不可直接合并。** 需要先关闭 §11 中的 3 个 High/Medium 缺陷，并解决 §3 的测试隔离缺陷。

---

## 1. 分支与合并完整性

`integration/audit-round4` 由 `integration/audit-round3` 创建，包含以下提交：

```
f8496d5 [CI] PG17 缺失时优雅降级并尝试安装          ← 本次审计新增
85461e5 [CI] 修复 runner 无 redis-cli 导致等待步骤失败  ← 本次审计新增
30ce425 [CI] 修复 hygiene 作业浅克隆的问题          ← 本次审计新增
af5e671 [CI] 第四轮审计独立验证工作流               ← 本次审计新增
a1fa123 fix(core): update EXPECTED_ALEMBIC_HEAD to h80c20261015
d0d7433 merge fix/audit-round4-identity
b4e73e1 merge fix/audit-round4-a2a
2d8bfd3 fix(a2a): 第四轮审计B组修复
bdad0d5 fix(runtime): 第四轮审计A组修复
fbd5142 fix(agent): Agent Unicode 身份规范化 (Round 4 C组)
```

验证方式：`git log integration/audit-round4..<分支>` 对三个修复分支均为空 → 无遗漏提交。

**审计过程新增的 4 个提交仅涉及 `.github/workflows/audit-round4-ci.yml`，未修改任何产品代码或测试。**

---

## 2. 逐项问题状态

### 2.1 A 组（runtime）— 生产安全与可观测性

| 问题 | 状态 | 验证证据 |
|---|---|---|
| Redis 键空间隔离（测试用 DB15、不误删生产键） | ✅ 已修复 | `test_audit_round4_runtime.py::TestRedisIsolation` 通过；实测 `_get_effective_redis_url()` 为 `redis://…*/15` |
| `_attempts.clear()` 不再触发 Redis flush | ✅ 已修复 | 代码审查 + 单测通过 |
| 生产环境拒绝 flush 除非显式授权 | ✅ 已修复 | 单测通过 |
| 日志脱敏（bearer / password / DSN / 私钥） | ⚠️ **部分修复，存在 1 个 High 泄露** | 见 §11-H1 |
| `%`-参数日志记录被静默丢弃 | ❌ **新发现缺陷** | 见 §11-M1 |
| 健康检查异常信息脱敏与错误码 | ⚠️ 部分修复，发现新缺陷 | 见 §11-M2 |
| 指标内存有界 | ✅ 已修复并独立验证 | 50k 唯一 label → 固定在 1000；1M 操作 RSS 仅 +192KB |

### 2.2 B 组（a2a）— 幂等、SSE 补偿、分页

| 问题 | 状态 | 验证证据 |
|---|---|---|
| 并发同幂等键只产生 1 个任务 | ✅ 已修复 | 12 路并发：12×HTTP 200，1 个 task id；SQL 直达校验 messages=1/a2a_tasks=1/deliveries=1 |
| 同键不同正文 → 409 | ✅ 已修复 | 实测返回 409 `payload mismatch` |
| 同键不同目标 → 409 | ✅ 已修复 | 实测返回 409 `target mismatch` |
| SSE 绑定失败补偿（新任务 canceled、旧任务不动、lease 释放） | ✅ 已修复 | 三种分支实测：lease 计数始终回到 0，无孤儿租约 |
| 补偿自身失败 → 任务 failed | ✅ 已修复 | 实测任务终态 `failed`，事件序列正确 |
| ListTasks 4096 扫描边界不再提前终止 | ✅ 已修复 | 7 个边界场景：无死循环、无重复、无漏取、token 稳定 |
| 无 owner 的 Agent 列出任务时 PG 类型错误 | ✅ 已修复 | `A2ATask.id == -1` → `false()`，PG 实测通过 |
| `pageToken` 超出 int8 返回 503 而非参数错误 | ❌ **新发现缺陷** | 见 §11-L1 |
| ListTasks 每个扫描行调用 `check_task`（约 10 秒/页） | ❌ **新发现缺陷** | 见 §11-M3 |

### 2.3 C 组（identity）— Agent 身份兼容

| 问题 | 状态 | 验证证据 |
|---|---|---|
| Unicode NFKC + casefold 规范化 | ✅ 已修复 | `Straße/STRASSE/strasse/StrAße`、`Σ/σ/ς`、`θ/ϑ`、全角 `ＡＢＣ/abc`、`Moſter/moster` 全部正确归并 |
| 历史账号碰撞检测 | ✅ 部分修复 | 大小写变体全部命中；⚠️ 标点变体漏检（见 §11-M4） |
| 索引化查询（避免全表扫描） | ✅ 生产 schema 成立 | 20,001 行时 `EXPLAIN` 为 Bitmap Index Scan，0.106ms，无 Seq Scan |
| 并发注册唯一性 | ❌ **新发现缺陷** | 见 §11-H3 |
| 迁移 `h80c20261015` | ✅ 正确 | 真实 PG17：回填正确、NOT NULL 生效、默认值 `''` 生效、索引被实际使用 |

### 2.4 WebSocket 可靠投递

| 问题 | 状态 | 验证证据 |
|---|---|---|
| 至少一次投递 + 重复 ACK 单赢家 | ✅ 通过 | `test_ws_reliable_delivery_linux.py` 48 项（真实 PG，2 次复跑均绿） |
| 断线重连 / resume / seq 重放 | ✅ 通过 | 含 1 个真实 websockets 客户端端到端用例 |
| 过期租约不重放、取消围栏 | ✅ 通过 | 4 个专项用例 + 并发重叠用例 |
| 跨房间 / 冒名 Agent 拒绝 | ✅ 通过 | 8 参数 + 6 参数矩阵 |
| "慢消费者内存有界" | ⚠️ **名不副实** | 见 §11-M5 |

---

## 3. 后端 pytest 全量回归 —— 未达到 0 failed ❗

### 3.1 决定性 A/B 实验（环境完全相同，唯一差异是测试路径参数）

| 运行 | 命令 | 结果 |
|---|---|---|
| A | `pytest backend/tests` | **755 passed, 0 failed, 0 skipped** |
| B | `pytest backend/tests tests` | **30 failed, 766 passed** |

两者均使用：全新 `*_test` 数据库 + `alembic upgrade head` + 真实 Redis DB15 + 独立 PG17 门禁目录，串行执行、无并发。

### 3.2 失败集合（两次独立运行完全一致）

```
13 × backend/tests/test_pg_dual_hub_linux.py
17 × backend/tests/test_pg_room_hubs_linux.py
典型错误：websockets.exceptions.InvalidStatus: server rejected WebSocket connection: HTTP 403
```

### 3.3 最小复现（3/3 次稳定复现，耗时均约 84 秒）

```bash
pytest tests backend/tests/test_pg_room_hubs_linux.py   # → 17 failed, 41 passed（连续 3 次完全一致）
```

### 3.4 已排除的因素

- ✅ 不是并发干扰（已清理全部后台任务后复跑）
- ✅ 不是数据库残留（每次运行前重建数据库并迁移）
- ✅ 不是启动时序（在 hub 就绪后人为追加 3 秒仍失败）
- ✅ 不是单一路径所致（4 个根目录测试文件单独与 hubs 同跑均通过）

### 3.5 判定

**这是一个确定性的测试隔离缺陷，位于测试基础设施层，根因尚未定位到具体代码行。**

已确认的技术事实：
- 应用在 `accept()` 之前调用 `close(code=4003)` 时，uvicorn 会把它转换为 **HTTP 403 握手拒绝**（ASGI 规范行为），因此 `handle_chat` 的所有 4003 拒绝在客户端均表现为 403。
- 当房间与权限数据存在时连接成功（已用真实数据验证）。

**由于未能定位到确定的根因，本报告不对该缺陷给出修复建议，也不声称其为产品缺陷。** 但它确实导致"全量回归 0 failed"这一硬性要求未能满足。

---

## 4. 真实 PostgreSQL 并发专项与 Alembic 迁移验证 ✅

环境：PostgreSQL 17.11（本地进程，端口 5433）、异步驱动 asyncpg 0.32。

| 验证项 | 结果 |
|---|---|
| 全新库 `upgrade head` | ✅ 19 个迁移全部执行，20 张表 |
| 单头检查 | ✅ `h80c20261015 (head)` 唯一 |
| `downgrade g70c20261012` → 再 `upgrade head` | ✅ 往返成功 |
| 重复 `upgrade head` | ✅ 幂等无副作用 |
| 迁移语义（真实数据回填） | ✅ 全角 `ＡＢＣ` → `abc`；NOT NULL 拒绝 NULL；默认值 `''` 生效 |
| 索引真实使用 | ✅ `Index Scan using ix_users_normalized_username` |
| 并发幂等（12 路） | ✅ 1 个任务 |
| CI 中也执行了同一套 Alembic 校验 | ✅ 通过（见 §9） |

---

## 5. 真实 Redis Lua 限流、故障恢复与测试隔离 ✅

环境：Redis 8.0.2（本地，端口 6380），使用独立 DB 15。

| 验证项 | 结果 |
|---|---|
| `test_audit_group_a_rate_limit.py` 真实 Redis | ✅ 22/22 通过 |
| Lua 原子计数（50 并发冻结时间戳） | ✅ 恰好 MAX_ATTEMPTS 次放行，无丢失/重复计数 |
| 真实宕机演练 | ✅ 熔断器 `closed → open`；降级期间仍严格执行 429 |
| 冷却期内不探测 | ✅ 返回 `None`，状态保持 `open` |
| 冷却后自动恢复 | ✅ 重新 `closed`，键回到 Redis 后端 |
| 测试隔离（不污染生产键空间） | ✅ 强制使用 DB15，测试结束 DB 为空 |

> 说明：在**没有启动 Redis** 的环境下运行 SQLite 全量，`test_audit_group_a_rate_limit.py` 中有 3 个用例会因 `redis is None` 而失败。这 3 个用例属于"需要真实 Redis"的路径，应在有 Redis 的环境中运行（CI 中已配置真实 Redis）。

---

## 6. A2A 幂等、SSE 补偿、ListTasks 分页专项 ✅（含 2 项新缺陷）

详见 §2.2。核心结论：

- 幂等：12 路并发下严格 1 任务，SQL 层交叉验证无重复行。
- SSE 补偿：三种失败分支均正确终态，租约计数回归基线。
- 分页：4096 边界修复正确，无死循环/重复/漏取。
- CI 环境中该文件 **31/31 全部执行、0 skipped**。

新发现缺陷（§11）：`pageToken` int8 溢出返回 503（L1）；ListTasks 最坏 10 秒/页（M3）。

---

## 7. WebSocket 可靠投递与 Agent 身份兼容专项 ⚠️

### 7.1 覆盖度实况（重要）

54 个 WebSocket 相关用例中：

| 类型 | 数量 |
|---|---|
| 真实 websockets 客户端 / 真实 uvicorn | **1**（`test_real_websocket_ack_progress_resume_and_seq_replay`） |
| FakeWebSocket / 直接调用 handler | **53** |

唯一那个真实网络用例**不覆盖**：取消、租约过期、跨连接重复 ACK 争用、冒名拒绝、慢消费者、帧大小限制。

### 7.2 结论

- 语义正确性（ACK 单赢家、重放、seq 单调、进度白名单、取消围栏）：✅ 已通过执行验证。
- 「慢消费者有界」：❌ 名不副实（见 §11-M5）。

---

## 8. 日志脱敏与指标内存边界

### 8.1 指标内存边界 ✅

| 测试 | 实测 |
|---|---|
| 50,000 组唯一 label | 三个注册表均稳定在 1000（= `max_series`） |
| 单键 200,000 次观测 | 样本数稳定在 1000 |
| 1,000,000 次操作（每次新 label） | RSS 20,412KB → 20,604KB（+192KB），序列数恒定 |
| 16 线程 × 50,000 次并发累加 | 精确 800,000.0，无丢失 |
| 最坏情况 1000×1000 | +35MB 后被硬性封顶 |

### 8.2 日志脱敏 ❌（1 个 High 泄露）

见 §11-H1、M1。

---

## 9. 真实 CI 运行记录 ⚠️

通过 GitHub PR #5 触发 `.github/workflows/audit-round4-ci.yml`（`pull_request` 事件，**无 push 触发，只读权限**）。

### 9.1 CI 安全性验证

| 检查 | 结果 |
|---|---|
| 工作流触发器 | `workflow_dispatch` + `pull_request`，**无 `push`** |
| `permissions` | `contents: read` |
| 是否有部署步骤 | 无 |
| 推送分支后是否触发 Deploy | ✅ **未触发**（`gh run list --workflow=deploy.yml` 无新增记录） |
| 是否推送 `main` | ✅ 未推送（`origin/main` 仍为 `c720474`） |

### 9.2 最新一次 CI 结果（run `39026562169`，commit `f8496d5`）

| 作业 | 结果 |
|---|---|
| Safety guard (no main push / no deploy) | ✅ pass |
| Frontend (vitest + build) | ✅ pass |
| Repository hygiene (`git diff --check` + 密钥扫描) | ✅ pass |
| Backend (real PostgreSQL + real Redis + Alembic) | ❌ **fail** |

后端作业中 **通过** 的步骤：
- Alembic 单头 / upgrade / downgrade 往返 ✅
- "真实 PG + 真实 Redis 已接通" 断言 ✅

后端作业失败明细：`55 failed, 711 passed, 30 skipped`

| 失败类别 | 数量 | 性质 |
|---|---|---|
| SSRF 类测试 `TimeoutError` | 24 | **CI runner 环境**：发生在 asyncpg 建立 PG 连接阶段，非 SSRF 逻辑；本地 70/70 通过 |
| `test_pg_*_hub*`（HTTP 403 / Invalid token） | 30 | 与 §3 的测试隔离缺陷同源 |
| `test_client_server_standard_interoperation_without_network` | 1 | 依赖前序失败后的状态 |

### 9.3 审计过程中修复的 3 个 CI 工作流缺陷

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | 浅克隆导致 `git diff --check origin/main...HEAD` 返回 128 | `fetch-depth: 0`（已本地复现同一报错并验证修复） |
| 2 | 重复执行整套 pytest 且用 `\|\| true` 吞掉失败 | 改为收集单次结果 + Summary 汇总 |
| 3 | runner 无 `redis-cli`（exit 127）、无 PG17（`cp` 失败） | 改用 Python socket 探测；PG17 缺失时优雅降级并告警 |

---

## 10. `git diff --check` ✅

| 范围 | 结果 |
|---|---|
| 工作区 `git diff --check` | ✅ 退出码 0 |
| `git diff --check integration/audit-round3 integration/audit-round4` | ✅ 退出码 0 |
| CI 中的 `git diff --check origin/main...HEAD` | ✅ pass |

---

## 11. 发现的问题清单（按严重度）

### 🔴 H1 — 访问日志泄露裸 token（High，生产环境真实泄露）

- 现象：`uvicorn.access` 直接记录 `GET /api/v1/invites/inv_xxxSECRET`，token 原样进入日志。
- 根因：`RedactingFilter` 只对可识别语法的 secret 做替换；裸 token（路径段 / `?access_token=`）不在识别范围内。
- 复现：`/tmp/audit4-logs/redaction/probe9_access_log_token.py`（退出码 1）
- 真实路由：`GET /api/v1/invites/{token}`（`backend/app/api/invites.py:91`）
- 影响：邀请链接 token（凭据）写入日志系统。

### 🔴 H2 — 测试隔离缺陷导致全量并非 0 failed（High，验收阻断）

见 §3。`pytest backend/tests` 755 全绿；`pytest backend/tests tests` 稳定 30 failed。

### 🔴 H3 — 并发注册可创建重复身份（High，身份唯一性可被绕过）

- 现象：`race_x_bot` 与 `race_x-bot` 并发注册，**两者均返回 200 并各建一个账号**（3/3 复现）。
- 根因：`users.normalized_username` **没有 UNIQUE 约束**（仅普通索引 `ix_users_normalized_username`）；唯一防线是应用层 check-then-insert。
- 独立复核：`pg_indexes` 与 `pg_constraint` 确认该索引非唯一。
- 影响：可绕过"身份唯一"这一安全前提。

### 🟠 M1 — `%` 格式参数导致整条日志被丢弃（Medium）

- 现象：`logger.info("Authorization: Bearer %s", tok)` 经脱敏后 msg 变化而 args 不变，格式化抛 `TypeError`，整条记录丢失；`raiseExceptions=True` 时 args 中的原始 secret 被打印到 stderr。
- 影响：日志数据丢失 + 可能的 secret 二次泄露。

### 🟠 M2 — 健康检查错误语义错误（Medium）

- 现象：`SELECT version_num FROM alembic_version` 失败会使 PostgreSQL 事务进入 aborted 状态，随后 `SELECT 1 FROM users` 必然失败，最终对外报告 `Database service unavailable`（实则表不存在）。
- 实测：代码路径复现，返回 `DATABASE_UNAVAILABLE`，诊断信息为 `current transaction is aborted`，**真实原因（relation "users" does not exist）被掩盖**。
- 说明：该缺陷在基线 `integration/audit-round3` 上同样存在（已实测确认），**非本轮引入**。

### 🟠 M3 — ListTasks 最坏 10 秒/页（Medium，请求放大）

- 实测：`check_task` 约 **2.43 ms/行**，`LIST_TASKS_SCAN_LIMIT=4096` → 最坏约 **10.0 秒** 数据库工作/页。
- 影响：任意租户（含低权限 Agent）可触发 10 秒级放大；同时是 A2A 分页用例约 11% 偶发失败的成因。

### 🟠 M4 — 历史账号标点变体漏检（Medium）

- 实测：存在 `legacy-dup` 时查询 `legacy_dup` **只返回自身**，未命中 `legacy-dup`。
- 根因：`expand_casefold_candidates()` 只枚举大小写变体，不覆盖标点差异；`normalized_username` 比较又因新数据已规范化而无法补位。

### 🟠 M5 — 「慢消费者有界」名不副实（Medium）

- 实测：paused 客户端仍可接收 12,009,600 字节；一个 500ms/次 的慢客户端会使整次广播耗时 501ms（`asyncio.gather` 队头阻塞）。
- 不存在应用层有界队列。

### 🟡 L1 — `pageToken` 溢出返回 503 而非参数错误（Low）

- `9223372036854775808` → 503；`9223372036854775807` → 200。应返回 `-32602 InvalidParams`。

### 🟡 L2 — `_agent_slug` 与 `app.agent.identity` 规范化不一致（Low）

- `_agent_slug` 仅 casefold，无 NFKC。当前因注册阶段已规范化而不可利用（fail-closed）。

### 🟡 L3 — conftest teardown 一次失败会污染后续（Low，测试基础设施）

- `setup_db` teardown 抛错时 `drop_all` 不执行，残留 19–20 张表，后续用例 setup 全部报 `pg_type_typname_nsp_index`。

---

## 12. Skipped 测试核查（要求 9）

### 12.1 本地（配置了独立 PG17）—— 0 skipped

使用 `MAPR_SSE_QUOTA_PG_ROOT` / `MAPR_ISOLATED_PG_ROOT` / `MAPR_ISOLATED_PG_PORT` 后：
`backend/tests` → **755 passed, 0 skipped**。原先的 20 个 skip 全部真实执行并通过（66 passed, 0 skipped 的子集验证）。

### 12.2 CI 环境 —— 30 skipped（**已明确标注未实际执行**）

| 数量 | 原因 | 未执行的关键专项 |
|---|---|---|
| 19 | `test_sse_global_quota_linux.py`：No isolated PG17 initdb | **SSE 全局配额与租约** |
| 10 | `test_audit_distributed_reliability.py`：No isolated PG17 binary tree | **分布式可靠性（租约/咨询锁/多 Hub 恢复）** |
| 1 | `test_room_sync_migration_linux.py`：requires owned /tmp PG17 cluster | **room_seq 迁移与备份恢复** |

> **明确说明：这 30 个用例在 CI 中未实际执行。** 它们在本地已真实执行并通过，但 CI 记录不含此项证据。CI 的 PG17 安装步骤未能成功（`apt-get install postgresql-17` 在该 runner 上不可用），已降级为告警而非静默通过。

### 12.3 SQLite 模式下的 69 skipped（仅作参考）

均为「需要真实 PostgreSQL / 真实 Redis」的门禁，在真实 PG + Redis 运行中已全部执行。

**未把任何 skipped 当作 passed。**

---

## 13. 敏感信息误入 Git 检查 ✅

| 检查 | 结果 |
|---|---|
| 已跟踪的 `.env` 类文件 | 仅 3 个 `.env.example`，密钥字段均为空 |
| 历史中是否曾提交 `.env` / `.pem` / `.key` / `id_rsa` / 钱包 | ❌ 无 |
| `ghp_` / `AKIA` / `sk-` / PEM 私钥扫描（HEAD 与历史） | 仅测试夹具中的占位串（如 `VERY_SECRET_KEY_BODY_XYZ`），非真实密钥 |
| `0x` 64 字节十六进制（钱包私钥形态） | 仅 Hardhat 公开测试私钥（`0xac0974…ff80` 等），非真实密钥 |
| CI workflow 中的凭据 | 仅 `test_password`（容器内一次性测试密码） |
| GitHub 密钥扫描作业 | ✅ pass |

---

## 14. 前端 ✅

| 检查 | 结果 |
|---|---|
| `npm test`（vitest） | ✅ 8 个测试文件 / **55 tests passed** |
| `npm run build`（tsc -b + vite build） | ✅ 成功，2295 modules transformed |
| CI 中的等价作业 | ✅ pass（31–50 秒） |

---

## 15. 剩余风险

1. **H2 未解决** —— 全量回归存在稳定 30 failed，测试隔离缺陷根因未定位。这是本次验收的硬阻断项。
2. **H1 未解决** —— 邀请 token 可进入访问日志；需在 `/ws` 与 REST 访问日志层面增加路径/查询脱敏策略。
3. **H3 未解决** —— 需为 `users.normalized_username` 增加数据库唯一约束（属于数据结构变更，按 AGENTS.md 规则 3 需人类批准）。
4. **M3 性能放大** —— 任意调用方可触发约 10 秒数据库工作量，属可用性风险。
5. **CI 环境不一致** —— CI runner 上 24 个 SSRF 用例因 asyncpg 建连超时失败；PG17 门禁未安装成功，30 个关键用例在 CI 中未执行。
6. **覆盖缺口** —— 54 个 WebSocket 用例中仅 1 个走真实网络。
7. **本轮新增的 4 个 CI 提交未修改产品代码**，但审计工作流本身仍依赖 runner 环境，尚不稳定。

---

## 16. 最终 commit 与交付物

| 项目 | 值 |
|---|---|
| 分支 | `integration/audit-round4` |
| **最终 commit** | **`f8496d5a59a84112be6e02c00942299c5c234826`** |
| 基线 commit | `5f261b4`（`integration/audit-round3`） |
| `main` | `c720474`（未改动） |
| PR | [#5](https://github.com/wangdada8208/multi-agent-project-room/pull/5) — OPEN / MERGEABLE / **未合并** |
| 生产部署 | 未触发 |
| 生产迁移 | 未执行 |

### 未能达成的验收项（如实记录）

- ❌ 「后端 pytest 全量回归 0 failed」—— 实际 30 failed（见 §3）
- ❌ 「真实 CI 核对成功记录」—— backend 作业 6 次运行均失败（见 §9）
- ⚠️ 「日志脱敏」—— 存在 High 级泄露（见 §11-H1）
