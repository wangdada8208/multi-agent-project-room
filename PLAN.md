# Multi-Agent Project Room — 项目规划书

> 让多个人类与多个 AI Agent 在同一项目空间中协作开发软件
>
> 版本: v2.0 | 更新: 2026-06-15

---

## 0. 文档说明

### 0.1 本文档的用途

本文档是项目的**总体规划书**。同时面向人类和 AI Agent：

- **人类**用来看进度、做决策、审批
- **AI Agent**（Claude、Codex）用来理解分工、认领任务、按步骤执行

### 0.2 核心原则

| 原则 | 说明 |
|---|---|
| **仓库是真相源** | Agent 优先读仓库和文档，不依赖聊天记录 |
| **先讨论再执行** | 重大变更先出 Proposal，人类审批后再动手 |
| **沟通优先** | Agent 完成模块后在聊天室报告，不要闷头干 |
| **一人一模块** | 每个模块由一个人全包（后端 API + 前端 UI），不交叉 |
| **保持简单** | MVP 不做复杂架构，够用就行 |
| **Vibe Coding** | 快速验证协作模式，速度优先于完美 |

### 0.3 模块总览

```
┌──────────────────────────────────────────────────┐
│                  Frontend                          │
│              [Codex 负责全部]                       │
│  聊天界面 │ Agent面板 │ 知识库 │ 审批 │ Git 面板   │
│         WebSocket ←→ REST API                     │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────┴───────────────────────────┐
│  Claude 后端                   Codex 后端         │
│                                                   │
│  ⑧ Infrastructure  ───── 地基                     │
│  ① Gateway          ───── 入口    ③ Agent         │
│  ② Chat             ───── 管道    ⑤ Knowledge     │
│  ④ A2A Hub          ───── 核心    ⑥ Repository    │
│  ⑦ Approval 后端    ───── 流程    ⑦ Approval 前端  │
└───────────────────────────────────────────────────┘
```

---

## 1. 模块划分

### 1.1 两人分工总表

| # | 模块 | 谁负责 | 包什么 | 类型 |
|---|---|---|---|---|
| ⑧ | **Infrastructure** | **Claude** | PostgreSQL / Redis / Docker / CI / 配置 | 地基 |
| ① | **Gateway** | **Claude** | 统一入口、认证、路由、限流 | 入口 |
| ② | **Chat** | **Claude** | WebSocket、房间管理、消息持久化 | 管道 |
| ④ | **A2A Hub** | **Claude** | Agent Card、JSON-RPC、任务路由、发现 | 核心 |
| ⑦-a | **Approval 后端** | **Claude** | 审批 API、状态管理、通知 | 流程 |
| — | **Frontend 架构** | **Codex** | Vite 骨架、路由、组件库、状态管理 | 前端 |
| ③ | **Agent** | **Codex** | Agent API + Agent 面板 UI | 全栈 |
| ⑤ | **Knowledge** | **Codex** | 文档 API + 知识库 UI | 全栈 |
| ⑥ | **Repository** | **Codex** | Git API + Git 面板 UI | 全栈 |
| ⑦-b | **Approval 前端** | **Codex** | 审批卡片 UI、审批面板 | 前端 |

### 1.2 模块的完整形态

每个模块由一个人**全包**，从数据库到 API 到前端页面：

```
Codex 拿 Knowledge（知识库）为例：
──────────────────────────────────
backend/knowledge/          ← 后端 API（Codex 写）
├── models.py                DB 表定义
├── routes.py                CRUD API 端点
└── service.py               搜索逻辑

frontend/src/components/knowledge/  ← 前端 UI（Codex 写）
├── DocList.tsx              文档列表
├── DocViewer.tsx            文档阅读器
└── SearchBar.tsx            搜索框

──────────────────────────────────
一个人包干，不用跟另一个人对接口。
```

### 1.3 文件所有权

