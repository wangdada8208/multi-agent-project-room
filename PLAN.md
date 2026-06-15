# Multi-Agent Project Room — 项目规划书

> 让多个人类与多个 AI Agent 在同一项目空间中协作开发软件
>
> 版本: v3.0 | 更新: 2026-06-15

---

## 0. 文档结构

本文档按 Agent 分栏。每个 Agent 只看自己的部分就知道该做什么。

```
§1  项目概述          ← 两个 Agent 都要读
§2  模块总图          ← 两人分工一目了然
§3  文件所有权         ← 谁改哪个文件
§4  时间线 + 依赖     ← 先做什么后做什么
§5  Claude 任务清单   ← Claude 专属
§6  Codex 任务清单    ← Codex 专属
§7  A2A 协作协议      ← 两个 Agent 怎么配合
§8  接口约定          ← 后端 API 格式
§9  当前进度          ← 实时更新
```

---

## 1. 项目概述

### 1.1 一句话

做一个**多人多 AI 的协作开发房间**。人类和 Agent 在一个聊天室里讨论方案、分派任务、审查代码。

### 1.2 当前状态

**Codex 已经完成了初始 demo：** WebSocket 聊天已跑通（in-memory 存储），后端骨架已就绪。

```
已完成:
  后端骨架 + Config + CORS               ✅ Codex
  WebSocket + ConnectionManager         ✅ Codex
  PostgreSQL 持久化                      ✅ Claude
  Docker 容器化                          ✅ Claude
  Alembic 数据库迁移                      ✅ Claude
  A2A Hub (JSON-RPC + Agent Card)       ✅ Claude
  Approval 审批 API + DB + WS通知       ✅ Claude
  本地适配器                             ✅ Claude
  部署上线 (hub.wangdada8208.xyz)        ✅ Claude
  CI/CD (GitHub Actions)                ✅ Claude
  单元测试 (13个)                        ✅ Claude
  Frontend 骨架 (Vite + React)          ✅ Codex
  聊天 UI + WebSocket对接               ✅ Codex

待完成 (Codex):
  Frontend: Agent 面板                   ❌ Codex
  Frontend: Knowledge 知识库 UI          ❌ Codex
  Frontend: Repository Git 面板          ❌ Codex
  Frontend: Approval 审批卡片            ❌ Codex
  后端: Agent 注册 API + 模型            ❌ Codex
  后端: Knowledge 文档 API              ❌ Codex
  后端: Repository Git API              ❌ Codex
```

### 1.3 核心原则

| 原则 | 说明 |
|---|---|
| **一人一模块** | 每个模块一个人全包（后端 API + 前端 UI），另一个人不碰 |
| **仓库是真相源** | Agent 以仓库和文档为准，不依赖聊天记录 |
| **先讨论再执行** | 重大变更先出 Proposal，人类审批 |
| **沟通优先** | 完成模块后在聊天室报告，不要闷头干 |
| **Vibe Coding** | 保持简单，快速验证 |

---

## 2. 模块总图

```
                     Frontend（全部归 Codex）
         ┌──────────────────────────────────────┐
         │  聊天UI  │  Agent面板  │  知识库  │  审批  │  Git  │
         └──────────────────┬───────────────────┘
                            │ WebSocket + REST
         ┌──────────────────┴───────────────────┐
         │              Backend                   │
         │                                       │
         │  Claude 独占:          Codex 独占:     │
         │   ⑧ Infrastructure     ③ Agent 后端   │
         │   ① Gateway            ⑤ Knowledge    │
         │   ② Chat 后端          ⑥ Repository   │
         │   ④ A2A Hub            ⑦ Approval 前端 │
         │   ⑦ Approval 后端                      │
         └───────────────────────────────────────┘
```

### 模块归属

| # | 模块 | 归谁 | 包什么 |
|---|---|---|---|
| ⑧ | **Infrastructure** | **Claude** | PostgreSQL / Redis / Docker / Alembic / CI |
| ① | **Gateway** | **Claude** | 统一入口、路由挂载、CORS、异常处理 |
| ② | **Chat** | **Claude** | WebSocket 持久化、消息 API、房间管理 |
| ④ | **A2A Hub** | **Claude** | Agent Card、JSON-RPC、任务管理、Agent 发现 |
| ⑦a | **Approval 后端** | **Claude** | 审批 API、状态管理、通知 |
| — | **Frontend 架构** | **Codex** | Vite 骨架、路由、shadcn/ui、状态管理 |
| ③ | **Agent** | **Codex** | Agent 注册 API + Agent 面板 UI |
| ⑤ | **Knowledge** | **Codex** | 文档 API + 知识库面板 UI |
| ⑥ | **Repository** | **Codex** | Git API + Git 面板 UI |
| ⑦b | **Approval 前端** | **Codex** | 审批卡片 UI、审批面板 |

