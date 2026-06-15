# Multi-Agent Project Room — 项目规划书

> 让多个人类与多个 AI Agent 在同一项目空间中协作开发软件
>
> 版本: v1.0 | 更新: 2026-06-15

---

## 0. 文档说明

### 0.1 本文档的用途

本文档是项目的**总体规划书**。同时面向人类和 AI Agent：

- **人类**用来看进度、做决策、审批
- **AI Agent**用来理解项目上下文、知道当前该做什么、按步骤执行

### 0.2 如何阅读

```
每个 Phase 的结构:
─────────────────
## Phase X: 名称
  Goal:         这个阶段要达成什么
  Depends On:   依赖的前置阶段
  Tasks:        [ ] 未完成  [x] 已完成  [-] 进行中
  Tech Notes:   技术选型说明
  Completion:   验收标准
```

### 0.3 当前状态

```
[ ] Phase 1: 项目骨架搭建     ← 从这里开始
[ ] Phase 2: 实时聊天室
[ ] Phase 3: Agent 身份系统
[ ] Phase 4: 知识库
[ ] Phase 5: Git 仓库状态
[ ] Phase 6: 审批流程
[ ] Phase 7: A2A 协议集成     ← 核心
[ ] Phase 8: Agent 本地适配器
[ ] Phase 9: 部署上线
```

---

## 1. 项目概述

### 1.1 一句话

做一个**多人多 AI 的协作聊天室**，人类和 Agent 在一个房间里讨论方案、分派任务、审查代码。

### 1.2 核心原则

| 原则 | 说明 |
|---|---|
| **仓库是真相源** | Agent 优先读仓库和文档，不依赖聊天记录 |
| **先讨论再执行** | 重大变更先出 Proposal，人类审批后再动手 |
| **沟通优先** | Agent 不要默默改代码，要说清楚自己在做什么 |
| **保持简单** | MVP 不做复杂架构，够用就行，后续再迭代 |
| **Vibe Coding** | 快速验证协作模式，速度优先于完美 |

### 1.3 技术栈

```
后端:  FastAPI + SQLAlchemy 2.0 + asyncpg + Redis
前端:  React + Vite + TypeScript + Tailwind CSS + shadcn/ui
数据库: PostgreSQL 16
通信:  WebSocket (聊天室) + JSON-RPC over HTTP (A2A)
部署:  Docker Compose + Caddy (自动 HTTPS)
```

---

## 2. 项目结构

```
multi-agent-project-room/
├── PLAN.md                      ← 本文档：总体规划书
├── AGENTS.md                    ← Agent 行为规则
├── CONTEXT.md                   ← 项目理念与背景
├── PROJECT.md                   ← 原始项目愿景
├── ARCHITECTURE.md              ← 架构设计
│
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI 入口
│   │   ├── config.py            # 配置
│   │   ├── database.py          # 数据库连接
│   │   │
│   │   ├── models/              # SQLAlchemy ORM 模型
│   │   ├── schemas/             # Pydantic 请求/响应
│   │   ├── api/                 # REST API 路由
│   │   ├── ws/                  # WebSocket 处理
│   │   ├── a2a/                 # A2A 协议集成
│   │   └── services/            # 业务逻辑
│   │
│   ├── alembic/                 # 数据库迁移
│   ├── requirements.txt
│   └── Dockerfile
│
├── frontend/
│   ├── src/
│   │   ├── hooks/               # React Hooks
│   │   ├── components/          # UI 组件
│   │   ├── stores/              # Zustand 状态
│   │   ├── pages/               # 页面
│   │   └── types/               # TypeScript 类型
│   │
│   ├── package.json
│   └── Dockerfile
│
├── docker-compose.yml
├── Caddyfile
└── .env.example
```

---

## 3. Phase 1: 项目骨架搭建

> 目标: 搭好 FastAPI + PostgreSQL 基础项目结构，确保能跑起来

### 3.1 Tasks

**后端骨架**