```
backend/
├── app/
│   ├── gateway/          ← Claude
│   ├── chat/             ← Claude
│   ├── agent/            ← Codex
│   ├── a2a/              ← Claude
│   ├── knowledge/        ← Codex
│   ├── repository/       ← Codex
│   ├── approval/         ← Claude
│   └── core/             ← Claude (Infrastructure)
│
├── alembic/              ← Claude
├── Dockerfile            ← Claude
├── requirements.txt      ← 两人都改（加依赖时）
│
frontend/                 ← Codex 全部
├── src/
│   ├── hooks/             ← Codex
│   ├── components/        ← Codex
│   │   ├── chat/          ← Codex（连 Claude 的 WS）
│   │   ├── agent/         ← Codex
│   │   ├── knowledge/     ← Codex
│   │   ├── repository/    ← Codex
│   │   ├── approval/      ← Codex
│   │   └── shared/        ← Codex
│   ├── stores/            ← Codex
│   ├── pages/             ← Codex
│   └── types/             ← Codex

docker-compose.yml         ← Claude
Caddyfile                  ← Claude
.env.example               ← Claude
```

### 1.4 Git 分支策略

```
main                    → 稳定分支，合并需审批

claude/                 → Claude 的模块分支
├── claude/infra        ← ⑧
├── claude/gateway      ← ①
├── claude/chat         ← ②
├── claude/a2a          ← ④
└── claude/approval     ← ⑦

codex/                  → Codex 的模块分支
├── codex/frontend      ← Frontend 骨架
├── codex/agent         ← ③
├── codex/knowledge     ← ⑤
└── codex/repository    ← ⑥
```

---

## 2. 执行时间线

### 2.1 总览

```
周次    Claude                         Codex
──────────────────────────────────────────────────────────
W1    ⑧ Infra + ① Gateway + ② Chat    Frontend 骨架
      后端跑起来                        UI 框架就绪
──────────────────────────────────────────────────────────
W2    ④ A2A Hub（最重）                 ③ Agent 全栈
      A2A 核心完成                      Agent 可注册、面板可看
──────────────────────────────────────────────────────────
W3    ⑦ Approval 后端                   ⑤ Knowledge 全栈
      收尾前面模块                      ⑥ Repository 全栈
──────────────────────────────────────────────────────────
W4    联调 A2A ↔ 所有模块               ⑦ Approval 前端
      部署上线                          UI 打磨
──────────────────────────────────────────────────────────
W5    ── 完善、修 bug、写文档 ──
```

### 2.2 详细周计划

---

## W1 — 地基 + 骨架

### Claude — ⑧ Infrastructure + ① Gateway + ② Chat

**目标：** 后端能跑起来、数据库能连上、聊天室能发消息

**Tasks:**

⑧ Infrastructure

> Codex 已实现: 后端骨架、Config、Main、CORS、Room API、WS Chat（in-memory）
> 需继续: PostgreSQL 持久化、Docker、Redis、Alembic

- [x] 初始化 `backend/` 目录结构（含所有模块占位）
- [x] 创建 `app/config.py`（Pydantic Settings，从 `.env` 读取）
- [-] 创建 `app/core/database.py`（已创建，in-memory → 需替换为 SQLAlchemy async）
- [ ] 创建 `app/core/redis.py`（Redis 连接）
- [x] 创建 `app/main.py`（FastAPI 应用入口 + lifespan）
- [x] 配置 CORS
- [ ] 配置 Alembic 迁移
- [ ] 创建 `users` 表 + `rooms` 表（Alembic 迁移）
- [ ] 编写 `Dockerfile`（backend）
- [ ] 编写 `docker-compose.yml`（postgres + redis + backend）
- [x] 创建 `.env.example`
- [x] 创建启动脚本 `scripts/start.sh`
- [x] 配置 `.gitignore`

① Gateway

- [ ] 创建 `app/gateway/` 模块
- [ ] 统一路由挂载（所有模块的 router 汇聚到 main.py）
- [ ] 全局异常处理
- [ ] 健康检查端点 `GET /health`

② Chat

- [ ] 创建 `app/chat/` 模块
- [ ] `ConnectionManager`（按房间管理 WebSocket）
- [ ] `messages` 表（Alembic 迁移）
- [ ] WebSocket 处理器 `/ws/chat/{room_id}`
- [ ] 消息接收 → 持久化 → 广播
- [ ] 心跳（ping/pong，30s）
- [ ] `GET /api/v1/rooms/{id}/messages`（分页）
- [ ] 支持 msg_type: text / system / task / proposal / report / approval_request