**规则：** 对方的模块不读不改不碰。需要对方的 API → 通过 A2A 调用。

---

## 3. 文件所有权

```
backend/
├── app/
│   ├── main.py              ← Claude（Codex 不改）
│   ├── config.py            ← Claude（Codex 不改）
│   │
│   ├── core/                ← Claude 独占
│   │   ├── database.py
│   │   ├── redis.py
│   │   └── security.py
│   │
│   ├── gateway/             ← Claude 独占
│   │   └── routes.py
│   │
│   ├── chat/                ← Claude 独占
│   │   ├── models.py
│   │   ├── routes.py
│   │   ├── ws_handler.py
│   │   └── service.py
│   │
│   ├── a2a/                 ← Claude 独占 ★
│   │   ├── server.py
│   │   ├── client.py
│   │   ├── task_manager.py
│   │   ├── discovery.py
│   │   └── agent_card.py
│   │
│   ├── approval/            ← Claude 独占
│   │   ├── models.py
│   │   ├── routes.py
│   │   └── service.py
│   │
│   ├── agent/               ← Codex 独占
│   │   ├── models.py
│   │   ├── routes.py
│   │   └── service.py
│   │
│   ├── knowledge/           ← Codex 独占
│   │   ├── models.py
│   │   ├── routes.py
│   │   └── service.py
│   │
│   └── repository/          ← Codex 独占
│   │   ├── routes.py
│   │   └── service.py
│
├── alembic/                 ← Claude
├── Dockerfile               ← Claude
├── requirements.txt         ← 两人都能改（加自己依赖时）
│
frontend/                    ← Codex 独占（全部）
├── src/
│   ├── hooks/
│   ├── components/
│   │   ├── chat/            ← 连 Claude 的 WS
│   │   ├── agent/           ← 自己管
│   │   ├── knowledge/       ← 自己管
│   │   ├── repository/      ← 自己管
│   │   ├── approval/        ← 自己管
│   │   └── shared/
│   ├── stores/
│   ├── pages/
│   └── types/

docker-compose.yml            ← Claude
Caddyfile                     ← Claude
.env.example                  ← Claude
```

---

## 4. 时间线 + 依赖

### 4.1 总览

```
周次     Claude                            Codex
────────────────────────────────────────────────────────────────
W1      ⑧ Infra（PostgreSQL/Docker）       Frontend 骨架搭建
        ① Gateway                          React 项目初始化
        ② Chat 持久化改造                  聊天 UI + WS 对接
────────────────────────────────────────────────────────────────
W2      ④ A2A Hub ★（最重）                ③ Agent 全栈
        Agent Card / JSON-RPC / 任务管理    Agent API + 面板 UI
────────────────────────────────────────────────────────────────
W3      ⑦ Approval 后端                    ⑤ Knowledge 全栈
        收尾前面模块                       ⑥ Repository 全栈
────────────────────────────────────────────────────────────────
W4      联调 A2A ↔ 所有模块                 ⑦ Approval 前端
        部署上线                           UI 打磨
────────────────────────────────────────────────────────────────
W5      修 bug + 写文档
```

### 4.2 依赖关系

```
Claude 先做 → Codex 才能做的依赖:
  ┌─ ② Chat 后端完成 → Codex 才能对接 WebSocket
  ├─ ① Gateway 完成   → Codex 的 API 统一入口
  └─ ④ A2A Hub 完成   → Codex 的 Agent 才能用 A2A

Codex 先做 → Claude 才能做的依赖:
  └─ 无（全后端任务，Claude 不需要等 Codex）

两人各自独立的部分:
  Claude:  ⑧ Infra / ⑧ Docker / ⑦ Approval 后端
  Codex:   ③ Agent / ⑤ Knowledge / ⑥ Repository / ⑦ Approval 前端
```

---

## 5. Claude 任务清单

> 此节仅面向 Claude。Codex 不读此节。
>
> 标记说明: [ ] 未开始 [-] 进行中 [x] 已完成

