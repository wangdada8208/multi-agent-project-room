# Decisions

## 2026-06-17 Lightweight Auth And Task Traceability

Decision:

- Use a lightweight username/password account system for the MVP.
- Store password hashes with PBKDF2 from the Python standard library.
- Issue signed bearer tokens using the configured `MAPR_AUTH_SECRET_KEY`.
- Keep Agent registration and A2A discovery open for local adapter ergonomics.
- Require auth for room, message history, approval, and task REST APIs.
- Track A2A tasks with optional `room_id`, `source_message_id`, and `approval_id`.

Rationale:

- This gives real user identity for approvals and room creation without adding
  OAuth/SSO complexity.
- Task traceability makes the core collaboration loop inspectable from chat,
  approvals, and task panels.

Follow-up:

- Replace the default dev secret before production use.
- Introduce agent-specific tokens before exposing agent write APIs broadly.

## 2026-09-19 采纳代理间可信协作指导规范 (v0.2)

### 决策背景

系统已经具备基础的用户登录、WebSocket 房间广播与 A2A 对话协议。
在多名人类用户携带各自智能体进行协作的场景下，连接成功并不代表建立了可信协作。
现有的 Bearer 令牌仅能验证用户身份，无法证明其对特定智能体实例的所有权。
也无法证明其具备特定会话的调用授权。
此外，单纯依赖自然语言文本中的共识标记，无法作为可靠的业务承诺。
系统亟需一套明确的授权边界、数据防护与执行控制模型。

### 决策内容

1. 正式采纳 `docs/项目指导意见-代理间可信协作.md` 作为后续多智能体协作演进的核心设计指导。
2. 明确将远端仓库的 `origin/main`（提交哈希 `f1af097`）确立为阶段验收的参考基线。本地未提交的功能模块另行管理。
3. 选定虚构日历协商作为可信协作的首选最小验证场景。在通过专门评审前，系统禁止调用真实日历软件。
4. 确立严格的数据安全边界。外部智能体发来的消息一律视作不可信输入。传出数据必须经过白名单收敛，仅交换获批的空闲时间段。
5. 建立任务取消与底层执行进程的强联动机制。取消后的迟到模型响应必须予以丢弃，不得存盘与广播。
6. 分阶段稳步推进改造。按照 Phase 0 统一基线、Phase 1 模拟通道验证、Phase 2 有限模型协作的顺序实施。

### 决策依据

该决策从根本上防范了跨智能体交互中的越权调用与隐私泄露风险。
避免将未经审查的提示词误当做主人的授权指令。
通过引入虚构排期场景，团队可以在零真实副作用的前提下验证双机协作链路。

## 2026-09-22 新房间改为成员端端到端加密

### 决策背景

现有房间把聊天正文写入 `messages.content`。TLS 只保护到 Hub，Hub 和数据库都能阅读原文。
若以后作为公开产品，平台不应能够阅读房间正文。

XMTP 的加密群聊仍然经过投递服务器。服务器保存密文。官方说明网络节点和接入方应用都无法解密。能解密的是当前群成员，包括加入群的代理进程。

### 决策内容

1. 新房间采用 XMTP group 作为正文通道。官方 Node SDK `@xmtp/agent-sdk` 运行在独立成员进程，不嵌入 FastAPI。
2. Hub 继续负责账号、成员关系、审批状态和 group id 绑定。Hub 不保存加密房间的聊天正文，也不保管钱包私钥。
3. 2026-09-23 起，用户可见的历史明文房间删除，不再保留可读入口。`_agent_` 内部通道保留。生产库未清理。
4. `@` 叫醒和轮次调度改到能够解密的成员进程。A2A 仍只负责任务发现和任务回传。
5. 已完成的落库防护见 `docs/superpowers/plans/2026-09-22-xmtp-e2e.md`。下一位要做的收发闭环见 `docs/superpowers/plans/2026-09-23-xmtp-member-send.md`。
6. 本决策批准在功能分支上实现该计划。本决策不批准合并 `main`，也不批准在生产库执行迁移。

### 决策依据

成员端加密能让平台读不到新房间正文。
把调度留在 Hub 则要求 Hub 继续阅读明文，这两件事不能同时成立。
因此正文通道换成 XMTP，控制规则改由群内协调者执行。旧的授权、取消和最小披露规则仍然有效。

## 2026-09-23 删除用户可见的历史明文房间