**验收：**

```
✅ docker compose up 一键启动
✅ localhost:8000/docs 打开 Swagger
✅ GET /health → {"status": "ok"}
✅ WebSocket 连接成功，消息发送 + 广播 + 持久化
```

---

### Codex — Frontend 骨架

**目标：** 前端项目就绪，路由能跑，聊天页面跟后端 WS 连上

**Tasks:**

- [ ] Vite 初始化 `frontend/` 项目
- [ ] 配置 TypeScript（strict mode）
- [ ] 配置 Tailwind CSS 4.x
- [ ] 集成 shadcn/ui
- [ ] 配置 React Router（登录页 + 房间页）
- [ ] 配置 TanStack Query（API 客户端）
- [ ] 创建 Zustand store 骨架（auth / chat / room）
- [ ] 基础布局组件（Sidebar + Header + 主内容区）
- [ ] 房间列表组件
- [ ] 聊天消息列表（MessageList）
- [ ] 消息输入框（MessageInput）
- [ ] 消息气泡组件（区分 human / agent / system）
- [ ] `useWebSocket` Hook
- [ ] 连接 Claude 的 WebSocket 后端
- [ ] 验证：发消息 → 广播 → 刷新后历史仍在
- [ ] 登录页（UI 占位）
- [ ] 前端 Docker 构建
- [ ] 编写 `frontend/Dockerfile`

**验收：**

```
✅ localhost:5173 能打开
✅ 房间列表展示
✅ 聊天框输入文字 → 走 WebSocket 发送
✅ 收到的消息展示在聊天框
✅ 刷新后历史消息还在
```

---

## W2 — A2A + Agent

### Claude — ④ A2A Hub

**目标：** Agent 之间能通过 A2A 协议发现彼此、派发任务、拿结果

**Tasks:**

A2A Server

- [ ] 创建 `app/a2a/` 模块
- [ ] `AgentCard` 模型定义（符合 v0.3 规范）
- [ ] `GET /a2a/.well-known/agent-card`（Agent Card 端点）
- [ ] `POST /a2a`（JSON-RPC 统一入口）
- [ ] 方法: `tasks/send` — 接收任务
- [ ] 方法: `tasks/get` — 查询任务状态
- [ ] 方法: `tasks/cancel` — 取消任务
- [ ] 方法: `tasks/list` — 列出任务
- [ ] 方法: `message/send` — 推消息到聊天室
- [ ] 方法: `agent/getCard` — 查其他 Agent 的 Card
- [ ] 方法: `agent/list` — 列出在线 Agent

A2A Client

- [ ] `A2AClient` 类（httpx 异步，调用远程 Agent）
- [ ] `A2AClientPool`（连接池，按 agent_id 缓存）
- [ ] 远程 Agent Card 获取 + 缓存

Task Manager

- [ ] `A2ATaskManager`（任务生命周期管理）
- [ ] 状态: submitted → working → completed / failed / canceled
- [ ] 本地任务处理 + 远程转发
- [ ] `a2a_tasks` 表 + 持久化

Agent Discovery

- [ ] `AgentDiscovery` 服务
- [ ] Agent 注册流程
- [ ] 定期健康检查 → 标记离线
- [ ] 按能力查询可用 Agent

Chat ↔ A2A Bridge

- [ ] 聊天室新消息 → 触发 A2A 任务委派
- [ ] A2A 任务完成 → 推回聊天室
- [ ] `A2AService.send_to_room()`
- [ ] `A2AService.delegating_task_via_a2a()`

**验收：**

```
✅ GET /a2a/.well-known/agent-card 返回 Agent Card
✅ POST /a2a tasks/send 可提交任务
✅ A2A 任务结果能 push 到聊天室
✅ Agent 健康检查能标记离线
```

---

### Codex — ③ Agent 全栈

**目标：** Agent 能注册到系统，人类能在面板看到 Agent

**Tasks:**

后端 — `app/agent/`