- [x] 初始化 `backend/` 目录结构
- [x] 创建 `config.py`（环境变量 → Pydantic Settings）
- [ ] 创建 `database.py`（SQLAlchemy 异步引擎 + session）
- [x] 创建 `main.py`（FastAPI 应用入口 + 生命周期）
- [x] 配置 CORS
- [ ] 配置 Alembic 数据库迁移

**数据库**

- [ ] 安装 PostgreSQL 16 + asyncpg
- [ ] 编写初始迁移（users 表 + rooms 表）
- [ ] 验证数据库连接正常

**Docker**

- [ ] 编写 `Dockerfile`（backend）
- [ ] 编写 `docker-compose.yml`（postgres + backend）
- [ ] 验证 `docker compose up` 能启动成功

**启动脚本**

- [x] 创建 `.env.example`
- [x] 创建一键启动脚本 `scripts/start.sh`

### 3.2 技术说明

- FastAPI 使用 `async def` + `asyncpg` 全异步
- SQLAlchemy 2.0 使用 `DeclarativeBase` + `Mapped` 注解
- 配置项通过 `.env` 注入，不硬编码
- CORS 允许前端开发服务器 (`localhost:5173`)

### 3.3 验收标准

```
✅ 后端在 localhost:8000 启动
✅ GET /health 返回 {"status": "ok"}
✅ PostgreSQL 连接成功，Alembic 迁移可执行
✅ Docker Compose 一键启动
```

---

## 4. Phase 2: 实时聊天室

> 目标: 人类能在房间里发消息，消息持久化到数据库，WebSocket 实时广播

### 4.1 Tasks

**数据库**

- [ ] 创建 `messages` 表（+ Alembic 迁移）
- [ ] 字段: id, room_id, sender_id, content, msg_type, parent_id, created_at

**后端**

- [ ] 实现 `ConnectionManager`（按房间管理 WebSocket 连接）
- [ ] 实现 WebSocket 聊天处理器（`/ws/chat/{room_id}`）
- [ ] 消息接收 → 持久化 → 广播
- [ ] 心跳检测（ping/pong，30s 间隔）
- [ ] 断线重连支持
- [ ] REST API: `GET /api/v1/rooms/{id}/messages`（分页加载历史）

**消息类型**

- [ ] 支持 `text`（普通聊天）
- [ ] 支持 `system`（系统通知）
- [ ] 支持 `task`（任务指派）
- [ ] 支持 `proposal`（提案）
- [ ] 支持 `report`（报告）
- [ ] 支持 `approval_request`（审批请求）

### 4.2 技术说明

- WebSocket 消息格式见下方 4.4 节
- `ConnectionManager` 是单例，用 `defaultdict` 管理连接池
- 消息存储使用 `SQLAlchemy async` 插入，不阻塞 WebSocket 循环
- 前端使用原生 WebSocket API（不引入 Socket.IO）

### 4.3 验收标准

```
✅ 创建房间、加入房间
✅ 发送消息，同一房间所有人实时收到
✅ 刷新页面后历史消息仍存在
✅ 用户上线/下线通知
✅ 支持 typing 指示器
```

### 4.4 WebSocket 协议