### 决策背景

产品不再向用户提供历史明文房间。

### 决策内容

1. 2026-09-23 起，用户可见的历史明文房间删除，不再保留可读入口。
2. 创建房间接口只接受 `transport="xmtp"`。
3. 前端界面移除「历史明文房间」标记与 hub 发送逻辑。
4. 本地数据库中用户可见的 `transport=hub` 房间及其关联子表行全部删除。
5. `_agent_` 内部通道保留。
6. A2A 任务上的 `source_agent="hub"` 为系统名称，保持不变。
7. 生产库未清理。合并 `main` 与生产库迁移仍须单独审批。

## 2026-10-01 阶段 C 协调者与计分板决策

### 决策内容

1. C-Q1：执行者收到任务时无需主人逐次审批。主人在 `policy.json` 中给协调者地址配置 `task.run` 范围即视为长期授权；未配置则自动拒发 `out_of_scope`。
2. C-Q2：协调者验收模型复用现有的 `MEMBER_MODEL_URL` 与 `MEMBER_MODEL_API_KEY`。
3. C-Q3：计分板在阶段 C 仅保存在本机账本并在本机控制台显示，不上报 Hub 服务端，不改动数据库表结构。

## 2026-10-01 阶段 D 真实连接器决策

### 决策内容

1. D-Q1：日历服务首选 Google Calendar API（仅调用 freeBusy 接口，禁止读取事件详情与与会者列表），保留本地日历连接器作为安全回退。
2. D-Q2：邮箱服务支持邮件凭据检索（范围 `email.receipt`，限定查询如 12306 客票，正文提取必须经过隐私脱敏并截断至 500 字）。
3. D-Q3：凭据存储于本机 `.state/credentials/`，强制校验 `0600` 权限，权限不安全时连接器拒绝加载。严禁提交 git、严禁进群、严禁上报 Hub。
4. D-Q4：上线真实外部凭据前在受控环境运行安全断言测试，严防私人数据与敏感联系人外泄。

## 2026-10-01 阶段 E 代理自助接入与浏览器私钥防护决策

### 决策内容

1. E-Q1：邀请令牌存储于 Hub 服务端数据库，新增 `room_invites` 数据表（包含 `token`、`room_id`、`created_by`、`proposed_scopes`、`expires_at`、`used_at` 字段）。提供房主创建邀请与代理兑换入群接口。该项属于数据库表结构变更，须经人类确认批准后实施数据库迁移。
2. E-Q2：只读观察者网关在 `policy.json` 中配置空授权范围。观察者不参与敏感数据披露，控制台隐藏请求发起表单，前端加密房间隐藏文本发送框，仅接收公开摘要。
3. E-Q3：浏览器端 XMTP 本地私钥采用 WebCrypto PBKDF2（310,000 次迭代）与 AES-GCM 进行口令加密存储，杜绝浏览器明文留存私钥。首次进入加密房间设置口令，之后每次解锁使用。

## 2026-10-01 阶段 F 对外接入（Connect with MAPR）决策

### 决策内容

1. F-Q1：第三方 Web 应用授权在用户本机主人网关（`http://127.0.0.1:8787/connect/authorize`）发起与确认。Hub 服务端不保存第三方授权令牌或用户个人数据，保证端到端隐私隔离。
2. F-Q2：授权通过后，网关使用本机 XMTP 身份私钥签发单次有效凭据 `Grant`，并通过标准 Web 消息（`postMessage`）或安全重定向（`redirect_uri`）将凭证与脱敏数据返回给调用方。
3. F-Q3：对外接入目前仅支持 `calendar.free_busy` 与 `email.receipt` 两种只读脱敏范围，杜绝直接开放外部写操作或账户全量访问。

## 2026-10-17 第四轮审计高危项的定性更正（H3 措辞）

### 事实核对（协作室-文档 2026-10-17 查证，不是拍板）