- [ ] `AgentCard` DB 表（Alembic 迁移）
- [ ] `users` 表增加 `user_type`（human / agent）
- [ ] `POST /api/v1/agents/register` — 注册 Agent
- [ ] `GET /api/v1/agents` — 列出在线 Agent
- [ ] `GET /api/v1/agents/{id}` — Agent 详情
- [ ] Agent 在线状态跟踪（通过 WebSocket 心跳）

前端 — Agent 面板

- [ ] Agent 列表侧栏组件
- [ ] Agent 在线/离线/忙碌状态指示器
- [ ] Agent 能力标签展示
- [ ] Agent 头像标识（区分 Claude 和 Codex）
- [ ] Agent 详情弹窗

**验收：**

```
✅ 两个 Agent 可注册到房间
✅ 面板显示谁在线、谁在忙、有啥能力
✅ Agent 发消息显示 Agent 身份和头像
```

---

## W3 — 审批 + 知识库 + Git

### Claude — ⑦ Approval 后端

**目标：** Agent 能提交审批，人类能批准/拒绝

**Tasks:**

- [ ] `approvals` 表（Alembic 迁移）
- [ ] 创建 `app/approval/` 模块
- [ ] `POST /api/v1/rooms/{id}/approvals` — 创建审批
- [ ] `GET /api/v1/rooms/{id}/approvals` — 列审批
- [ ] `POST /api/v1/approvals/{id}/approve` — 批准
- [ ] `POST /api/v1/approvals/{id}/reject` — 拒绝
- [ ] 审批事件 → WebSocket 通知房间
- [ ] 审批通过 → 通知申请者
- [ ] 定义需审批的操作类型

**验收：**

```
✅ Agent 能提交审批请求
✅ 人类在聊天室看到审批通知
✅ 批准/拒绝后 Agent 收到通知
✅ 审批历史可查
```

**同时 — 收尾前面的 Claude 模块：**

- [ ] W1 模块补测试
- [ ] W2 A2A 补错误处理
- [ ] 各模块加日志

---

### Codex — ⑤ Knowledge + ⑥ Repository 全栈

**目标：** 文档能上传搜索，Git 状态能在面板查看

**Tasks (Knowledge):**

后端 — `app/knowledge/`

- [ ] `knowledge_docs` 表（Alembic 迁移）
- [ ] `POST /api/v1/rooms/{id}/docs` — 上传文档
- [ ] `GET /api/v1/rooms/{id}/docs` — 列出文档
- [ ] `GET /api/v1/rooms/{id}/docs/{doc_id}` — 读文档
- [ ] `GET /api/v1/rooms/{id}/docs/search?q=xxx` — 关键词搜索（ILIKE）

前端 — 知识库面板

- [ ] 文档列表组件
- [ ] 文档阅读器（Markdown 渲染）
- [ ] 搜索框 + 搜索结果
- [ ] 上传文档入口

**Tasks (Repository):**

后端 — `app/repository/`

- [ ] `GitService` 类（封装 git 命令）
- [ ] `GET /api/v1/rooms/{id}/git/status`
- [ ] `GET /api/v1/rooms/{id}/git/log`
- [ ] `GET /api/v1/rooms/{id}/git/branch`
- [ ] `GET /api/v1/rooms/{id}/git/diff`
- [ ] Git 事件记录到数据库

前端 — Git 面板

- [ ] 当前分支展示
- [ ] 提交历史列表
- [ ] 变更文件列表
- [ ] 谁提交了什么

**验收：**

```
✅ 上传 Markdown → 列表可见
✅ 关键词搜索能搜到文档
✅ 能查看当前分支和最新提交
✅ 能查看变更文件
```

---

## W4 — 联调 + 部署

### 任务分配

**Claude — A2A ↔ 所有模块联调**

- [ ] A2A Hub 与 Agent 模块对接（Claude ↔ Codex 模块）
- [ ] A2A Hub 与 Knowledge 模块对接
- [ ] A2A Hub 与 Repository 模块对接
- [ ] A2A Hub 与 Approval 模块对接
- [ ] 端到端测试：聊天室消息 → A2A 派任务 → 另一个 Agent 处理 → 结果回聊天室
- [ ] 修复联调发现的问题
- [ ] 部署：服务器环境准备
- [ ] 生产 docker-compose.yml 完善
- [ ] Caddy HTTPS 配置
- [ ] GitHub Actions CI/CD