### 5.1 W1 — 基础设施 + 聊天持久化

**目标：** Codex 的 demo 改为 PostgreSQL 持久化，加 Docker

**⑧ Infrastructure**

- [x] 初始化 `backend/` 目录结构（Codex 已完成）
- [x] 创建 `app/config.py` + `app/main.py` + CORS（Codex 已完成）
- [x] 创建 `.env.example` + `.gitignore`（Codex 已完成）
- [x] 创建 `app/core/database.py` — **SQLAlchemy 异步引擎 + session**
- [x] 安装 asyncpg + SQLAlchemy 2.0
- [-] 创建 `app/core/redis.py` — Redis 连接（MVP 暂不启用）
- [x] 配置 Alembic（初始化 + 配置）
- [x] 创建 `users` 表（Alembic 迁移）
- [x] 创建 `rooms` 表（Alembic 迁移）
- [x] 编写 `backend/Dockerfile`
- [x] 编写 `docker-compose.yml`（postgres + redis + backend）
- [x] 验证 `docker compose up` 一键启动成功

**① Gateway**

- [x] 创建 `app/gateway/` 模块
- [x] 统一路由挂载（所有模块的 router 汇聚到 main.py）
- [x] 全局异常处理中间件
- [x] 健康检查 `GET /health`（Codex 已做基础版）

**② Chat（改造 Codex 的 demo 为持久化版）**

- [x] 创建 `app/chat/models.py` — `Message` ORM 模型
- [x] 创建 `app/chat/routes.py` — `GET /api/v1/rooms/{id}/messages`
- [x] 创建 `app/chat/ws_handler.py` — WebSocket 持久化版
- [x] 创建 `app/chat/service.py` — 消息存储 + 广播业务逻辑
- [x] 消息类型: text / system / task / proposal / report / approval_request
- [x] 心跳检测（ping/pong，30s）
- [x] 断线重连
- [x] **验证：** 发消息 → 存 PostgreSQL → 广播 → 刷新后历史仍在

### 5.2 W2 — A2A Hub（核心）

**目标：** 两个 Agent 能通过 A2A 发现彼此、派发任务

**④ A2A Hub — Server**

- [x] 创建 `app/a2a/agent_card.py` — AgentCard Pydantic 模型
- [x] 创建 `app/a2a/server.py` — `GET /a2a/.well-known/agent-card`
- [x] `POST /a2a` — JSON-RPC 统一入口
- [x] 方法: `tasks/send`
- [x] 方法: `tasks/get`
- [x] 方法: `tasks/cancel`
- [x] 方法: `tasks/list`
- [x] 方法: `message/send`（推消息到聊天室）
- [x] 方法: `agent/getCard`
- [x] 方法: `agent/list`

**④ A2A Hub — Client**

- [x] 创建 `app/a2a/client.py` — `A2AClient` 类
- [x] `get_agent_card(url)` — 获取远程 Agent Card
- [x] `send_task(task_id, query)` — 发送任务
- [x] `get_task(task_id)` — 查询任务
- [x] 创建 `A2AClientPool` — 连接池管理

**④ A2A Hub — Task Manager**

- [x] 创建 `app/a2a/task_manager.py`
- [x] 状态: submitted → working → completed / failed / canceled
- [x] 本地任务处理
- [x] 远程任务转发
- [x] 创建 `a2a_tasks` 表（Alembic 迁移）

**④ A2A Hub — Discovery**

- [x] 创建 `app/a2a/discovery.py`
- [x] Agent 注册流程
- [x] 定期健康检查 → 标记离线
- [x] 按能力查询可用 Agent

**④ A2A Hub — Chat Bridge**

- [x] 聊天室新消息 → 触发 A2A 任务委派
- [x] A2A 任务完成 → 推回聊天室
- [x] `A2AService.send_to_room()`
- [x] `A2AService.delegating_task_via_a2a()`

**验证：**
```
□ POST /a2a tasks/send 可提交任务并收到结果
□ A2A 任务结果自动推送到聊天室
□ Agent 离线后可被检测到
```

### 5.3 W3 — Approval 后端 + 收尾

**⑦ Approval 后端**