1. `backend/app/auth/routes.py` 第 44 行调用 `normalize_unicode_casefold`（NFKC 加 casefold），第 68 至 76 行提交失败时靠 `IntegrityError` 回 409。`username` 列本身有唯一约束。
2. `backend/alembic/versions/h80c20261015_add_user_normalized_username.py` 第 48 行建的是普通索引 `unique=False`。`normalized_username` 没有唯一约束。
3. 所以：完全同名、大小写变体、全角变体都注册不出第二个人。审计复现的 `race_x_bot` 与 `race_x-bot` 差一个下划线，归一化不处理标点，这条路能建出两个账号。
4. 同一个问题，审计报告写成了两条：`2026-10-17-audit-round4-final-acceptance.md` 第 11 节把 H3 写成「并发注册可创建重复身份」，第 2.3 节和第 11 节 M4 又写成「标点变体漏检」。**两条是同一个根因，不是两个缺陷。** 修复单和验收报告合并计数时不要重复算。
5. 组长 2026-10-17 在群里的更正与代码一致：H3 的真实性质是「标点变体判重不严」，不是「同名也能量产」。审计原文的严重度措辞偏重。

### 决策内容

1. 第四轮审计报告原文不改。更正以本节和 `docs/verification/2026-10-17-xmtp阶段核对.md` 为准，保留历史记录。
2. H3 与 M4 合并为一项跟踪，合并后的名称用「标点变体身份判重」。
3. 修这一项要给 `users.normalized_username` 加唯一约束，属于数据库结构变更。按 AGENTS.md 规则 3，**必须主人批准**。截至 2026-10-17 未获批准，状态为未开始，不得写迁移脚本。
4. 如果获批，先在本机和测试库做只读预检；预检发现已有重复行就停手报组长，不动生产库。

> 后续状态（2026-11-12 补记）：本节第 3 条的「未获批准、不得写迁移脚本」是 2026-10-17 当时的历史状态。
> 该变更后来已获人工批准，随迁移 `i90c20261017`（`users.comparison_username` + 唯一索引
> `ux_users_comparison_username`）在 2026-10-19 于生产执行并通过独立验收，
> 见 `docs/verification/2026-10-19-生产迁移与发布密钥门禁修复.md`。本节原文保留作为决策历史。

## 2026-11-12 主人一次性批准全部剩余收尾事项

### 背景

2026-11-12，主人对 2026-10-19 之后仍未关闭的事项回复「批准，全部批准，把还没走完，卡着的剩余事项全部收尾」。
该批准覆盖 `AGENTS.md` 规则 3 中下列高风险操作：仓库/分支设置变更、向 `main` 合并代码、
生产库数据清理、以及为收尾所需的后续生产操作。按规则 4，本次批准仅授权收尾清单内的操作，
不扩权读取外部私有数据，也不放宽任何校验。

### 决策内容

1. **接入层证书校验**：采用 `docs/verification/2026-10-17-接入层证书校验调查.md` 的方案 A ——
   默认使用系统信任库校验，不提供「无条件不校验」开关；只有显式传入 CA 证书路径或
   SHA-256 证书指纹时才对那一份证书放开。同时加入证书到期（30 天内）提醒。
   顺带移除 `run_live_verification.py` 中写入 git 的账号口令，并截断登录失败的响应原文。
2. **main 合并门禁**：保留既有 4 项必需状态检查与 `strict`，补上 `enforce_admins=true`、
   `required_approving_review_count=1`、`require_last_push_approval=true`，禁止 force push 与删除。
   `deploy.yml` 的 `test` 不加入 PR 必需检查（该工作流没有 `pull_request` 触发器，加入会让所有 PR 永久卡住），
   其作用由工作流内 `build.needs=test`、`deploy.needs=build` 结构化保证。
   证据见 `docs/verification/2026-11-12-合并门禁与CI证据.md`。
3. **生产库旧明文房间清理**：沿用 `2026-09-23-delete-legacy-rooms.md` Task 3 的删除范围
   （`transport='hub'` 且 id 不以 `_agent_` 开头的房间及其子表行），保留 `_agent_` 内部通道与所有 xmtp 房间。
   执行前必须先做只读 `check`、必须先做 `pg_dump` 备份、必须在单个事务内完成并做前后计数校验；
   删除范围由数据库目录动态发现，不写死表清单。工具与本地验证见
   `docs/verification/2026-11-12-prod-legacy-room-cleanup-tool.md`。
4. **仓库级 `alembic check` 漂移**：只通过让 ORM 元数据与既有迁移对齐来消除，**不新增迁移**
   （生产库已停在 `i90c20261017`，新增迁移会造成 main 与生产版本不一致）。
   若某处差异必须改表结构才能消除，则如实保留并记录，不擅自改生产 schema。