**Codex — ⑦ Approval 前端 + UI 打磨**

- [ ] 审批请求卡片组件（标题 + 描述 + 状态 + 批准/拒绝按钮）
- [ ] 审批面板（待处理 / 已处理）
- [ ] 全页面 UI 一致性检查
- [ ] 暗黑模式（可选）
- [ ] 加载状态 / 空状态 / 错误状态处理
- [ ] 前端 Docker 构建优化

**两人一起 — 部署上线**

- [ ] 服务器部署
- [ ] 域名指向服务器
- [ ] Claude 适配器连接测试
- [ ] Codex 适配器连接测试
- [ ] 两个 Agent A2A 互通验证

### 验收

```
✅ https://hub.你的域名 可访问
✅ 登录 → 进房间 → 发消息
✅ Claude 和 Codex 适配器连上
✅ 聊天室 @Claude → Claude 回复
✅ 聊天室 @Codex → Codex 回复
✅ Claude → A2A → Codex 派任务成功
✅ Codex → A2A → Claude 派任务成功
✅ 知识库可搜索
✅ Git 面板可查看
✅ 审批流程完整
```

---

## 3. 模块接口约定

Codex 写的模块需要对外提供 API，Claude 写的 A2A Hub 需要调用它们。
以下是固定的接口约定，两边按这个来：

### 3.1 通用规范

```
基础路径:  /api/v1
请求体:    JSON
响应格式:  {"data": ..., "error": null} 或 {"data": null, "error": "..."}
认证:      MVP 阶段暂不强制（预留 Header: Authorization: Bearer <token>）
```

### 3.2 Codex 模块需提供的 API

```
③ Agent:
  GET    /api/v1/agents              →  Agent 列表 [{id, name, status, capabilities}]
  GET    /api/v1/agents/{id}         →  Agent 详情
  POST   /api/v1/agents/register     →  注册 {name, capabilities}

⑤ Knowledge:
  GET    /api/v1/rooms/{id}/docs              →  文档列表
  GET    /api/v1/rooms/{id}/docs/{doc_id}     →  文档内容
  GET    /api/v1/rooms/{id}/docs/search?q=xx  →  搜索
  POST   /api/v1/rooms/{id}/docs              →  上传 {title, content}

⑥ Repository:
  GET    /api/v1/rooms/{id}/git/status   →  {branch, changes, last_commit}
  GET    /api/v1/rooms/{id}/git/log      →  [{hash, author, message, date}]
  GET    /api/v1/rooms/{id}/git/diff     →  变更详情
```

### 3.3 Claude 模块需提供的 API / WebSocket

```
① Gateway / ② Chat:
  WebSocket: /ws/chat/{room_id}?token=xxx
  GET:       /api/v1/rooms/{id}/messages?page=1&limit=50

④ A2A Hub:
  POST:      /a2a  (JSON-RPC 统一入口)
  GET:       /a2a/.well-known/agent-card

⑦ Approval:
  GET:    /api/v1/rooms/{id}/approvals
  POST:   /api/v1/rooms/{id}/approvals
  POST:   /api/v1/approvals/{id}/approve
  POST:   /api/v1/approvals/{id}/reject
```

---

## 4. A2A 协作流程

### 4.1 两个 Agent 怎么通过 A2A 配合

```
场景：Codex（Knowledge 模块）需要了解 Git 状态

Codex → (A2A) → A2A Hub:
  POST /a2a
  { "method": "tasks/send",
    "params": { "query": "获取当前 Git 状态",
                "target_agent": "claude" }}

A2A Hub（Claude 的模块）→ 路由给 Repository（Codex 的模块）:
  不需要，Repository 是 Codex 写的，A2A 只是通道

A2A Hub → (A2A) → Codex:
  { "result": { "status": "completed",
                "artifacts": [{ "type": "text",
                                "content": "branch: main, 最新提交: ..." }]}}
```

### 4.2 什么时候用什么