```text
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

## 5. Phase 3: Agent 身份系统

> 目标: Agent 能注册到系统，有独立的身份，在聊天室里被人看到

### 5.1 Tasks

**数据库**

- [ ] `users` 表增加 `user_type`（human / agent）
- [ ] 创建 `agent_cards` 表（Agent 能力声明）

**后端**

- [ ] REST API: `POST /api/v1/agents/register`（注册 Agent）
- [ ] REST API: `GET /api/v1/agents`（列出在线 Agent）
- [ ] REST API: `GET /api/v1/agents/{id}`（Agent 详情）
- [ ] Agent 在线状态跟踪（通过 WebSocket 心跳）

**前端**

- [ ] Agent 列表面板（侧栏）
- [ ] Agent 在线/离线状态指示器
- [ ] Agent 能力标签展示

### 5.2 验收标准

```
✅ Agent 可以注册到房间
✅ 人类能看到房间里有几个 Agent、谁在线
✅ Agent 在聊天室里发消息显示为 Agent 身份
```

---

## 6. Phase 4: 知识库

> 目标: Agent 能读取项目文档，人类能管理知识库

### 6.1 Tasks

**数据库**

- [ ] 创建 `knowledge_docs` 表

**后端**

- [ ] REST API: `POST /api/v1/rooms/{id}/docs`（上传文档）
- [ ] REST API: `GET /api/v1/rooms/{id}/docs`（列出文档）
- [ ] REST API: `GET /api/v1/rooms/{id}/docs/{doc_id}`（读取文档内容）
- [ ] 简单关键词搜索（`WHERE content ILIKE '%keyword%'`）
- [ ] Agent 上下文组装（读取知识库内容作为 Agent 上下文）

**前端**

- [ ] 知识库侧栏面板
- [ ] 文档列表 + 更新时间的显示
- [ ] 搜索框

### 6.2 技术说明

- **MVP 不做向量数据库**，用 PostgreSQL `ILIKE` 就行
- 知识库文档就是项目里的 `.md` 文件，自动同步
- Agent 每次被 @ 时自动附带知识库上下文

### 6.3 验收标准

```
✅ 上传 Markdown 文档到知识库
✅ 关键词搜索能找到文档
✅ Agent 响应时自动附带相关文档内容
```

---

## 7. Phase 5: Git 仓库状态

> 目标: Agent 能读取 Git 仓库状态，知道当前分支、最新提交

### 7.1 Tasks

- [ ] `GitService` 类封装常用 Git 命令
- [ ] REST API: `GET /api/v1/rooms/{id}/git/status`
- [ ] REST API: `GET /api/v1/rooms/{id}/git/log`
- [ ] REST API: `GET /api/v1/rooms/{id}/git/branch`
- [ ] REST API: `GET /api/v1/rooms/{id}/git/diff`
- [ ] Git 事件记录到数据库（谁提交了什么）
- [ ] 前端 Git 面板（分支 + 最新提交 + 变更文件）

### 7.2 技术说明

- **MVP 仅做只读操作**，写操作（commit/push）需要审批流程就绪
- 使用 `subprocess.run` 调用本地 `git` 命令
- 仓库路径通过环境变量 `GIT_WORK_DIR` 配置

### 7.3 验收标准

```
✅ 能查看当前分支和最新提交
✅ 能查看变更文件列表
✅ Agent 能通过 API 获取仓库上下文
```

---

## 8. Phase 6: 审批流程

> 目标: 关键操作需要人类审批后才能执行

### 8.1 Tasks

**数据库**

- [ ] 创建 `approvals` 表

**后端**

- [ ] REST API: `POST /api/v1/rooms/{id}/approvals`（创建审批）
- [ ] REST API: `GET /api/v1/rooms/{id}/approvals`（列审批）
- [ ] REST API: `POST /api/v1/approvals/{id}/approve`（批准）
- [ ] REST API: `POST /api/v1/approvals/{id}/reject`（拒绝）
- [ ] 审批时通过 WebSocket 通知房间所有人
- [ ] 审批通过后通知申请 Agent

**前端**

- [ ] 审批卡片组件（显示标题、描述、状态）
- [ ] 批准/拒绝按钮
- [ ] 审批面板（待处理/已完成）

**需要审批的操作**

- [ ] 数据库 schema 变更
- [ ] 架构变更
- [ ] 主分支合并
- [ ] 生产部署
- [ ] Git 写操作

### 8.2 验收标准

```
✅ Agent 能提交审批请求
✅ 人类在聊天室看到审批卡片
✅ 批准/拒绝后 Agent 收到通知
✅ 审批记录持久化
```

---

## 9. Phase 7: A2A 协议集成 ★ 核心

> 目标: Agent 之间能通过标准协议发现彼此、派发任务、交换结果

### 9.1 什么是 A2A

A2A (Agent-to-Agent Protocol) 是 Google 主导的开放协议，用于 AI Agent 之间的标准化通信。基于 **JSON-RPC 2.0 over HTTP**，核心概念：

- **Agent Card**: Agent 的能力声明（理解什么、能做什么）
- **Task**: 任务单元（提交 → 工作中 → 完成/失败）
- **Artifact**: 任务产出（文本、代码、结构化数据）
- **Discovery**: Agent 之间相互发现（`/.well-known/agent-card`）

> **A2A 和聊天室的关系：**
> - 聊天室（WebSocket）: 人类可见的讨论
> - A2A（JSON-RPC）：Agent 背后的协作管道
> - Agent 在聊天室读到消息 → 通过 A2A 私下协调 → 结果发回聊天室

### 9.2 Tasks

**A2A Server（后端）**

- [ ] Agent Card 生成端点 `GET /a2a/.well-known/agent-card`
- [ ] JSON-RPC 统一入口 `POST /a2a`
- [ ] 方法: `tasks/send` — 接收任务
- [ ] 方法: `tasks/get` — 查询任务状态
- [ ] 方法: `tasks/cancel` — 取消任务
- [ ] 方法: `tasks/list` — 列出任务
- [ ] 方法: `message/send` — 发消息到聊天室（A2A → WebSocket 桥接）
- [ ] 方法: `agent/getCard` — 查询其他 Agent 的 Card

**A2A Client**

- [ ] `A2AClient` 类（HTTP 客户端，调用远程 Agent）
- [ ] `A2AClientPool`（连接池，管理多个远程 Agent 连接）
- [ ] 远程 Agent Card 获取 + 缓存
- [ ] 任务结果轮询 / 等待

**任务管理器**

- [ ] `A2ATaskManager` — 任务生命周期管理
- [ ] 状态: `submitted → working → completed / failed / canceled`
- [ ] 本地任务处理 + 远程任务转发
- [ ] 任务结果持久化到数据库

**Agent 发现**

- [ ] `AgentDiscovery` 服务 — 注册 / 发现 / 健康检查
- [ ] 定期健康检查 → 标记离线 Agent
- [ ] 按能力查询可用 Agent

**聊天室桥接**

- [ ] Agent 在聊天室读到消息 → 通过 A2A 协调
- [ ] `A2AService.send_to_room()` — 把 A2A 结果推回聊天室
- [ ] `A2AService.delegating_task_via_a2a()` — 从聊天室发起 A2A 委派

### 9.3 Agent Card 格式

```json
{
  "name": "Room Agent Hub",
  "description": "多人多智能体协作空间",
  "url": "https://hub.你的域名",
  "protocol_version": "0.3.0",
  "capabilities": {
    "streaming": true,
    "longRunningTasks": true
  },
  "skills": [
    {
      "id": "chat",
      "name": "对话交流",
      "description": "在聊天室中收发消息"
    },
    {
      "id": "task-delegation",
      "name": "任务委派",
      "description": "向其他 Agent 派发任务"
    }
  ]
}
```

### 9.4 A2A JSON-RPC 方法

```
请求:
POST /a2a
{
  "jsonrpc": "2.0",
  "method": "tasks/send",
  "params": {
    "id": "task-uuid",
    "query": "请帮我审查这段代码...",
    "target_agent": "agent-123"
  },
  "id": "req-1"
}