5. **文档与验收同步**：`PLAN.md`、`ROADMAP.md`、`CLAUDE.md`、`总路线与执行规则.md` 第 8 节、
   `ACCEPTANCE_CHECKLIST.md` 统一更新为 2026-11-12 的实际状态；
   无法由程序替代的浏览器手工验收项，按实测结果如实标注，不假报通过。

### 依据

- 代码与 git 是事实标准（AGENTS.md 规则 1）；多份状态文档互相矛盾，以 `main` 的提交与真实运行结果为准。
- 取消与状态联动（规则 5）：任何一步未真正执行成功，必须如实汇报局部结果，不得写「已完成」。
- 密钥不进 git（规则 4）：生产密钥只留在服务器本机，收尾脚本不打印数据库口令、房间原文或聊天正文。

## 2026-11-18 接入邮箱验证码注册、邮箱登录与 Google 登录

### 背景

现有网站仅支持「用户名 + 密码」注册登录。为方便人类用户在 `https://hub.wangdada8208.xyz` 快速注册与登录，在独立功能分支 `feat/email-and-google-auth` 上研发接入邮箱验证码注册、邮箱密码/验证码登录及 Google 一键登录。

### 决策内容

1. **数据库扩展（迁移 `k10c20261118`）**：在 `users` 表增加可空列 `email`、`normalized_email`（唯一索引 `ux_users_normalized_email`）与 `email_verified_at`，并新增 `user_oauth_accounts` 表绑定第三方 `sub`；保留已有用户名与 Agent 账号零影响。
2. **多通道发信与 Cloudflare Worker 转发**：内置 `cloudflare_worker`、`resend`、`smtp`（及仅限 dev/test 的 `console`）四种发信通道，并在 `scripts/cloudflare-auth-worker/` 提供免费版 Cloudflare Worker 脚本，同时用于北京服务器稳定代理缓存 Google JWKS 公钥及转发发信请求（注：Cloudflare 免费 Email Routing 仅支持自有已验证地址，向任意用户发信需 Workers Paid 或搭配 Resend 免费额度）。
3. **安全与权限隔离**：Hub 仅校验 Google `id_token`，不请求也不存储任何 Google Calendar/Gmail OAuth 令牌；严格禁止 `agent` 账号走邮箱/Google 入口，且 Google 自动合并仅对已验证邮箱的活跃 `human` 账号放行。
4. **发布红线**：本次在功能分支完成开发与本地/临时 PostgreSQL 验证；向 `main` 合并、配置生产密钥及在生产库执行 `k10c20261118` 迁移仍须由人类单独批准后执行。

详见 `docs/adr/2026-11-18-email-and-google-auth.md`。

## 2026-11-20 统一本机规则引擎、Gmail 写动作闭环与 m1/m2 控制面演进

### 背景

对齐多智能体协作体验并补齐高危安全缺口：加密房附件/知识库边界、席位/人类撤销闭环、写动作执行前授权、可复用云端邀请、多账户触发与可验证审计流。

### 决策内容

1. **本机 worker 为授权与执行唯一权威**：引入 `rulesEngine.ts`、`actionSchemas.ts`、`outgoingRequests.ts`、`result_signature`（MAPR1-RESULT）与 `ConsentQueue` 可判别状态机；拒绝引入第三方云端密钥/正文托管。
2. **首个第三方写动作限定为 Gmail 发信（`gmail.send`）**：强制 `0600` 凭据校验、RFC822 `X-MAPR-Request-Id` 关联及「至多一次执行 + `uncertain` 人工对账」语义；支付、银行、密码/卡托管及 `data.export_all` 列为硬禁区，后端与 worker 双侧拦截。
3. **两步元数据迁移（本地待批准执行生产迁移）**：`l20c20261120`（m1）与 `m30c20261120`（m2）仅存储身份/成员/邀请/安全元数据与签名检查点；所有新列可空或带默认值，不含正文或动作参数。
4. **Hub→worker 建议降权**：Hub 模板与 `rooms.settings_json` 下发的 `"allow"` 一律在 worker 边界降格为 `"ask"`；`team_config_markdown` 仅作为非授权背景提示注入模型上下文。

### 依据与约束

- 保持本地开发态（未提交、未合并 `main`、未部署生产）；所有离线单测与本地 PG17 迁移测试均已留档于 `docs/verification/2026-11-20-*.md`，真网 XMTP 与真实 Gmail 发信须经人类单独批准后再行现场验收。
- 详情见 `docs/现行能力对照与安全契约.md`。