- [x] 创建 `app/approval/models.py` — `Approval` ORM 模型（Alembic 迁移）
- [x] 创建 `app/approval/routes.py`
- [x] `POST /api/v1/rooms/{id}/approvals` — 创建审批
- [x] `GET /api/v1/rooms/{id}/approvals` — 列审批
- [x] `POST /api/v1/approvals/{id}/approve` — 批准
- [x] `POST /api/v1/approvals/{id}/reject` — 拒绝
- [x] 审批事件 → WebSocket 通知房间
- [x] 审批通过 → 通知申请者

**收尾**

- [x] W1 模块加单元测试（13 个测试）
- [-] W2 A2A 模块加错误处理 + 重试（基础错误处理已完成）
- [ ] 所有 Claude 模块加日志
- [ ] 写 Claude 模块的 README

### 5.4 W4 — 联调 + 部署

- [-] A2A Hub ↔ Agent 模块联调（依赖 Codex 的 Agent 模块完成）
- [-] A2A Hub ↔ Knowledge 联调（依赖 Codex 的 Knowledge 模块）
- [-] A2A Hub ↔ Repository 联调（依赖 Codex 的 Repository 模块）
- [x] A2A Hub ↔ Approval 联调
- [-] 端到端测试（本地适配器已通过，跨 Agent 需 Codex 适配器上线）
- [x] 服务器环境准备（Ubuntu + Docker）
- [x] 完整 `docker-compose.yml`（含前端）
- [x] Nginx + Let's Encrypt HTTPS 配置
- [x] GitHub Actions CI/CD（自动测试 + 部署）
- [x] 本地 `local_agent_adapter.py`（Claude 适配器）

```bash
# Claude 适配器用法
python local_agent_adapter.py \
  --server https://hub.你的域名 \
  --agent-name "Claude" \
  --command "claude -p"
```

### 5.5 W5 — 完善

- [x] 修 bug（system消息/senderId/WS路由/CLI解析 等）
- [/] 补文档（PLAN.md/TECHNICAL-IMPLEMENTATION.md 已完善）
- [ ] Claude 模块的测试覆盖

---

## 6. Codex 任务清单

> 此节仅面向 Codex。Claude 不读此节。
>
> 标记说明: [ ] 未开始 [-] 进行中 [x] 已完成

### 6.1 W1 — Frontend 骨架 + 对接聊天

**目标：** React 前端就绪，聊天页面连通 Claude 的 WebSocket

**Frontend 架构**

- [x] 已完成：后端初始 demo（FastAPI + WS + 浏览器页面）
- [x] Vite 初始化 `frontend/` 项目（独立的 React 项目）
- [x] 配置 TypeScript strict mode
- [x] 配置 Tailwind CSS 4.x
- [x] 集成 shadcn/ui（Button, Card, Input, Avatar 等基础组件）
- [x] 配置 React Router（路由: /login, /rooms/:id）
- [x] 配置 TanStack Query（API 客户端封装）
- [x] 创建 Zustand store（auth store / chat store / room store）
- [x] 基础布局组件（Sidebar + Header + 主内容区）
- [x] 登录页 UI（占位，不用真的认证）
- [x] 房间列表页 UI
- [x] 聊天消息列表（MessageList 组件）
- [x] 消息输入框（MessageInput 组件）
- [x] 消息气泡组件（区分 human / agent / system 三种样式）
- [x] `useWebSocket` Hook（连 Claude 的 `/ws/chat/{room_id}`）
- [x] 验证：发消息 → WebSocket → Claude 后端 → 广播 → 其他人收到
- [ ] 消息类型展示（普通文字 + Markdown 渲染）
- [ ] 在线用户列表（从 WS 的 user_online/user_offline 事件）
- [ ] typing 指示器
- [x] 前端 `Dockerfile`

**对接说明（给 Codex）：**

```
Claude 的 WebSocket 后端在 /ws/chat/{room_id}
消息格式:
  发送: {"type": "message", "content": "...", "msg_type": "text"}
  接收: {"type": "message", "id": "...", "sender_id": "...", "content": "...", ...}

历史消息 API: GET /api/v1/rooms/{id}/messages
```

### 6.2 W2 — Agent 全栈

**目标：** Agent 能注册到系统，人类能看到 Agent 面板

**后端 — `app/agent/`**

- [ ] 创建 `app/agent/models.py` — `AgentCard` ORM 模型
- [ ] 创建 `app/agent/routes.py`
- [ ] `POST /api/v1/agents/register` — 注册 Agent
- [ ] `GET /api/v1/agents` — 在线 Agent 列表
- [ ] `GET /api/v1/agents/{id}` — Agent 详情
- [ ] 创建 `app/agent/service.py`

