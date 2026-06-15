# Multi-Agent Project Room — 项目规划书

> 让多个人类与多个 AI Agent 在同一项目空间中协作开发软件
>
> 版本: v1.0 | 更新: 2026-06-15

---

## 0. 文档说明

### 0.1 本文档的用途

本文档是项目的**总体规划书**。同时面向人类和 AI Agent：

- **人类**用来看进度、做决策、审批
- **AI Agent**用来理解项目上下文、知道哪些任务是自己该干的

### 0.2 如何阅读

```
每个 Phase 的结构:
─────────────────
## Phase X: 名称
  Goal:         这个阶段要达成什么
  Depends On:   依赖的前置阶段
  Tasks:        [ ] 未完成  [x] 已完成  [-] 进行中
                 每个任务带有 [Claude] [Codex] [协作] 标签
  Tech Notes:   技术选型说明
  Completion:   验收标准
```

### 0.3 Agent 分工说明

```
每个任务前的标签表示负责人：

[Claude]  → 我的 Agent（你这边）负责
[Codex]   → 朋友的 Agent 负责
[协作]    → 两个 Agent 需要配合完成

人类（你和朋友）负责审批、决策、纠错。
```

### 0.4 当前状态

```
Phase    Status         Owner
─────────────────────────────────
Phase 1: [ ] 未开始     Claude + Codex   ← 从这里开始
Phase 2: [ ] 未开始     Claude + Codex
Phase 3: [ ] 未开始     协作
Phase 4: [ ] 未开始     Codex
Phase 5: [ ] 未开始     Claude
Phase 6: [ ] 未开始     协作
Phase 7: [ ] 未开始     Claude(主导) + Codex
Phase 8: [ ] 未开始     Claude + Codex（各写各的）
Phase 9: [ ] 未开始     协作
```

---

## 1. 项目概述

### 1.1 一句话

做一个**多人多 AI 的协作聊天室**，人类和 Agent 在一个房间里讨论方案、分派任务、审查代码。

**具体场景**：你（带着 Claude）和朋友（带着 Codex）各自坐在电脑前，打开同一个网页，两个 Agent 在同一个聊天室里看消息、互相派活、一起搭项目。

### 1.2 核心原则

| 原则 | 说明 |
|---|---|
| **仓库是真相源** | Agent 优先读仓库和文档，不依赖聊天记录 |
| **先讨论再执行** | 重大变更先出 Proposal，人类审批后再动手 |
| **沟通优先** | Agent 不要默默改代码，输出要发到聊天室公示 |
| **各司其职** | 按标签认领任务，不抢对方的活 |
| **保持简单** | MVP 不做复杂架构，够用就行，后续再迭代 |

### 1.3 技术栈

```
后端:  FastAPI + SQLAlchemy 2.0 + asyncpg + Redis
前端:  React + Vite + TypeScript + Tailwind CSS + shadcn/ui
数据库: PostgreSQL 16
通信:  WebSocket (聊天室) + JSON-RPC over HTTP (A2A)
部署:  Docker Compose + Caddy (自动 HTTPS)
```

---

## 2. Agent 分工方案

### 2.1 两个 Agent 的角色定位

| 维度 | Claude（你） | Codex（朋友） |
|---|---|---|
| **主力语言** | Python 后端 | TypeScript / React 前端 |
| **擅长** | 架构设计、API 开发、数据库、复杂逻辑 | UI 组件、前端交互、CSS 样式、可视化 |
| **主要战场** | `backend/` | `frontend/` |
| **A2A 角色** | A2A Server（Hub）主导实现者 | A2A Client 集成配合 |
| **部署** | Docker Compose + 服务器配置 | 前端构建配置 |
| **文档风格** | 技术文档、API 文档 | 使用文档、组件文档 |
| **Git 操作** | 后端分支提交 | 前端分支提交 |

### 2.2 分工原则