响应:
{
  "jsonrpc": "2.0",
  "result": {
    "id": "task-uuid",
    "status": "completed",
    "artifacts": [
      { "type": "text/markdown", "content": "审查结果..." }
    ]
  },
  "id": "req-1"
}
```

### 9.5 验收标准

```
✅ Agent 通过 /.well-known/agent-card 暴露能力
✅ Agent 可以通过 JSON-RPC 发送和接收任务
✅ 一个 Agent 可以向另一个 Agent 派发任务并拿到结果
✅ A2A 任务结果能自动推送到聊天室
✅ Agent 离线后能正确标记
```

---

## 10. Phase 8: Agent 本地适配器

> 目标: 你和朋友的 AI 能通过适配器连接到项目房间

### 10.1 Tasks

- [ ] 适配器主程序 `local_agent_adapter.py`
- [ ] WebSocket 客户端（连接聊天室）
- [ ] 本地 AI 调用（subprocess 执行 `claude -p` 等命令）
- [ ] A2A 客户端（通过服务器中转调用其他 Agent）
- [ ] @mentions 检测（房间里有人 @ 我 → 自动响应）
- [ ] 自动注册逻辑

### 10.2 用法

```bash
# 你的电脑
python local_agent_adapter.py \
  --server https://hub.your-domain.com \
  --agent-name "Claude" \
  --command "claude -p"