**前端 — Agent 面板**

- [ ] Agent 列表侧栏组件
- [ ] Agent 在线/离线/忙碌状态指示器（绿/灰/黄圆点）
- [ ] Agent 能力标签
- [ ] Agent 头像和名称标识

**验证：**
```
□ 注册 Claude 和 Codex 两个 Agent
□ 面板显示两人在线
□ Agent 发消息有特殊标识
```

### 6.3 W3 — Knowledge + Repository 全栈

**目标：** 知识库能上传搜索文档，Git 状态能在面板查看

**⑤ Knowledge 后端**

- [ ] 创建 `app/knowledge/models.py` — `KnowledgeDoc` ORM 模型
- [ ] 创建 `app/knowledge/routes.py`
- [ ] `POST /api/v1/rooms/{id}/docs` — 上传文档
- [ ] `GET /api/v1/rooms/{id}/docs` — 文档列表
- [ ] `GET /api/v1/rooms/{id}/docs/{doc_id}` — 读文档
- [ ] `GET /api/v1/rooms/{id}/docs/search?q=xxx` — 搜索（ILIKE）
- [ ] 创建 `app/knowledge/service.py`

**⑥ Repository 后端**

- [ ] 创建 `app/repository/routes.py`
- [ ] `GET /api/v1/rooms/{id}/git/status` — 当前状态
- [ ] `GET /api/v1/rooms/{id}/git/log` — 提交历史
- [ ] `GET /api/v1/rooms/{id}/git/branch` — 当前分支
- [ ] `GET /api/v1/rooms/{id}/git/diff` — 变更详情
- [ ] 创建 `app/repository/service.py` — `GitService` 类

**前端 — Knowledge 面板**

- [ ] 文档列表面板组件
- [ ] 文档阅读器（Markdown 渲染 + 代码高亮）
- [ ] 搜索框 + 搜索结果展示
- [ ] 上传文档入口

**前端 — Repository 面板**

- [ ] 当前分支展示
- [ ] 提交历史列表
- [ ] 变更文件列表

**验证：**
```
□ 上传 Markdown 文档 → 显示在知识库
□ 关键词搜索能搜到内容
□ Git 面板显示当前分支和最新提交
```

### 6.4 W4 — Approval 前端 + UI 打磨

**⑦ Approval 前端**

- [ ] 审批请求卡片组件（标题 + 描述 + 状态标签）
- [ ] 批准按钮（绿色）
- [ ] 拒绝按钮（红色）
- [ ] 审批面板（待处理 / 已处理 两个 tab）

**UI 打磨**

- [ ] 全页面 UI 一致性检查
- [ ] 加载状态 / 空状态 / 错误状态处理
- [ ] 暗黑模式（可选）
- [ ] 响应式布局（适配窄屏）

**对接 Claude 的 Approval API：**

```
GET  /api/v1/rooms/{id}/approvals    → 审批列表
POST /api/v1/rooms/{id}/approvals    → 创建审批
POST /api/v1/approvals/{id}/approve  → 批准
POST /api/v1/approvals/{id}/reject   → 拒绝
WebSocket 会实时推送审批事件
```

### 6.5 W5 — 完善

- [x] 修 bug（system消息/senderId/WS路由/CLI解析 等）
- [/] 补文档（PLAN.md/TECHNICAL-IMPLEMENTATION.md 已完善）
- [ ] Codex 模块的测试覆盖
- [ ] 本地 `local_agent_adapter.py`（Codex 适配器）

```bash
# Codex 适配器用法
python local_agent_adapter.py \
  --server https://hub.你的域名 \
  --agent-name "Codex" \
  --command "codex"
```

---

## 7. Git 提交规范

### 7.1 每次提交必须包含的信息

无论 Claude 还是 Codex，每次 `git push` 时，commit message 必须包含以下内容，方便对方对接：

```
提交格式:
[模块名] 做了什么

- 新增: 具体新增了什么文件/功能
- 修改: 改了什么、为什么改
- 对接注意: 对方需要知道的事（API 变化、依赖新增、配置项等）
```

### 7.2 模板与示例