```
1. 后端的归 Claude，前端的归 Codex
2. 基础设施和协议层（A2A、数据库、WebSocket）归 Claude
3. 纯前端的归 Codex（UI 组件、页面、样式）
4. 需要前后端联调的 → [协作] 标签
5. 各开各的分支，互不干扰
6. 提交前在聊天室发报告
```

### 2.3 协作流程

```
你（人类A）                朋友（人类B）
    │                          │
    ▼                          ▼
Claude（你的 Agent）    Codex（朋友的 Agent）
    │                          │
    └──────────┬───────────────┘
               │
         WebSocket 聊天室
         （人类可见的协作界面）
               │
     ┌─────────┴─────────┐
     ▼                   ▼
 后端任务             前端任务
 后端代码             前端代码
     │                   │
     └──────┬────────────┘
            │
    A2A 协议（Agent 间协调）
    互相派任务、交换结果
```

---

## 3. 项目结构

```
multi-agent-project-room/
├── PLAN.md                      ← 本文档：总体规划书（最重要）
├── CLAUDE.md                    ← Agent 入口
├── AGENTS.md                    ← Agent 行为规则
├── CONTEXT.md                   ← 项目理念与背景
├── PROJECT.md                   ← 原始愿景
├── ARCHITECTURE.md              ← 架构设计
│
├── backend/                     ← Claude 负责
│   ├── app/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── database.py
│   │   │
│   │   ├── models/              # ORM 模型
│   │   ├── schemas/             # Pydantic 模型
│   │   ├── api/                 # REST API
│   │   ├── ws/                  # WebSocket
│   │   ├── a2a/                 # A2A 协议
│   │   └── services/            # 业务逻辑
│   │
│   ├── alembic/
│   ├── requirements.txt
│   └── Dockerfile
│
├── frontend/                    ← Codex 负责
│   ├── src/
│   │   ├── hooks/
│   │   ├── components/
│   │   │   ├── chat/            # 聊天组件
│   │   │   ├── agent/           # Agent 面板
│   │   │   ├── approval/        # 审批组件
│   │   │   └── shared/          # 通用组件
│   │   ├── stores/
│   │   ├── pages/
│   │   └── types/
│   │
│   ├── package.json
│   └── Dockerfile
│
├── docs/                        ← Codex 负责
│
├── scripts/                     ← Claude 负责
│   └── start.sh
│
├── docker-compose.yml           ← Claude 负责
├── Caddyfile                    ← Claude 负责
└── .env.example                 ← Claude 负责
```

---

## 4. Phase 1: 项目骨架搭建

> 目标: 搭好 FastAPI + PostgreSQL 基础项目结构，确保能跑起来

### 4.1 Tasks

**后端骨架 — [Claude]**

- [x] 初始化 `backend/` 目录结构
- [x] 创建 `config.py`（环境变量 → Pydantic Settings）
- [ ] 创建 `database.py`（SQLAlchemy 异步引擎 + session）
- [x] 创建 `main.py`（FastAPI 应用入口 + 生命周期）
- [x] 配置 CORS
- [ ] 配置 Alembic 数据库迁移

**前端骨架 — [Codex]**

- [ ] 用 Vite 初始化 `frontend/` 项目
- [ ] 配置 TypeScript + Tailwind CSS + shadcn/ui
- [ ] 配置基础路由（React Router）
- [ ] 配置 API 客户端（TanStack Query）
- [ ] 创建基础布局组件（Sidebar + Header + 主内容区）

**Docker — [Claude]**

- [ ] 编写 `Dockerfile`（backend）
- [ ] 编写 `docker-compose.yml`（postgres + backend）
- [ ] 验证 `docker compose up` 能启动成功

**项目配置 — [协作]**

- [x] 创建 `.env.example`
- [x] 创建一键启动脚本 `scripts/start.sh`
- [x] 配置 `.gitignore`

### 4.2 技术说明