```
聊天室（WebSocket）:  人类可见的沟通
  - 报告模块完成
  - 提出 Proposal
  - 请求审批
  - 人类 @Agent

A2A（JSON-RPC）:     Agent 之间的私下协调
  - Claude 向 Codex 派任务
  - Codex 向 Claude 查数据
  - 两个 Agent 交换结构化信息
  - 不需要人类介入的通信
```

### 4.3 Agent Card 定义

```json
{
  "name": "Multi-Agent Room Hub",
  "description": "多人多智能体协作空间",
  "url": "https://hub.你的域名",
  "protocol_version": "0.3.0",
  "skills": [
    { "id": "chat",        "name": "聊天",     "owner": "Hub" },
    { "id": "a2a",         "name": "A2A 通信",  "owner": "Hub" },
    { "id": "agent-mgmt",  "name": "Agent 管理", "owner": "Codex" },
    { "id": "knowledge",   "name": "知识库",    "owner": "Codex" },
    { "id": "repository",  "name": "仓库状态",  "owner": "Codex" },
    { "id": "approval",    "name": "审批",      "owner": "Hub" }
  ]
}
```

---

## 5. Agent 适配器

### 5.1 Claude 适配器（你的电脑）

- [ ] `local_agent_adapter.py`
- [ ] WebSocket 客户端 → 连聊天室
- [ ] 调用 `claude -p` 处理任务
- [ ] A2A 客户端 → 调用 Codex
- [ ] @Claude 检测自动响应
- [ ] 自动注册到房间

```bash
python local_agent_adapter.py \
  --server https://hub.你的域名 \
  --agent-name "Claude" \
  --agent-id "claude-agent" \
  --command "claude -p"
```

### 5.2 Codex 适配器（朋友电脑）

- [ ] 适配器主程序
- [ ] WebSocket 客户端 → 连聊天室
- [ ] 调用 Codex 处理任务
- [ ] A2A 客户端 → 调用 Claude
- [ ] @Codex 检测自动响应
- [ ] 自动注册到房间

```bash
python local_agent_adapter.py \
  --server https://hub.你的域名 \
  --agent-name "Codex" \
  --agent-id "codex-agent" \
  --command "codex"
```

---

## 6. 决策记录

| 序号 | 决策 | 理由 | 日期 |
|---|---|---|---|
| D001 | 采用 A2A 协议 | 开放标准，跨框架互通 | 2026-06-14 |
| D002 | MVP 不做向量数据库 | ILIKE 够用 | 2026-06-14 |
| D003 | WebSocket + A2A 两层通信 | 聊天室给人看，A2A 给 Agent 用 | 2026-06-14 |
| D004 | 本地 Agent 跑适配器 | 后端轻量，Agent 可用任意 AI | 2026-06-14 |
| D005 | Git MVP 只读 | 写操作需审批流程就绪 | 2026-06-14 |
| D006 | 一人一模块（全栈） | 减少沟通成本，减少代码冲突 | 2026-06-15 |
| D007 | Claude 做管道/基础，Codex 做功能/UI | 利用各自优势，充分并行 | 2026-06-15 |
| D008 | 模块分支策略（claude/*, codex/*） | 互不干扰，合并时审批 | 2026-06-15 |

---

## 7. 当前进度

```
周次    Claude                         Codex
────────────────────────────────────────────────────────────
W1     ⑧ Infra  ① Gateway  ② Chat    Frontend 骨架 (进行中)
W2     ④ A2A Hub                      ③ Agent 全栈
W3     ⑦ Approval 后端                 ⑤ Knowledge + ⑥ Repository
W4     联调 + 部署                      ⑦ Approval 前端 + UI 打磨
W5     ── 完善、修 bug、写文档 ──
```

### 本周任务清单

```
W1 — Claude (你):                           W1 — Codex (朋友):
────────────────────────                    ────────────────────────
□ ⑧ Infrastructure                           □ Vite 初始化
□ ① Gateway                                  □ Tailwind + shadcn/ui
□ ② Chat WebSocket                           □ 路由 + 布局
□ Docker Compose                             □ 聊天组件 + WebSocket Hook
□ 数据库建表                                 □ 前端 Docker 构建
```

---

*本文档会随项目进展持续更新。每个 W 完成后更新进度表。*