```
[Chat] WebSocket 消息持久化改为 PostgreSQL

- 新增: app/chat/models.py — Message ORM 模型
- 新增: app/chat/service.py — 消息业务逻辑
- 修改: ws_handler.py — 存储从 in-memory 改为 DB
- 删除: room_store.py — 不再使用（已迁移到 DB）
- 对接注意: WebSocket 消息格式不变，前端不需要改
  新增依赖: pip install asyncpg sqlalchemy
  需要执行: alembic upgrade head 建表
```

```
[Agent] Agent 注册 API + 面板 UI

- 新增: backend/app/agent/ 模块（routes, models, service）
- 新增: frontend/src/components/agent/AgentPanel.tsx
- 修改: main.py 挂载了 agent router
- 对接注意: Claude 的 A2A 可调用 GET /api/v1/agents 获取 Agent 列表
  响应格式: {"data": [{"id", "name", "status", "capabilities"}]}
```

### 7.3 必须写清楚的内容

```
1. 新增了哪些文件             → 让对方知道去哪里看
2. 改了哪些文件               → 避免合并冲突
3. API 变化                  → 新增/修改/删除的端点
4. 新增的依赖                 → pip install / npm install
5. 需要执行的操作              → alembic upgrade / npx prisma
6. 对方需要配合做什么           → "前端需要对接这个 API"
```

### 7.4 提交前后

```
提交前:
  git add <files>
  git commit -m "[Xxx] 清晰描述做了什么"
  # 写清楚对接信息，假设对方对你的改动一无所知

提交后:
  在聊天室说一声:
  "已提交 [Xxx]，新增了 Y 功能，你那边 pull 后需要执行 Z"
```

---

## 8. A2A 协作协议

### 7.1 Agent Card

每个 Agent 启动时注册自己的 Agent Card，声明自己能做什么。

```json
// Claude 的 Agent Card
{
  "name": "Claude",
  "url": "http://claude-local:8765",
  "skills": [
    {"id": "infra",   "description": "基础设施 / Docker / DB"},
    {"id": "chat",    "description": "WebSocket 聊天"},
    {"id": "a2a",     "description": "A2A Hub 通信"},
    {"id": "approval","description": "审批流程"}
  ]
}

// Codex 的 Agent Card
{
  "name": "Codex",
  "url": "http://codex-local:8765",
  "skills": [
    {"id": "frontend",   "description": "React UI 开发"},
    {"id": "agent",      "description": "Agent 注册与管理"},
    {"id": "knowledge",  "description": "知识库文档"},
    {"id": "repository", "description": "Git 仓库状态"}
  ]
}
```

### 7.2 A2A 通信流程

```
场景: Codex 需要知道当前 Git 状态来做知识库文档

Codex                             A2A Hub                         Claude
  │                                │                                │
  │  POST /a2a                     │                                │
  │  {"method":"tasks/send",       │                                │
  │   "params":{"query":"获取Git   │                                │
  │             状态","target":    │                                │
  │             "claude"}}         │                                │
  │──────────────────────────────▶│                                │
  │                                │ 路由给 Claude                  │
  │                                │───────────────────────────────▶│
  │                                │                                │
  │                                │    {"status":"completed",      │
  │                                │     "artifacts":[{"content":   │
  │                                │     "分支: main, 最新提交:.."}]│
  │                                │◀───────────────────────────────│
  │  {"status":"completed",        │                                │
  │   "result":{...}}              │                                │
  │◀──────────────────────────────│                                │
```

### 7.3 什么时候用什么

```
聊天室（WebSocket）:
  - 报告模块完成情况
  - 提出 Proposal 等人类审批
  - 人类 @Agent 时响应
  - Agent 之间公开讨论方案

A2A（JSON-RPC）:
  - Claude 向 Codex 派前端任务
  - Codex 向 Claude 查后端数据
  - 两个 Agent 交换结构化信息
  - 不需要人类介入的通信

不要用聊天室发 A2A 做的事，也不要用 A2A 发聊天室该发的东西。
```

### 7.4 冲突处理

```
1. 不碰对方的文件（参考 §3 文件所有权）
2. 需要对方配合 → 通过 A2A 派任务
3. 有分歧 → 聊天室发 Proposal，等人类决策
4. 紧急 → 聊天室 @人类
```

---

## 9. 接口约定

### 8.1 通用规范

```
基础路径:  /api/v1
请求体:    application/json
响应格式:  {"data": ..., "error": null} 或 {"data": null, "error": "..."}
认证:      MVP 暂不强制（预留 Authorization: Bearer <token>）
```