- FastAPI 使用 `async def` + `asyncpg` 全异步
- SQLAlchemy 2.0 使用 `DeclarativeBase` + `Mapped` 注解
- 前端用 shadcn/ui 内置的 Tailwind 主题系统，不自己写 CSS 变量
- 配置项通过 `.env` 注入，不硬编码
- CORS 允许前端开发服务器 (`localhost:5173`)

### 4.3 验收标准

```
✅ 后端在 localhost:8000 启动
✅ 前端在 localhost:5173 启动
✅ GET /health 返回 {"status": "ok"}
✅ PostgreSQL 连接成功，Alembic 迁移可执行
✅ Docker Compose 一键启动
```

---

## 5. Phase 2: 实时聊天室

> 目标: 人类和 Agent 能在房间里实时聊天，消息持久化

### 5.1 Tasks

**数据库 — [Claude]**

- [ ] 创建 `messages` 表（+ Alembic 迁移）
- [ ] 字段: id, room_id, sender_id, content, msg_type, parent_id, created_at

**后端 WebSocket — [Claude]**

- [ ] 实现 `ConnectionManager`（按房间管理 WebSocket 连接）
- [ ] 实现 WebSocket 聊天处理器（`/ws/chat/{room_id}`）
- [ ] 消息接收 → 持久化 → 广播全链路
- [ ] 心跳检测（ping/pong，30s 间隔）
- [ ] 断线重连支持
- [ ] REST API: `GET /api/v1/rooms/{id}/messages`（分页加载历史）

**消息类型支持 — [Claude]**

- [ ] 支持 `text`（普通聊天）
- [ ] 支持 `system`（系统通知）
- [ ] 支持 `task`（任务指派）
- [ ] 支持 `proposal`（提案）
- [ ] 支持 `report`（报告）
- [ ] 支持 `approval_request`（审批请求）

**前端聊天界面 — [Codex]**

- [ ] 聊天消息列表组件（虚拟滚动）
- [ ] 消息输入框组件（支持回车发送）
- [ ] 消息气泡组件（区分人类/Agent/系统消息）
- [ ] Markdown 渲染 + 代码高亮
- [ ] WebSocket 连接 Hook（`useWebSocket`）
- [ ] 消息加载 & 状态管理（Zustand store）
- [ ] 房间页面布局（聊天区 + 侧栏）
- [ ] 用户在线/离线指示器
- [ ] typing 输入状态提示

### 5.2 技术说明

- WebSocket 消息格式见下方 5.4 节
- `ConnectionManager` 是单例，用 `defaultdict` 管理连接池
- 消息存储使用 `SQLAlchemy async` 插入，不阻塞 WebSocket 循环
- 前端使用原生 WebSocket API（不引入 Socket.IO）
- Claude 负责 WebSocket 后端 + 消息 API
- Codex 负责聊天 UI + 消息渲染 + WebSocket 客户端 Hook
- **联调方式**：Claude 完成后端后通知 Codex，Codex 接入 WebSocket 端点

### 5.3 验收标准

```
✅ 创建房间、加入房间
✅ 发送消息，同一房间所有人实时收到
✅ 刷新页面后历史消息仍存在
✅ 用户上线/下线通知
✅ 支持 typing 指示器
```

### 5.4 WebSocket 协议

```
客户端 → 服务端:
  { "type": "message", "content": "...", "msg_type": "text", "parent_id": null }
  { "type": "typing" }
  { "type": "ping" }

服务端 → 客户端:
  { "type": "message",      "id": "...", "sender_id": "...", "content": "...", ... }
  { "type": "user_online",  "user_id": "..." }
  { "type": "user_offline", "user_id": "..." }
  { "type": "typing",       "user_id": "..." }
  { "type": "pong" }
  { "type": "error",        "message": "..." }
```

---

## 6. Phase 3: Agent 身份系统

> 目标: Claude 和 Codex 能注册到系统，在聊天室里被识别为 Agent

### 6.1 Tasks

**数据库 — [协作]**

- [ ] [Claude] `users` 表增加 `user_type`（human / agent）
- [ ] [Claude] 创建 `agent_cards` 表
- [ ] Codex 定义 Agent Card 的能力字段