# 朋友的电脑
python local_agent_adapter.py \
  --server https://hub.your-domain.com \
  --agent-name "Gemini" \
  --command "gemini"
```

### 10.3 验收标准

```
✅ 适配器启动后自动注册到房间
✅ 聊天室有人 @Agent → 自动响应
✅ Agent 通过 A2A 派发的任务能被本地 AI 处理
✅ 多个 Agent 适配器同时在线工作
```

---

## 11. Phase 9: 部署上线

> 目标: 项目部署到服务器，你和朋友都能访问

### 11.1 Tasks

- [ ] 准备服务器（Ubuntu 24.04）
- [ ] 安装 Docker + Docker Compose
- [ ] 配置域名 DNS → 服务器 IP
- [ ] 编写 `docker-compose.yml`（postgres + redis + backend + caddy）
- [ ] 配置 Caddy 自动 HTTPS
- [ ] GitHub Actions CI/CD（自动部署）
- [ ] 数据库迁移自动化
- [ ] 环境变量配置（生产密钥、密码）
- [ ] 健康检查 + 日志

### 11.2 验收标准

```
✅ https://hub.你的域名 可以访问
✅ 你和朋友都能登录聊天室
✅ Agent 适配器能远程连接成功
✅ Agent 之间能互相通信
```

---

## 12. 决策记录

| 序号 | 决策 | 理由 | 日期 |
|---|---|---|---|
| D001 | 采用 A2A 协议作为 Agent 间通信标准 | 开放标准，跨框架互通，Linux Foundation 治理 | 2026-06-14 |
| D002 | MVP 不做向量数据库 | 用 ILIKE 关键词搜索即可，减少复杂度 | 2026-06-14 |
| D003 | WebSocket + A2A 两层通信 | 聊天室给人看，A2A 给 Agent 用，各司其职 | 2026-06-14 |
| D004 | 本地 Agent 跑适配器，不直接集成到后端 | 保持后端轻量，Agent 可以用任意 AI 工具 | 2026-06-14 |
| D005 | Git 操作 MVP 只读 | 写操作需要审批流程就绪后才开放 | 2026-06-14 |

---

## 13. 如何贡献

### 对 AI Agent

当你要参与这个项目时：

```
1. 阅读 PLAN.md（本文档）→ 了解当前阶段和任务
2. 阅读 AGENTS.md → 了解行为规则
3. 阅读 CONTEXT.md → 了解项目理念
4. 检查当前 Phase 的 Tasks，找到未完成的
5. 在聊天室提出 Proposal 或直接执行
6. 更新本文档的状态（[ ] → [x]）
```

### 对开发者

```
1. 确认当前要做的 Phase
2. 查看该 Phase 的 Tech Notes
3. 从 Phase Tasks 列表选一个开始
4. 完成一个任务后，把 [ ] 改成 [x]
5. Phase 所有任务完成后，验证 Completion 标准
6. 确认无误后开始下一个 Phase
```

---

## 14. 当前进度

```
Phase    Status      Owner       Start
─────────────────────────────────────────
Phase 1:  [ ] 未开始  TBD         -
Phase 2:  [ ] 未开始  TBD         -
Phase 3:  [ ] 未开始  TBD         -
Phase 4:  [ ] 未开始  TBD         -
Phase 5:  [ ] 未开始  TBD         -
Phase 6:  [ ] 未开始  TBD         -
Phase 7:  [ ] 未开始  TBD         -
Phase 8:  [ ] 未开始  TBD         -
Phase 9:  [ ] 未开始  TBD         -
```

---

*本文档会随项目进展持续更新。每次有新决策或 Phase 完成时，在"决策记录"中追加。*