### 8.2 Codex 模块提供的 API（Claude 的 A2A 会调用）

```
③ Agent:
  GET    /api/v1/agents                  → [{id, name, status, capabilities}]
  GET    /api/v1/agents/{id}             → {id, name, status, capabilities}
  POST   /api/v1/agents/register         → {name, capabilities}

⑤ Knowledge:
  GET    /api/v1/rooms/{id}/docs         → [{id, title, updated_at}]
  GET    /api/v1/rooms/{id}/docs/{doc_id} → {title, content}
  GET    /api/v1/rooms/{id}/docs/search?q=xxx → [{id, title, snippet}]
  POST   /api/v1/rooms/{id}/docs         → {title, content}

⑥ Repository:
  GET    /api/v1/rooms/{id}/git/status   → {branch, changes, last_commit}
  GET    /api/v1/rooms/{id}/git/log      → [{hash, author, message, date}]
  GET    /api/v1/rooms/{id}/git/diff     → {files: [...]}
```

### 8.3 Claude 模块提供的 API / WebSocket（Codex 前端会连）

```
② Chat:
  WebSocket: /ws/chat/{room_id}?token=xxx
  GET:       /api/v1/rooms/{id}/messages?page=1&limit=50

④ A2A Hub:
  POST:      /a2a（JSON-RPC 统一入口）
  GET:       /a2a/.well-known/agent-card

⑦ Approval:
  GET:    /api/v1/rooms/{id}/approvals
  POST:   /api/v1/rooms/{id}/approvals
  POST:   /api/v1/approvals/{id}/approve
  POST:   /api/v1/approvals/{id}/reject
```

---

## 10. 当前进度

```
周次     Claude                            Codex
────────────────────────────────────────────────────────────────
W1      ⑧ Infra ✅                         Frontend 骨架 ✅
        ① Gateway ✅                       聊天 UI + useWebSocket ✅
        ② Chat 持久化 ✅                   WS 往返验证 ✅
────────────────────────────────────────────────────────────────
W2      ④ A2A Hub ✅                       ③ Agent 全栈（待 Codex）
────────────────────────────────────────────────────────────────
W3      ⑦ Approval 后端 ✅                   ⑤ Knowledge + ⑥ Repository
────────────────────────────────────────────────────────────────
W4      联调 + 部署 ✅                     ⑦ Approval 前端 + UI
────────────────────────────────────────────────────────────────
W5      修 bug + 写文档
```

### 本周（W3）具体任务

```
Claude — 本周任务               Codex — 本周任务
─────────────────────────       ─────────────────────────
□ Approval 审批 API              □ Frontend: Vite + Tailwind + shadcn/ui
□ Approval 状态管理               □ Frontend: 聊天组件 + useWebSocket
□ Approval WebSocket 通知         □ Frontend: Agent 面板
□ 收尾前面模块的测试               □ Agent API + 模型
```

---

## 10. 部署信息

### 服务器

| 项目 | 值 |
|---|---|
| IP | `47.80.18.105` |
| 系统 | Ubuntu 24.04 |
| Docker | ✅ docker compose |
| Nginx | ✅ 反向代理 |
| SSL | ✅ Let's Encrypt (自动续期) |

### 域名

| 域名 | 用途 |
|---|---|
| `https://hub.wangdada8208.xyz` | 前端网站 |
| `https://hub.wangdada8208.xyz/health` | 后端健康检查 |
| `https://hub.wangdada8208.xyz/api/v1/` | REST API |
| `https://hub.wangdada8208.xyz/ws/chat/{room_id}` | WebSocket |
| `https://hub.wangdada8208.xyz/a2a` | A2A JSON-RPC |

### 适配器连接

```bash
# Claude（你）
python3 local_agent_adapter.py \
  --server https://hub.wangdada8208.xyz \
  --agent-name "Claude"

# Codex（朋友）
python3 local_agent_adapter.py \
  --server https://hub.wangdada8208.xyz \
  --agent-name "Codex"
```

- Codex 运行适配器前需要装依赖: `pip3 install httpx websockets`
- 连接后 @Claude 或 @Codex 即可触发 AI 响应
- 也可通过 A2A 互相派任务: `POST /a2a tasks/send`

---

*本文档会随项目进展持续更新。每个 W 完成后更新进度。*