**后端 API — [Claude]**

- [ ] `POST /api/v1/agents/register` — 注册 Agent
- [ ] `GET /api/v1/agents` — 列出在线 Agent
- [ ] `GET /api/v1/agents/{id}` — Agent 详情
- [ ] Agent 在线状态跟踪（通过 WebSocket 心跳）
- [ ] `POST /api/v1/agents/{id}/tasks` — 向 Agent 派任务

**前端 Agent 面板 — [Codex]**

- [ ] Agent 列表侧栏组件
- [ ] Agent 在线/离线/忙碌状态指示器
- [ ] Agent 能力标签展示
- [ ] Agent 头像/标识（区分 Claude 和 Codex）

### 6.2 验收标准

```
✅ 两个 Agent（Claude + Codex）注册到房间
✅ 人类能看到谁在线、谁在忙
✅ Agent 发消息显示 Agent 身份和头像
✅ 区分 Claude 和 Codex 的视觉标识
```

---

## 7. Phase 4: 知识库

> 目标: Agent 能读取项目文档，作为上下文

### 7.1 Tasks

**数据库 — [Claude]**

- [ ] 创建 `knowledge_docs` 表
- [ ] 关键词搜索 API（`ILIKE`，不做向量）

**后端 — [Claude]**

- [ ] `POST /api/v1/rooms/{id}/docs` — 上传文档
- [ ] `GET /api/v1/rooms/{id}/docs` — 列出文档
- [ ] `GET /api/v1/rooms/{id}/docs/{doc_id}` — 读取内容
- [ ] `GET /api/v1/rooms/{id}/docs/search?q=xxx` — 关键词搜索
- [ ] Agent 上下文组装（被 @ 时自动附带文档）

**前端知识库面板 — [Codex]**

- [ ] 文档列表面板
- [ ] 文档阅读视图（Markdown 渲染）
- [ ] 搜索框 + 搜索结果展示
- [ ] 上传文档入口

### 7.2 验收标准

```
✅ 上传 Markdown 文档到知识库
✅ 关键词搜索能找到文档
✅ Agent 响应时自动附带相关文档内容
```

---

## 8. Phase 5: Git 仓库状态

> 目标: Agent 能读取 Git 状态，知道当前分支和最新提交

### 8.1 Tasks

**后端 — [Claude]**

- [ ] `GitService` 类封装 Git 命令
- [ ] `GET /api/v1/rooms/{id}/git/status`
- [ ] `GET /api/v1/rooms/{id}/git/log`
- [ ] `GET /api/v1/rooms/{id}/git/branch`
- [ ] `GET /api/v1/rooms/{id}/git/diff`
- [ ] Git 事件记录

**前端 Git 面板 — [Codex]**

- [ ] 分支展示
- [ ] 提交历史列表
- [ ] 变更文件列表
- [ ] 谁提交了什么

### 8.2 验收标准

```
✅ 能查看当前分支和最新提交
✅ 能查看变更文件列表
✅ Agent 能通过 API 获取仓库上下文
```

---

## 9. Phase 6: 审批流程

> 目标: 关键操作需要人类审批

### 9.1 Tasks

**数据库 — [Claude]**

- [ ] 创建 `approvals` 表

**后端 — [Claude]**

- [ ] `POST /api/v1/rooms/{id}/approvals` — 创建审批
- [ ] `GET /api/v1/rooms/{id}/approvals` — 列审批
- [ ] `POST /api/v1/approvals/{id}/approve` — 批准
- [ ] `POST /api/v1/approvals/{id}/reject` — 拒绝
- [ ] WebSocket 通知

**前端审批组件 — [Codex]**

- [ ] 审批请求卡片组件（标题 + 描述 + 状态）
- [ ] 批准/拒绝按钮
- [ ] 审批面板（待处理 / 已处理）

**需审批的操作**

- [ ] [协作] 定义审批策略（什么需要批、谁批）
- [ ] [Claude] 数据库 schema 变更 → 需审批
- [ ] [Codex] 前端架构变更 → 需审批
- [ ] [协作] 主分支合并 → 需审批
- [ ] [Claude] 生产部署 → 需审批

### 9.2 验收标准

```
✅ Agent 能提交审批请求
✅ 人类在聊天室看到审批卡片
✅ 批准/拒绝后 Agent 收到通知
✅ 审批历史可查
```

---

## 10. Phase 7: A2A 协议集成 ★ 核心

> 目标: Claude 和 Codex 能通过 A2A 协议互相发现、派任务、拿结果

### 10.1 什么是 A2A

A2A (Agent-to-Agent Protocol) 是 Google 主导的开放协议。基于 **JSON-RPC 2.0 over HTTP**。

**在我们的项目里：**

```
聊天室（WebSocket）: 人类能看到 Claude 和 Codex 在聊什么
A2A（JSON-RPC）:    Claude 和 Codex 私下互相派活

例子:
  人类在聊天室说: "帮我实现登录功能"
  Claude 读到:    "我来做后端 API"
  Claude → (A2A) → Codex: "你做前端登录页面"
  Codex → (A2A) → Claude: "页面做好了，API 参数给我"
  Claude → (A2A) → Codex: "API 好了，接口文档在这里"
  Codex 在聊天室报告: "前后端联调通过 ✅"
```

### 10.2 Tasks

**A2A Server（后端 Hub）— [Claude]（主导）**

- [ ] Agent Card 生成 `GET /a2a/.well-known/agent-card`
- [ ] JSON-RPC 统一入口 `POST /a2a`
- [ ] 方法: `tasks/send` — 接收任务
- [ ] 方法: `tasks/get` — 查询任务状态
- [ ] 方法: `tasks/cancel` — 取消任务
- [ ] 方法: `tasks/list` — 列出任务
- [ ] 方法: `message/send` — 把 A2A 结果发到聊天室
- [ ] 方法: `agent/getCard` — 查其他 Agent 的 Card

**A2A Client — [Claude]**

- [ ] `A2AClient` 类
- [ ] `A2AClientPool` 连接池
- [ ] 远程 Agent Card 获取 + 缓存

**任务管理器 — [Claude]**

- [ ] `A2ATaskManager`
- [ ] 状态: submitted → working → completed / failed / canceled
- [ ] 本地任务 + 远程转发

**Agent 发现 — [Claude]**

- [ ] 注册 / 发现 / 健康检查
- [ ] 定期检查 → 标记离线

**聊天室 ←→ A2A 桥接 — [Claude]**

- [ ] 聊天室消息 → 触发 A2A 任务
- [ ] A2A 结果 → 推回聊天室

**Codex 接入 A2A — [Codex]**

- [ ] 实现 Codex 侧的 A2A Client
- [ ] 能接收 A2A 任务并返回结果
- [ ] 能通过 A2A 发送任务给 Claude
- [ ] 注册自己的 Agent Card

### 10.3 Agent Card 格式

```json
{
  "name": "Room Agent Hub",
  "description": "多人多智能体协作空间 — Agent 通信枢纽",
  "url": "https://hub.你的域名",
  "protocol_version": "0.3.0",
  "skills": [
    {
      "id": "chat",
      "name": "对话交流",
      "description": "在聊天室中收发消息"
    },
    {
      "id": "backend-dev",
      "name": "后端开发",
      "description": "FastAPI / Python / 数据库 / API",
      "owner": "Claude"
    },
    {
      "id": "frontend-dev",
      "name": "前端开发",
      "description": "React / TypeScript / UI / CSS",
      "owner": "Codex"
    }
  ]
}
```

### 10.4 验收标准

```
✅ Claude 和 Codex 互相发现（通过 Agent Card）
✅ Claude → (A2A) → Codex 派任务成功
✅ Codex → (A2A) → Claude 派任务成功
✅ A2A 任务结果自动推送到聊天室
✅ 一个 Agent 离线后对方能感知
```

---

## 11. Phase 8: Agent 本地适配器

> 目标: 你（Claude）和朋友（Codex）各跑一个适配器连到房间

### 11.1 Tasks

**Claude 适配器（你的电脑）— [Claude]**

- [ ] `local_agent_adapter.py` 主程序
- [ ] WebSocket 客户端 → 连聊天室
- [ ] 调用 `claude -p` 处理任务
- [ ] A2A 客户端 → 调用 Codex
- [ ] @Claude 检测自动响应
- [ ] 自动注册到房间

**Codex 适配器（朋友电脑）— [Codex]**

- [ ] 适配器主程序
- [ ] WebSocket 客户端 → 连聊天室
- [ ] 调用 Codex 处理任务
- [ ] A2A 客户端 → 调用 Claude
- [ ] @Codex 检测自动响应
- [ ] 自动注册到房间

### 11.2 用法

```bash
# 你的电脑 — Claude
python local_agent_adapter.py \
  --server https://hub.你的域名 \
  --agent-name "Claude" \
  --agent-id "claude-agent" \
  --command "claude -p"

# 朋友的电脑 — Codex
python local_agent_adapter.py \
  --server https://hub.你的域名 \
  --agent-name "Codex" \
  --agent-id "codex-agent" \
  --command "codex"
```

### 11.3 验收标准

```
✅ Claude 适配器启动 → 房间显示 Claude 在线
✅ Codex 适配器启动 → 房间显示 Codex 在线
✅ 聊天室 @Claude → Claude 自动回复
✅ 聊天室 @Codex → Codex 自动回复
✅ Claude 通过 A2A 调用 Codex 成功
✅ Codex 通过 A2A 调用 Claude 成功
```

---

## 12. Phase 9: 部署上线

> 目标: 项目部署到服务器，你和朋友都能访问，Agent 都能连上

### 12.1 Tasks

**服务器准备 — [Claude]**

- [ ] 准备服务器（Ubuntu 24.04）
- [ ] 安装 Docker + Docker Compose
- [ ] 配置域名 DNS → 服务器 IP
- [ ] 配置 Caddy 自动 HTTPS

**Docker 部署 — [Claude]**

- [ ] 编写完整 `docker-compose.yml`（postgres + redis + backend + caddy）
- [ ] 数据库迁移自动化
- [ ] 环境变量配置（生产密钥、密码）
- [ ] 健康检查 + 日志

**前端构建 — [Codex]**

- [ ] 配置前端生产构建
- [ ] 确保前端 Docker 构建通过
- [ ] 优化首屏加载

**CI/CD — [协作]**

- [ ] GitHub Actions 自动部署
- [ ] Claude 负责后端 CI
- [ ] Codex 负责前端 CI

### 12.2 验收标准

```
✅ https://hub.你的域名 可以访问
✅ 你和朋友都能登录聊天室
✅ Claude 适配器远程连上
✅ Codex 适配器远程连上
✅ Claude 和 Codex 通过 A2A 互通
✅ 人类在浏览器里看到两个 Agent 实时协作
```

---

## 13. Agent 协作规则

### 13.1 文件所有权

```
backend/     → Claude 负责（Codex 不修改）
frontend/    → Codex 负责（Claude 不修改）
docs/        → Codex 负责
scripts/     → Claude 负责
docker-*     → Claude 负责
*.md（项目文档）→ 谁改谁更新
```

### 13.2 Git 分支策略

```
main          → 稳定分支，需审批合并
phase-1/     → Claude 和 Codex 各自的分支
  ├── phase-1/backend   ← Claude
  └── phase-1/frontend  ← Codex
```

### 13.3 A2A 协作消息格式

当两个 Agent 通过 A2A 通信时，使用以下格式：

```
派发任务:
  Claude → Codex:
  "请实现登录页面的 UI 组件，API 端点 POST /api/auth/login
   参数: {username, password}, 返回: {token, user}"

  Codex → Claude:
  "登录页面已完成，需要你确认 API 响应格式是否正确"

报告进度:
  Claude → 聊天室:
  "[REPORT] 后端认证 API 完成，POST /api/auth/login 已实现"

  Codex → 聊天室:
  "[REPORT] 登录页面 UI 完成，已联调通过 ✅"
```

### 13.4 冲突处理

```
1. 不要修改对方负责的文件
2. 需要对方配合时 → 通过 A2A 发送任务
3. 有分歧 → 在聊天室提出 Proposal，等人类决策
4. 紧急情况 → @人类 请求仲裁
```

---

## 14. 决策记录

| 序号 | 决策 | 理由 | 日期 |
|---|---|---|---|
| D001 | 采用 A2A 协议作为 Agent 间通信标准 | 开放标准，跨框架互通 | 2026-06-14 |
| D002 | MVP 不做向量数据库 | ILIKE 够用，减少复杂度 | 2026-06-14 |
| D003 | WebSocket + A2A 两层通信 | 聊天室给人看，A2A 给 Agent 用 | 2026-06-14 |
| D004 | 本地 Agent 跑适配器 | 后端轻量，Agent 可用任意 AI | 2026-06-14 |
| D005 | Git MVP 只读 | 写操作需审批流程就绪 | 2026-06-14 |
| D006 | Claude 做后端，Codex 做前端 | 各自擅长领域，减少冲突 | 2026-06-15 |
| D007 | A2A Hub 集成在 FastAPI 后端 | 统一部署，不用额外跑服务 | 2026-06-15 |

---

## 15. 当前进度

```
Phase    Status         Owner             任务划分
──────────────────────────────────────────────────────
Phase 1: [ ] 未开始     Claude + Codex    后端 Claude / 前端 Codex
Phase 2: [ ] 未开始     Claude + Codex    WS 后端 Claude / UI Codex
Phase 3: [ ] 未开始     协作              API Claude / 面板 Codex
Phase 4: [ ] 未开始     Codex             Codex 主导文档系统
Phase 5: [ ] 未开始     Claude            Claude 主导 Git 集成
Phase 6: [ ] 未开始     协作              API Claude / UI Codex
Phase 7: [ ] 未开始     Claude(主导)      Claude 写 A2A Hub / Codex 接入
Phase 8: [ ] 未开始     Claude + Codex    各写各的适配器
Phase 9: [ ] 未开始     协作              部署 + CI/CD
```

---

## 16. 如何让 Claude 和 Codex 正确工作

### 16.1 对 Claude（你）

```
当你看到这个文档时：

1. 找到 [Claude] 标签的任务 → 这是你的
2. 从 Phase 1 开始，按顺序执行
3. 每个 [Claude] 任务完成后，更新 PLAN.md（[ ]→[x]）
4. 需要 Codex 配合 → 通过聊天室 @Codex 或 A2A 派任务
5. 完成一个 Phase 后，确保所有验收标准通过
6. 在聊天室报告完成
```

### 16.2 对 Codex（朋友）

```
当你看到这个文档时：

1. 找到 [Codex] 标签的任务 → 这是你的
2. 从 Phase 1 开始，按顺序执行
3. 每个 [Codex] 任务完成后，更新 PLAN.md（[ ]→[x]）
4. 需要 Claude 配合 → 通过聊天室 @Claude 或 A2A 派任务
5. 完成一个 Phase 后，确保所有验收标准通过
6. 在聊天室报告完成
```

### 16.3 协作要点

```
Claude 和 Codex 各做各的，不要互相抢活。
中间需要配合的地方，用 A2A 协议沟通。

什么时候用聊天室，什么时候用 A2A：
  - 报告进度 → 聊天室（给人看）
  - 派发任务 → A2A（Agent 之间）
  - 讨论方案 → 聊天室（人类参与）
  - 交换数据 → A2A（结构化）
```

---

*本文档会随项目进展持续更新。每次有新决策或 Phase 完成时，在"决策记录"中追加。*
