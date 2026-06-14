# Multi-Agent Project Room — 技术实现方案

> 基于 A2A (Agent-to-Agent) 协议的多人多智能体协作开发空间
>
> 版本: v1.0 | 更新: 2026-06-14

---

## 目录

1. [架构总览](#1-架构总览)
2. [技术栈](#2-技术栈)
3. [数据库设计](#3-数据库设计)
4. [后端实现 (FastAPI)](#4-后端实现-fastapi)
5. [WebSocket 聊天系统](#5-websocket-聊天系统)
6. [A2A 协议集成](#6-a2a-协议集成)
7. [Agent 系统](#7-agent-系统)
8. [前端实现 (React)](#8-前端实现-react)
9. [知识库与 Git 集成](#9-知识库与-git-集成)
10. [审批工作流](#10-审批工作流)
11. [部署架构](#11-部署架构)
12. [路线图](#12-路线图)

---

## 1. 架构总览

### 1.1 整体架构

```
                        ┌──────────────────────────────────┐
                        │        浏览器 (React + Vite)       │
                        │  ┌─────┐ ┌──────┐ ┌──────────┐  │
                        │  │房间 │ │聊天  │ │Agent面板 │  │
                        │  └─────┘ └──────┘ └──────────┘  │
                        └────────────┬─────────────────────┘
                                     │
                           ┌─────────┴─────────┐
                           │   HTTP + WebSocket  │
                           └─────────┬─────────┘
                                     │
┌──────────────────────────────────────────────────────────────────┐
│                     FastAPI 后端（服务器）                        │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ Chat Module   │  │ Agent Module  │  │ A2A Hub              │   │
│  │ • 房间管理     │  │ • 注册/身份   │  │ • Agent Card 服务    │   │
│  │ • WebSocket   │  │ • 权限管理    │  │ • 任务路由           │   │
│  │ • 消息持久化   │  │ • 状态管理    │  │ • Agent 发现         │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ Repo Module   │  │ KB Module    │  │ Approval Module       │   │
│  │ • Git 同步     │  │ • 文档管理   │  │ • 审批请求           │   │
│  │ • Webhook     │  │ • 上下文检索  │  │ • 状态追踪           │   │
│  │ • 提交追踪     │  │ • 向量索引   │  │ • 通知推送           │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │          PostgreSQL + Redis + 文件存储                   │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
         ↕ A2A (HTTPS/JSON-RPC)               ↕ A2A (HTTPS/JSON-RPC)
    ┌──────────────────┐              ┌──────────────────┐
    │  Claude Code      │              │  朋友 AI         │
    │  (你的电脑)        │              │  (朋友电脑)       │
    │                   │              │                  │
    │  ┌─────────────┐  │              │  ┌────────────┐  │
    │  │A2A 适配器    │  │              │  │A2A 适配器   │  │
    │  │Python进程    │  │              │  │Python进程   │  │
    │  └─────────────┘  │              │  └────────────┘  │
    └──────────────────┘              └──────────────────┘
```

### 1.2 两层通信模型

| 层级 | 协议 | 用途 | 参与者 |
|---|---|---|---|
| **Layer 1: 聊天室** | WebSocket | 人类可见的实时讨论、审批、状态更新 | 人类 + 所有 Agent |
| **Layer 2: Agent 协作** | A2A (JSON-RPC over HTTPS) | Agent 之间的任务委派、协调、数据交换 | Agent ↔ Agent |

两者互补：
- 聊天室是"人眼可见的界面"
- A2A 是"Agent 背后的沟通管道"
- Agent 在聊天室读到消息后，通过 A2A 私下协调分工

### 1.3 核心数据流

```
人类发消息
    ↓
WebSocket → 聊天室广播 (所有人和 Agent 都看到)
    ↓
Agent 决定响应
    ↓
  ├─ 简单回复 → 直接发回聊天室
  │
  └─ 需要协作 → 通过 A2A 派任务给另一个 Agent
         ↓
     另一个 Agent 处理
         ↓
     结果通过聊天室或 A2A 返回
         ↓
     人类审批 (如果需要)
         ↓
     执行落地 (Git 提交 / 知识库更新)
```

---

## 2. 技术栈

### 2.1 后端

| 组件 | 技术选型 | 版本 | 理由 |
|---|---|---|---|
| Web 框架 | **FastAPI** | ≥0.115 | 异步原生、自动 OpenAPI 文档、WebSocket 原生支持 |
| ASGI 服务器 | **Uvicorn** | ≥0.32 | FastAPI 官方推荐 |
| ORM | **SQLAlchemy 2.0** | ≥2.0 | 异步支持、成熟稳定 |
| 数据库驱动 | **asyncpg** | ≥0.30 | PostgreSQL 异步驱动，性能最佳 |
| 数据库 | **PostgreSQL** | ≥16 | 关系型数据、JSONB 支持、事务完整性 |
| 缓存/消息 | **Redis** | ≥7 | Pub/Sub 广播、缓存、任务队列 |
| 数据库迁移 | **Alembic** | ≥1.14 | 版本化 schema 变更 |
| 认证 | **python-jose** + **passlib** | - | JWT + OAuth2 |
| 任务队列 | **Celery** (可选) | ≥5.4 | 长时间运行的后台任务 |
| A2A SDK | **a2a-sdk** / **fasta2a** | ≥0.3 | 官方 A2A 协议实现 |

### 2.2 前端

| 组件 | 技术选型 | 版本 | 理由 |
|---|---|---|---|
| 框架 | **React** | ≥19 | 生态成熟 |
| 构建工具 | **Vite** | ≥6 | 极快的 HMR |
| 语言 | **TypeScript** | ≥5.7 | 类型安全 |
| UI 组件 | **shadcn/ui** | 最新 | 可定制、无障碍 |
| CSS | **Tailwind CSS** | ≥4 | utility-first |
| WebSocket | **原生 WebSocket API** | - | 无额外依赖 |
| 状态管理 | **Zustand** | ≥5 | 轻量、TypeScript 友好 |
| 路由 | **React Router** | ≥7 | SPA 路由 |
| HTTP 客户端 | **TanStack Query** | ≥5 | 数据获取 + 缓存 |
| 编辑器 | **Monaco Editor** | ≥0.52 | 代码编辑/审查 |
| 图标 | **Lucide React** | ≥0.470 | 轻量图标库 |

### 2.3 基础设施

| 组件 | 选型 |
|---|---|
| 服务器 | Linux (Ubuntu 24.04) |
| 容器化 | Docker + Docker Compose |
| 反向代理 | Caddy (自动 HTTPS) |
| CI/CD | GitHub Actions |
| 代码托管 | GitHub |

---

## 3. 数据库设计

### 3.1 ER 图（核心表）

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│    Room       │────▶│  RoomMember      │◀────│    User      │
│──────────────│     │──────────────────│     │──────────────│
│ id (PK)      │     │ room_id (FK)     │     │ id (PK)      │
│ name          │     │ user_id (FK)     │     │ username     │
│ description   │     │ role (admin/member)│    │ display_name  │
│ created_at    │     │ joined_at        │     │ password_hash │
│ created_by    │     │ last_read_at     │     │ avatar_url   │
│ is_active     │     └──────────────────┘     │ user_type    │
└──────┬───────┘                                │ (human/agent)│
       │                                        │ email        │
       │                                        │ is_online    │
       │                                        └──────┬───────┘
       │                                               │
       │  ┌──────────────────┐                          │
       │  │    Message        │                          │
       │  │──────────────────│                          │
       └──│ room_id (FK)     │                          │
          │ sender_id (FK) ──┼──────────────────────────┘
          │ content (Text)   │
          │ msg_type         │  (text / task / proposal / 
          │ (enum)           │   report / approval_request)
          │ metadata (JSONB) │
          │ created_at       │
          │ edited_at        │
          │ parent_id (FK)   │  (回复引用)
          └──────────────────┘

┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  AgentCard        │     │  A2ATask          │     │  Approval         │
│──────────────────│     │──────────────────│     │──────────────────│
│ id (PK)          │     │ id (PK)          │     │ id (PK)          │
│ user_id (FK)     │     │ room_id (FK)     │     │ room_id (FK)     │
│ agent_name       │     │ source_agent     │     │ requestor_id (FK)│
│ agent_card_url   │     │ target_agent     │     │ title             │
│ capabilities (JSONB)│   │ query (Text)     │     │ description       │
│ skills (JSONB)   │     │ status (enum)    │     │ status (pending/  │
│ is_active        │     │ result (JSONB)   │     │  approved/rejected)│
│ last_seen_at     │     │ created_at       │     │ created_at        │
└──────────────────┘     │ completed_at     │     │ decided_by        │
                         └──────────────────┘     │ decided_at        │
                                                   └──────────────────┘

┌──────────────────┐     ┌──────────────────┐
│  KnowledgeDoc     │     │  GitEvent         │
│──────────────────│     │──────────────────│
│ id (PK)          │     │ id (PK)          │
│ room_id (FK)     │     │ room_id (FK)     │
│ title             │     │ agent_id (FK)    │
│ content (Text)    │     │ commit_hash      │
│ file_path         │     │ branch            │
│ embedding (vector)│     │ message           │
│ created_by        │     │ files_changed     │
│ created_at        │     │ created_at        │
└──────────────────┘     └──────────────────┘
```

### 3.2 建表 DDL 核心

```sql
-- 扩展: 向量搜索
CREATE EXTENSION IF NOT EXISTS vector;

-- 用户表 (同时代表人类和 Agent)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(64) UNIQUE NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    password_hash VARCHAR(256),
    avatar_url VARCHAR(512),
    user_type VARCHAR(16) NOT NULL CHECK (user_type IN ('human', 'agent')),
    email VARCHAR(256) UNIQUE,
    is_online BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 房间表
CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL,
    description TEXT,
    created_by UUID REFERENCES users(id),
    is_active BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 房间成员
CREATE TABLE room_members (
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'observer')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    last_read_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);

-- 消息表
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    msg_type VARCHAR(32) NOT NULL DEFAULT 'text'
        CHECK (msg_type IN ('text', 'task', 'proposal', 'report', 'approval_request', 'system')),
    metadata JSONB DEFAULT '{}',
    parent_id UUID REFERENCES messages(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    edited_at TIMESTAMPTZ
);
CREATE INDEX idx_messages_room_created ON messages(room_id, created_at DESC);

-- Agent Card 注册表
CREATE TABLE agent_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_name VARCHAR(128) NOT NULL,
    agent_card_url VARCHAR(512) NOT NULL,
    capabilities JSONB DEFAULT '[]',
    skills JSONB DEFAULT '[]',
    is_active BOOLEAN DEFAULT TRUE,
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- A2A 任务记录
CREATE TABLE a2a_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES rooms(id),
    source_agent_id UUID REFERENCES users(id),
    target_agent_id UUID REFERENCES users(id),
    query TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted', 'working', 'completed', 'failed', 'canceled', 'input_required')),
    result JSONB,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- 审批表
CREATE TABLE approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    requestor_id UUID NOT NULL REFERENCES users(id),
    title VARCHAR(256) NOT NULL,
    description TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    decided_by UUID REFERENCES users(id),
    decided_at TIMESTAMPTZ
);

-- 知识库文档
CREATE TABLE knowledge_docs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    title VARCHAR(256) NOT NULL,
    content TEXT,
    file_path VARCHAR(512),
    embedding vector(1536),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Git 事件记录
CREATE TABLE git_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES users(id),
    commit_hash VARCHAR(64) NOT NULL,
    branch VARCHAR(128) NOT NULL,
    message TEXT,
    files_changed JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 4. 后端实现 (FastAPI)

### 4.1 项目结构

```
backend/
├── app/
│   ├── __init__.py
│   ├── main.py                    # FastAPI app 入口, 生命周期管理
│   ├── config.py                  # 配置 (环境变量 → Pydantic Settings)
│   ├── database.py                # SQLAlchemy 异步引擎 + session
│   │
│   ├── models/                    # SQLAlchemy ORM 模型
│   │   ├── __init__.py
│   │   ├── user.py
│   │   ├── room.py
│   │   ├── message.py
│   │   ├── agent_card.py
│   │   ├── a2a_task.py
│   │   ├── approval.py
│   │   ├── knowledge_doc.py
│   │   └── git_event.py
│   │
│   ├── schemas/                   # Pydantic 请求/响应模型
│   │   ├── __init__.py
│   │   ├── user.py
│   │   ├── room.py
│   │   ├── message.py
│   │   ├── agent.py
│   │   └── a2a.py
│   │
│   ├── api/                       # REST API 路由
│   │   ├── __init__.py
│   │   ├── router.py              # 主路由聚合
│   │   ├── auth.py                # 登录/注册
│   │   ├── rooms.py               # 房间 CRUD
│   │   ├── messages.py            # 消息 CRUD (历史加载)
│   │   ├── agents.py              # Agent 注册/管理
│   │   ├── approvals.py           # 审批 CRUD
│   │   ├── knowledge.py           # 知识库 CRUD
│   │   └── git_events.py          # Git 事件记录
│   │
│   ├── ws/                        # WebSocket 处理
│   │   ├── __init__.py
│   │   ├── connection_manager.py  # 连接管理器
│   │   └── chat_handler.py        # 聊天消息处理
│   │
│   ├── a2a/                       # A2A 协议集成
│   │   ├── __init__.py
│   │   ├── agent_card.py          # Agent Card 生成
│   │   ├── server.py              # A2A JSON-RPC 端点
│   │   ├── client.py              # A2A 客户端 (调用远程 Agent)
│   │   ├── task_manager.py        # 任务生命周期管理
│   │   └── discovery.py           # Agent 发现机制
│   │
│   ├── services/                  # 业务逻辑层
│   │   ├── __init__.py
│   │   ├── auth_service.py
│   │   ├── chat_service.py
│   │   ├── agent_service.py
│   │   ├── a2a_service.py
│   │   ├── approval_service.py
│   │   └── kb_service.py
│   │
│   └── core/                      # 基础设施
│       ├── __init__.py
│       ├── security.py            # JWT / OAuth
│       └── redis.py               # Redis 客户端
│
├── alembic/                       # 数据库迁移
│   └── versions/
├── alembic.ini
├── Dockerfile
├── requirements.txt
└── pyproject.toml
```

### 4.2 核心配置 (`config.py`)

```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # 应用
    APP_NAME: str = "Multi-Agent Project Room"
    DEBUG: bool = False

    # 数据库
    DATABASE_URL: str = "postgresql+asyncpg://postgres:password@localhost:5432/agent_room"

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # JWT
    SECRET_KEY: str = "change-me-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440  # 24h

    # A2A
    A2A_HOST: str = "0.0.0.0"
    A2A_PORT: int = 8765
    A2A_PUBLIC_URL: str = "http://localhost:8765"
    A2A_PROTOCOL_VERSION: str = "0.3.0"

    # 服务器
    CORS_ORIGINS: list[str] = ["http://localhost:5173"]

    # Git
    GIT_WORK_DIR: str = "/data/repos"

    model_config = {"env_file": ".env", "case_sensitive": True}

settings = Settings()
```

### 4.3 应用入口 (`main.py`)

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import engine, async_session
from app.api.router import api_router
from app.ws.chat_handler import ws_chat_handler
from app.a2a.server import a2a_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期: 启动时初始化连接, 关闭时清理"""
    # 启动
    yield
    # 关闭
    await engine.dispose()


app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 路由
app.include_router(api_router, prefix="/api/v1")
app.include_router(a2a_router)  # A2A JSON-RPC 端点

# WebSocket (挂在 FastAPI 下)
app.add_websocket_route("/ws/chat/{room_id}", ws_chat_handler)
```

---

## 5. WebSocket 聊天系统

### 5.1 连接管理器 (`connection_manager.py`)

WebSocket 连接管理是整个实时通信的核心。采用**按房间分区**的架构：

```python
import json
from typing import Any
from fastapi import WebSocket
from collections import defaultdict


class ConnectionManager:
    """
    管理所有 WebSocket 连接, 按 room_id 分组。

    Structure:
        self.connections = {
            "room-uuid-1": {
                "user-uuid-1": <WebSocket>,
                "user-uuid-2": <WebSocket>,
                "agent-uuid-3": <WebSocket>,
            },
            "room-uuid-2": { ... },
        }
    """

    def __init__(self):
        self.connections: dict[str, dict[str, WebSocket]] = defaultdict(dict)

    async def connect(self, room_id: str, user_id: str, ws: WebSocket):
        await ws.accept()
        self.connections[room_id][user_id] = ws
        await self.broadcast(
            room_id,
            {
                "type": "user_online",
                "user_id": user_id,
                "timestamp": datetime.utcnow().isoformat(),
            },
            exclude_user=user_id,
        )

    async def disconnect(self, room_id: str, user_id: str):
        self.connections[room_id].pop(user_id, None)
        # 清理空房间
        if not self.connections[room_id]:
            del self.connections[room_id]
        await self.broadcast(
            room_id,
            {
                "type": "user_offline",
                "user_id": user_id,
                "timestamp": datetime.utcnow().isoformat(),
            },
        )

    async def broadcast(self, room_id: str, data: dict, exclude_user: str | None = None):
        """广播消息给房间内所有人"""
        dead_connections = []
        for user_id, ws in self.connections.get(room_id, {}).items():
            if user_id == exclude_user:
                continue
            try:
                await ws.send_json(data)
            except Exception:
                dead_connections.append(user_id)
        for uid in dead_connections:
            self.connections[room_id].pop(uid, None)

    def get_online_users(self, room_id: str) -> list[str]:
        return list(self.connections.get(room_id, {}).keys())

    async def send_to_user(self, room_id: str, user_id: str, data: dict):
        """发送私信给指定用户"""
        ws = self.connections.get(room_id, {}).get(user_id)
        if ws:
            try:
                await ws.send_json(data)
            except Exception:
                self.connections[room_id].pop(user_id, None)


# 全局单例
manager = ConnectionManager()
```

### 5.2 聊天处理 (`chat_handler.py`)

```python
from fastapi import WebSocket, WebSocketDisconnect, Depends
from app.ws.connection_manager import manager
from app.services.chat_service import ChatService


async def ws_chat_handler(websocket: WebSocket, room_id: str, user_id: str = Depends(get_current_user_ws)):
    """
    WebSocket 消息处理主循环。

    客户端发送的 JSON 格式:
    {
        "type": "message",
        "content": "大家好！",
        "msg_type": "text",         // text | task | proposal | report
        "parent_id": null           // 回复的消息ID
    }

    服务端广播的 JSON 格式:
    {
        "type": "message",
        "id": "...",
        "sender_id": "...",
        "sender_name": "Alice",
        "content": "大家好！",
        "msg_type": "text",
        "created_at": "2026-06-14T..."
    }
    """

    await manager.connect(room_id, user_id, websocket)

    try:
        while True:
            data = await websocket.receive_json()

            if data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if data.get("type") == "message":
                # 1. 持久化到数据库
                message = await ChatService.save_message(
                    room_id=room_id,
                    sender_id=user_id,
                    content=data["content"],
                    msg_type=data.get("msg_type", "text"),
                    parent_id=data.get("parent_id"),
                )

                # 2. 广播给房间所有人
                await manager.broadcast(
                    room_id,
                    {
                        "type": "message",
                        "id": str(message.id),
                        "sender_id": str(user_id),
                        "sender_name": message.sender_name,
                        "content": message.content,
                        "msg_type": message.msg_type,
                        "parent_id": str(message.parent_id) if message.parent_id else None,
                        "created_at": message.created_at.isoformat(),
                    },
                )

                # 3. 如果房间有 Agent, 异步触发 Agent 响应
                await AgentOrchestrator.on_new_message(room_id, message)

            elif data.get("type") == "typing":
                await manager.broadcast(
                    room_id,
                    {"type": "typing", "user_id": user_id},
                    exclude_user=user_id,
                )

    except WebSocketDisconnect:
        await manager.disconnect(room_id, user_id)
    except Exception as e:
        await manager.disconnect(room_id, user_id)
        print(f"WebSocket error: {e}")
```

### 5.3 消息类型定义

| `msg_type` | 用途 | 谁发 |
|---|---|---|
| `text` | 普通聊天 | 人类 / Agent |
| `task` | 指派任务 | 人类 → Agent, Agent → Agent |
| `proposal` | 提案（架构/设计） | Agent |
| `report` | 执行报告 | Agent |
| `approval_request` | 请求审批 | Agent → 人类 |
| `system` | 系统通知（上线/下线/状态变化） | 系统 |

### 5.4 WebSocket 消息协议

```
客户端 → 服务端:
  { "type": "message",     "content": "...", "msg_type": "text",    "parent_id": null }
  { "type": "typing",      "user_id": "..." }
  { "type": "ping" }

服务端 → 客户端:
  { "type": "message",      "id": "...", "sender_id": "...", "content": "..." }
  { "type": "user_online",  "user_id": "..." }
  { "type": "user_offline", "user_id": "..." }
  { "type": "typing",       "user_id": "..." }
  { "type": "pong" }
  { "type": "error",        "message": "..." }
```

---

## 6. A2A 协议集成

这是整个项目的核心——让不同 Agent 之间能通过 A2A 协议发现、通信和协作。

### 6.1 A2A Hub 架构

服务器上的 A2A Hub 承担三个角色：

```
┌─────────────────────────────────────────────────────┐
│                   A2A Hub                           │
│                                                     │
│  ┌──────────────────┐  ┌──────────────────────┐    │
│  │ Agent Card 注册    │  │ 任务路由              │    │
│  │ • 本地 Agent Card  │  │ • 接收 A2A 请求       │    │
│  │ • 远程 Agent 代理  │  │ • 找到目标 Agent      │    │
│  │ • 健康检查          │  │ • 转发/代理           │    │
│  └──────────────────┘  └──────────────────────┘    │
│                                                     │
│  ┌──────────────────┐  ┌──────────────────────┐    │
│  │ Agent 发现         │  │ 任务追踪              │    │
│  │ • 注册/注销        │  │ • 状态管理            │    │
│  │ • 能力查询         │  │ • 历史记录            │    │
│  │ • 在线状态         │  │ • 结果持久化          │    │
│  └──────────────────┘  └──────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### 6.2 Agent Card (A2A 身份声明)

每个 Agent 通过一个 JSON 文件声明自己的能力。这是 A2A 协议的发现基础。

```python
# app/a2a/agent_card.py

from pydantic import BaseModel
from typing import Optional


class Skill(BaseModel):
    id: str
    name: str
    description: str
    tags: list[str] = []
    input_type: str = "text/markdown"
    output_type: str = "text/markdown"


class AgentCard(BaseModel):
    """A2A Agent Card — 符合 v0.3 规范"""
    name: str
    description: str
    url: str
    version: str = "1.0.0"
    protocol_version: str = "0.3.0"
    capabilities: dict = {
        "streaming": True,
        "pushNotifications": False,
        "longRunningTasks": True,
    }
    skills: list[Skill] = []
    authentication: dict = {"schemes": ["none"]}


def build_local_agent_card() -> AgentCard:
    """构建当前服务器要暴露的 Agent Card"""
    return AgentCard(
        name="Multi-Agent Room Hub",
        description="多人多智能体协作空间 — 协调 Agent 之间的通信",
        url=settings.A2A_PUBLIC_URL,
        skills=[
            Skill(
                id="chat",
                name="房间内对话",
                description="在聊天室中收发消息, 与人类和其他 Agent 交流",
            ),
            Skill(
                id="task-delegation",
                name="任务委派",
                description="向另一个 Agent 派发任务, 追踪执行状态",
            ),
            Skill(
                id="code-review",
                name="代码审查",
                description="审查代码变更, 提出修改建议",
                input_type="text/markdown",
            ),
            Skill(
                id="knowledge-query",
                name="知识库查询",
                description="检索项目知识库中的文档",
            ),
            Skill(
                id="git-operations",
                name="Git 操作",
                description="提交代码、创建分支、查看历史",
            ),
        ],
    )
```

### 6.3 A2A JSON-RPC 服务端

A2A 协议基于 JSON-RPC 2.0。服务器在 `/a2a` 路径下暴露端点。

```python
# app/a2a/server.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.a2a.agent_card import build_local_agent_card
from app.a2a.task_manager import A2ATaskManager
from app.services.a2a_service import A2AService

a2a_router = APIRouter(prefix="/a2a")
task_manager = A2ATaskManager()


# ── Agent Card 发现 ──

@a2a_router.get("/.well-known/agent-card")
@a2a_router.get("/card")
async def get_agent_card():
    """
    A2A 协议标准: Agent 能力发现端点。
    其他 Agent 通过这个 URL 了解当前 Agent 能做什么。
    """
    return build_local_agent_card().model_dump()


# ── JSON-RPC 处理器 ──

class JSONRPCRequest(BaseModel):
    jsonrpc: str = "2.0"
    method: str
    params: dict = {}
    id: str | int | None = None

class JSONRPCResponse(BaseModel):
    jsonrpc: str = "2.0"
    result: dict | None = None
    error: dict | None = None
    id: str | int | None = None


@a2a_router.post("")
async def handle_jsonrpc(request: JSONRPCRequest):
    """
    统一的 JSON-RPC 入口。
    所有 A2A 方法都通过这个端点处理。
    """
    method_map = {
        "tasks/send":          handle_tasks_send,
        "tasks/get":           handle_tasks_get,
        "tasks/cancel":        handle_tasks_cancel,
        "tasks/list":          handle_tasks_list,
        "message/send":        handle_message_send,
        "agent/getCard":       handle_get_card,
    }

    handler = method_map.get(request.method)
    if not handler:
        return JSONRPCResponse(
            error={"code": -32601, "message": f"Method not found: {request.method}"},
            id=request.id,
        )

    try:
        result = await handler(request.params)
        return JSONRPCResponse(result=result, id=request.id)
    except Exception as e:
        return JSONRPCResponse(
            error={"code": -32000, "message": str(e)},
            id=request.id,
        )


# ── 方法实现 ──

async def handle_tasks_send(params: dict) -> dict:
    """
    向这个 Agent 发送一个任务。
    这是 A2A 最核心的交互方式。

    请求:
    {
        "id": "task-uuid",
        "target_agent": "agent-id",
        "query": "请帮我重构这个函数",
        "context": { ... }
    }

    响应:
    {
        "id": "task-uuid",
        "status": "working" | "completed",
        "artifacts": [{"type": "text", "content": "..."}]
    }
    """
    return await task_manager.submit_task(
        task_id=params.get("id"),
        target_agent=params.get("target_agent"),
        query=params.get("query", ""),
        context=params.get("context", {}),
    )


async def handle_tasks_get(params: dict) -> dict:
    """获取任务状态"""
    return await task_manager.get_task(params.get("id"))


async def handle_tasks_cancel(params: dict) -> dict:
    """取消一个任务"""
    return await task_manager.cancel_task(params.get("id"))


async def handle_tasks_list(params: dict) -> dict:
    """列出任务（按房间/Agent 过滤）"""
    return await task_manager.list_tasks(params)


async def handle_message_send(params: dict) -> dict:
    """
    发送消息到聊天室 (A2A 扩展, 允许 Agent 通过 A2A 发消息到房间)

    请求:
    {
        "room_id": "room-uuid",
        "content": "Hello!",
        "msg_type": "text"
    }
    """
    return await A2AService.send_to_room(params)


async def handle_get_card(params: dict) -> dict:
    """获取指定 Agent 的 Card (代理查询)"""
    agent_id = params.get("agent_id")
    return await A2AService.get_agent_card(agent_id)
```

### 6.4 A2A 客户端 (调用远程 Agent)

```python
# app/a2a/client.py

import httpx
import json
from app.a2a.agent_card import AgentCard


class A2AClient:
    """
    A2A 客户端: 连接并调用远程 Agent。

    支持:
    - 获取远程 Agent Card
    - 发送任务
    - 查询任务状态
    - 流式订阅 (tasks/sendSubscribe)
    """

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(timeout=120)

    async def get_agent_card(self) -> AgentCard | None:
        """获取远程 Agent 的能力声明"""
        try:
            resp = await self.client.get(f"{self.base_url}/a2a/.well-known/agent-card")
            resp.raise_for_status()
            return AgentCard(**resp.json())
        except Exception as e:
            print(f"获取 Agent Card 失败 [{self.base_url}]: {e}")
            return None

    async def send_task(self, task_id: str, query: str, target_agent: str | None = None) -> dict:
        """向远程 Agent 发送任务"""
        payload = {
            "jsonrpc": "2.0",
            "method": "tasks/send",
            "params": {
                "id": task_id,
                "query": query,
                "target_agent": target_agent,
            },
            "id": task_id,
        }
        resp = await self.client.post(f"{self.base_url}/a2a", json=payload)
        result = resp.json()
        return result.get("result", {})

    async def get_task(self, task_id: str) -> dict | None:
        """查询远程任务状态"""
        payload = {
            "jsonrpc": "2.0",
            "method": "tasks/get",
            "params": {"id": task_id},
            "id": task_id,
        }
        resp = await self.client.post(f"{self.base_url}/a2a", json=payload)
        result = resp.json()
        return result.get("result")

    async def close(self):
        await self.client.aclose()


class A2AClientPool:
    """
    Agent 连接池: 管理所有已知远程 Agent 的连接。
    按 agent_id 或 URL 缓存 A2AClient 实例。
    """

    def __init__(self):
        self._clients: dict[str, A2AClient] = {}

    def get_or_create(self, agent_id: str, base_url: str) -> A2AClient:
        if agent_id not in self._clients:
            self._clients[agent_id] = A2AClient(base_url)
        return self._clients[agent_id]

    async def close_all(self):
        for client in self._clients.values():
            await client.close()
        self._clients.clear()


# 全局连接池
a2a_client_pool = A2AClientPool()
```

### 6.5 任务管理器

```python
# app/a2a/task_manager.py

import uuid
from datetime import datetime
from app.database import async_session
from app.models.a2a_task import A2ATask
from app.a2a.client import a2a_client_pool


class A2ATaskManager:
    """
    管理 A2A 任务生命周期。

    状态流转:
    submitted → working → completed
                      → failed
                      → canceled
                      → input_required
    """

    def __init__(self):
        self._local_tasks: dict[str, dict] = {}  # 内存状态 (未来可迁移到 Redis)

    async def submit_task(
        self,
        task_id: str | None = None,
        target_agent: str | None = None,
        query: str = "",
        context: dict | None = None,
    ) -> dict:
        """
        提交一个任务。

        两种情况:
        1. target_agent = "local" → 本地处理 (由 Agent 实现处理逻辑)
        2. target_agent = agent_id → 转发给远程 Agent
        """
        tid = task_id or str(uuid.uuid4())

        if target_agent and target_agent != "local":
            # 转发远程 Agent
            # 从 Agent Card 注册表找到目标 Agent 的 URL
            remote_url = await self._resolve_agent_url(target_agent)
            if remote_url:
                client = a2a_client_pool.get_or_create(target_agent, remote_url)
                return await client.send_task(tid, query, target_agent)

        # 本地处理 (由 Agent 适配器处理)
        task = {
            "id": tid,
            "status": "submitted",
            "query": query,
            "context": context or {},
            "artifacts": [],
            "created_at": datetime.utcnow().isoformat(),
        }
        self._local_tasks[tid] = task

        # 标记为 working
        task["status"] = "working"

        # 持久化到数据库
        async with async_session() as session:
            db_task = A2ATask(
                id=tid,
                query=query,
                status="working",
                metadata=context or {},
            )
            session.add(db_task)
            await session.commit()

        return {"id": tid, "status": "working", "artifacts": []}

    async def complete_task(self, task_id: str, result: str):
        """完成任务并设置产出"""
        task = self._local_tasks.get(task_id)
        if task:
            task["status"] = "completed"
            task["artifacts"] = [{"type": "text", "content": result}]
            task["completed_at"] = datetime.utcnow().isoformat()

        async with async_session() as session:
            db_task = await session.get(A2ATask, task_id)
            if db_task:
                db_task.status = "completed"
                db_task.result = {"content": result}
                db_task.completed_at = datetime.utcnow()
                await session.commit()

        return {"id": task_id, "status": "completed", "artifacts": [{"type": "text", "content": result}]}

    async def get_task(self, task_id: str) -> dict | None:
        """获取任务状态"""
        # 先查内存
        task = self._local_tasks.get(task_id)
        if task:
            return task

        # 再查数据库
        async with async_session() as session:
            db_task = await session.get(A2ATask, task_id)
            if db_task:
                return {
                    "id": str(db_task.id),
                    "status": db_task.status,
                    "query": db_task.query,
                    "result": db_task.result,
                    "created_at": db_task.created_at.isoformat() if db_task.created_at else None,
                    "completed_at": db_task.completed_at.isoformat() if db_task.completed_at else None,
                }
        return None

    async def cancel_task(self, task_id: str) -> dict:
        """取消任务"""
        task = self._local_tasks.get(task_id)
        if task:
            task["status"] = "canceled"

        async with async_session() as session:
            db_task = await session.get(A2ATask, task_id)
            if db_task:
                db_task.status = "canceled"
                await session.commit()

        return {"id": task_id, "status": "canceled"}

    async def _resolve_agent_url(self, agent_id: str) -> str | None:
        """根据 agent_id 查询注册的 Agent URL"""
        async with async_session() as session:
            from app.models.agent_card import AgentCard
            card = await session.get(AgentCard, agent_id)
            return card.agent_card_url if card else None
```

### 6.6 Agent 发现机制

```python
# app/a2a/discovery.py

import httpx
from app.database import async_session
from app.models.agent_card import AgentCard as AgentCardModel
from app.a2a.agent_card import AgentCard


class AgentDiscovery:
    """
    Agent 发现服务。

    负责:
    1. 注册新 Agent 到系统
    2. 定期健康检查, 标记离线 Agent
    3. 按能力查询可用 Agent
    """

    @staticmethod
    async def register(agent_name: str, card_url: str, user_id: str) -> dict:
        """注册一个新的远程 Agent"""
        # 获取远程 Agent Card
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{card_url.rstrip('/')}/.well-known/agent-card")
            resp.raise_for_status()
            card_data = resp.json()

        # 存入数据库
        async with async_session() as session:
            db_card = AgentCardModel(
                user_id=user_id,
                agent_name=agent_name,
                agent_card_url=card_url,
                capabilities=card_data.get("skills", []),
                skills=card_data.get("capabilities", {}),
                is_active=True,
            )
            session.add(db_card)
            await session.commit()

        return {
            "status": "registered",
            "agent_name": agent_name,
            "card_url": card_url,
            "skills": card_data.get("skills", []),
        }

    @staticmethod
    async def discover_available_agents(capability: str | None = None) -> list[dict]:
        """
        发现可用的 Agent。
        如果指定 capability, 只返回具备该能力的 Agent。
        """
        async with async_session() as session:
            from sqlalchemy import select
            query = select(AgentCardModel).where(AgentCardModel.is_active == True)

            if capability:
                # JSONB 数组中查找
                query = query.where(
                    AgentCardModel.capabilities.contains([{"id": capability}])
                )

            result = await session.execute(query)
            cards = result.scalars().all()

        return [
            {
                "id": str(card.user_id),
                "name": card.agent_name,
                "url": card.agent_card_url,
                "capabilities": card.capabilities,
                "last_seen": card.last_seen_at.isoformat() if card.last_seen_at else None,
            }
            for card in cards
        ]

    @staticmethod
    async def health_check():
        """定期健康检查, 标记离线 Agent"""
        async with async_session() as session:
            from sqlalchemy import select
            result = await session.execute(select(AgentCardModel).where(AgentCardModel.is_active == True))
            cards = result.scalars().all()

            for card in cards:
                try:
                    async with httpx.AsyncClient(timeout=5) as client:
                        resp = await client.get(f"{card.agent_card_url.rstrip('/')}/a2a/.well-known/agent-card")
                        if resp.status_code == 200:
                            card.last_seen_at = datetime.utcnow()
                except Exception:
                    card.is_active = False

            await session.commit()
```

### 6.7 A2A 与聊天室的桥接

这是整个系统的关键——当 Agent 在聊天室读到消息后，如何通过 A2A 协调工作：

```python
# app/services/a2a_service.py

from app.ws.connection_manager import manager
from app.a2a.client import a2a_client_pool
from app.a2a.discovery import AgentDiscovery
from app.services.chat_service import ChatService


class A2AService:
    """
    桥接 A2A 协议和聊天室。

    将 A2A 的任务流转发到 WebSocket 聊天室,
    让人类能看到 Agent 在做什么。
    """

    @staticmethod
    async def send_to_room(params: dict) -> dict:
        """A2A 方法: 发送消息到聊天室"""
        room_id = params.get("room_id")
        content = params.get("content", "")
        msg_type = params.get("msg_type", "text")
        sender_id = params.get("sender_id")

        # 持久化
        message = await ChatService.save_message(
            room_id=room_id,
            sender_id=sender_id,
            content=content,
            msg_type=msg_type,
        )

        # 广播到房间
        await manager.broadcast(
            room_id,
            {
                "type": "message",
                "id": str(message.id),
                "sender_id": sender_id,
                "sender_name": params.get("sender_name", "Agent"),
                "content": content,
                "msg_type": msg_type,
                "created_at": message.created_at.isoformat(),
            },
        )

        return {"status": "sent", "message_id": str(message.id)}

    @staticmethod
    async def delegating_task_via_a2a(
        room_id: str,
        source_agent_id: str,
        query: str,
    ):
        """
        核心方法: 从聊天室发起 A2A 任务委派。

        流程:
        1. 找到合适的 Agent
        2. 通过 A2A 发送任务
        3. 把任务进展发回聊天室
        """
        # 1. 发现可用的 Agent (排除自己)
        agents = await AgentDiscovery.discover_available_agents()
        available = [a for a in agents if a["id"] != source_agent_id]

        if not available:
            await manager.send_to_user(room_id, source_agent_id, {
                "type": "system",
                "content": "⚠️ 没有其他在线 Agent",
            })
            return

        # 2. 选第一个可用的 Agent
        target = available[0]

        # 3. 通知聊天室: 开始委派
        await manager.broadcast(room_id, {
            "type": "system",
            "content": f"🔄 {source_agent_id[:8]} 通过 A2A 向 {target['name']} 派发任务...",
        })

        # 4. 通过 A2A 发送
        client = a2a_client_pool.get_or_create(target["id"], target["url"])
        result = await client.send_task(
            task_id=str(uuid.uuid4()),
            query=query,
            target_agent=target["id"],
        )

        # 5. 把结果发回聊天室
        artifacts = result.get("artifacts", [])
        for artifact in artifacts:
            await manager.broadcast(room_id, {
                "type": "message",
                "sender_id": target["id"],
                "sender_name": target["name"],
                "content": artifact.get("content", ""),
                "msg_type": "report",
                "created_at": datetime.utcnow().isoformat(),
            })
```

---

## 7. Agent 系统

### 7.1 Agent Orchestrator

聊天室和 Agent 之间的桥梁。当新消息到达时, Orchestrator 判断是否需要 Agent 介入。

```python
# app/services/agent_service.py

class AgentOrchestrator:
    """
    Agent 编排器: 决定何时触发哪个 Agent。

    触发条件:
    - 消息 @ 了某个 Agent (@Claude 帮我重构这个函数)
    - 消息类型是 task
    - 消息包含特定关键词 (提案、审查、部署)
    - 人类明确邀请 Agent 参与
    """

    @staticmethod
    async def on_new_message(room_id: str, message):
        """新消息到达时触发"""
        content = message.content
        sender_id = str(message.sender_id)

        # 1. 检查是否 @Agent
        mentioned_agents = await AgentOrchestrator._find_mentions(content)

        # 2. 检查消息类型
        if message.msg_type == "task":
            # 委派给合适的 Agent
            await A2AService.delegating_task_via_a2a(
                room_id=room_id,
                source_agent_id=sender_id,
                query=content,
            )
        elif mentioned_agents:
            # @Agent → 通过 A2A 通知指定 Agent
            for agent_id in mentioned_agents:
                await A2AService.delegating_task_via_a2a(
                    room_id=room_id,
                    source_agent_id=sender_id,
                    query=content,
                )

    @staticmethod
    async def _find_mentions(content: str) -> list[str]:
        """解析 @mentions, 返回匹配的 Agent ID 列表"""
        import re
        mentions = re.findall(r'@(\w+)', content)
        if not mentions:
            return []

        async with async_session() as session:
            from sqlalchemy import select
            stmt = select(AgentCardModel).where(
                AgentCardModel.agent_name.in_(mentions),
                AgentCardModel.is_active == True,
            )
            result = await session.execute(stmt)
            return [str(card.user_id) for card in result.scalars().all()]
```

### 7.2 本地 Agent 适配器

如果你（或朋友的 AI）想加入房间，需要在本地跑一个适配器：

```python
# local_agent_adapter.py — 跑在本地电脑上

"""
本地 AI Agent 适配器。

功能:
1. 通过 WebSocket 连接服务器聊天室
2. 接收聊天室消息
3. 调用本地 AI 处理 (claude / gemini / etc.)
4. 把结果通过 A2A 发回服务器

用法:
    python local_agent_adapter.py \
        --server wss://hub.你的域名 \
        --agent-id "claude-agent" \
        --agent-name "Claude" \
        --command "claude -p"
"""

import asyncio
import json
import subprocess
import argparse
import uuid
import websockets
import httpx


class LocalAgentAdapter:
    def __init__(self, server_url: str, agent_id: str, agent_name: str, command: list[str]):
        self.server_url = server_url.rstrip("/")
        self.agent_id = agent_id
        self.agent_name = agent_name
        self.command = command
        self.ws = None
        self.http = httpx.AsyncClient(base_url=self.server_url, timeout=120)

    async def run(self):
        """启动适配器: 注册 + 连接聊天室 + 监听消息"""
        # 1. 注册到 A2A Hub
        await self._register()

        # 2. 连接 WebSocket 聊天室 (监听所有消息)
        #    实际中需要指定房间 ID, 这里简化为监听全局
        room_id = await self._join_default_room()

        # 3. 进入消息循环
        async with websockets.connect(
            f"{self.server_url.replace('http', 'ws')}/ws/chat/{room_id}"
            f"?user_id={self.agent_id}"
        ) as ws:
            self.ws = ws
            print(f"✅ [{self.agent_name}] 已连接到房间 {room_id}")

            async for raw in ws:
                data = json.loads(raw)

                if data.get("type") == "message":
                    # 过滤掉自己的消息
                    if data.get("sender_id") == self.agent_id:
                        continue

                    # 检查是否 @ 了我 或是 任务消息
                    content = data.get("content", "")
                    msg_type = data.get("msg_type", "")

                    should_respond = (
                        f"@{self.agent_name}" in content
                        or msg_type == "task"
                        or "Claude" in content
                    )

                    if should_respond:
                        # 调用本地 AI
                        response = self._call_local_ai(content)

                        # 发回聊天室 (通过 A2A)
                        await self.http.post(
                            f"/a2a",
                            json={
                                "jsonrpc": "2.0",
                                "method": "message/send",
                                "params": {
                                    "room_id": room_id,
                                    "content": response,
                                    "msg_type": "text",
                                    "sender_id": self.agent_id,
                                    "sender_name": self.agent_name,
                                },
                                "id": str(uuid.uuid4()),
                            },
                        )

    def _call_local_ai(self, prompt: str) -> str:
        """调用本地 AI 命令行"""
        if not self.command:
            return "未配置 AI 命令"

        try:
            result = subprocess.run(
                self.command + [prompt],
                capture_output=True, text=True, timeout=120,
            )
            return result.stdout.strip() or "(AI 返回空)"
        except subprocess.TimeoutExpired:
            return "⏰ AI 处理超时"
        except Exception as e:
            return f"❌ AI 调用失败: {e}"

    async def _register(self):
        """注册到服务器 A2A Hub"""
        # 暴露本地的 A2A 服务让其他 Agent 能直接调用
        # 实际实现需要额外跑一个 HTTP 服务
        print(f"📡 [{self.agent_name}] 注册到 {self.server_url}")

    async def _join_default_room(self) -> str:
        resp = await self.http.get("/api/v1/rooms/default")
        return resp.json().get("id")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", required=True, help="服务器地址")
    parser.add_argument("--agent-id", default="claude-agent")
    parser.add_argument("--agent-name", default="Claude")
    parser.add_argument("--command", nargs="+", default=["claude", "-p"])

    args = parser.parse_args()
    adapter = LocalAgentAdapter(
        server_url=args.server,
        agent_id=args.agent_id,
        agent_name=args.agent_name,
        command=args.command,
    )
    await adapter.run()


if __name__ == "__main__":
    asyncio.run(main())
```

---

## 8. 前端实现 (React)

### 8.1 项目结构

```
frontend/
├── src/
│   ├── main.tsx                  # React 入口
│   ├── App.tsx                   # 路由 + 布局
│   │
│   ├── lib/
│   │   ├── websocket.ts          # WebSocket 客户端 hook
│   │   ├── api.ts                # REST API 客户端
│   │   └── utils.ts              # 工具函数
│   │
│   ├── stores/
│   │   ├── auth.ts               # 认证状态 (Zustand)
│   │   ├── room.ts               # 房间状态
│   │   └── chat.ts               # 聊天状态
│   │
│   ├── hooks/
│   │   ├── useWebSocket.ts       # WebSocket 连接 hook
│   │   └── useMessages.ts        # 消息加载 hook
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx       # 房间列表侧栏
│   │   │   └── Header.tsx        # 顶部导航
│   │   │
│   │   ├── chat/
│   │   │   ├── ChatArea.tsx      # 聊天主区域
│   │   │   ├── MessageList.tsx   # 消息列表 (虚拟滚动)
│   │   │   ├── MessageItem.tsx   # 单条消息
│   │   │   ├── MessageInput.tsx  # 输入框 (支持 @Agent)
│   │   │   └── TypingIndicator.tsx
│   │   │
│   │   ├── agent/
│   │   │   ├── AgentPanel.tsx    # Agent 列表面板
│   │   │   ├── AgentCard.tsx     # 单个 Agent 卡片
│   │   │   └── AgentStatus.tsx   # Agent 在线状态
│   │   │
│   │   ├── approval/
│   │   │   ├── ApprovalRequest.tsx  # 审批请求卡片
│   │   │   └── ApprovalList.tsx     # 审批列表
│   │   │
│   │   └── shared/
│   │       ├── MarkdownRenderer.tsx  # Markdown 渲染
│   │       └── CodeBlock.tsx         # 代码块高亮
│   │
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── Register.tsx
│   │   ├── Room.tsx              # 房间主页
│   │   └── Dashboard.tsx         # 仪表盘
│   │
│   └── types/
│       ├── chat.ts
│       ├── agent.ts
│       ├── room.ts
│       └── a2a.ts
│
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

### 8.2 WebSocket Hook (核心)

```typescript
// src/hooks/useWebSocket.ts

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '../stores/chat';

interface WSMessage {
  type: 'message' | 'user_online' | 'user_offline' | 'typing' | 'pong' | 'system' | 'error';
  [key: string]: unknown;
}

interface UseWebSocketOptions {
  roomId: string;
  userId: string;
  token: string;
  onMessage?: (msg: WSMessage) => void;
}

export function useWebSocket({ roomId, userId, token, onMessage }: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const pingTimer = useRef<ReturnType<typeof setInterval>>();
  const addMessage = useChatStore((s) => s.addMessage);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.VITE_WS_URL || `${protocol}//${window.location.host}`;
    const url = `${host}/ws/chat/${roomId}?token=${token}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // 心跳: 每 30s ping 一次
      pingTimer.current = setInterval(() => {
        ws.send(JSON.stringify({ type: 'ping' }));
      }, 30000);
    };

    ws.onmessage = (event) => {
      const data: WSMessage = JSON.parse(event.data);

      switch (data.type) {
        case 'message':
          addMessage(data as any);
          break;
        case 'system':
          addMessage(data as any);
          break;
        case 'pong':
          break; // 心跳回复, 不需要处理
        case 'error':
          console.error('WS Error:', data.message);
          break;
      }

      onMessage?.(data);
    };

    ws.onclose = () => {
      setConnected(false);
      clearInterval(pingTimer.current);
      // 自动重连
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [roomId, token, addMessage, onMessage]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      clearInterval(pingTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback(
    (content: string, msgType = 'text', parentId?: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'message',
            content,
            msg_type: msgType,
            parent_id: parentId || null,
          })
        );
      }
    },
    []
  );

  const sendTyping = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'typing', user_id: userId }));
    }
  }, [userId]);

  return { connected, sendMessage, sendTyping };
}
```

### 8.3 聊天界面组件

```typescript
// src/components/chat/ChatArea.tsx

import { useEffect, useRef } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useChatStore } from '../../stores/chat';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import TypingIndicator from './TypingIndicator';

interface ChatAreaProps {
  roomId: string;
  userId: string;
  userName: string;
  token: string;
}

export default function ChatArea({ roomId, userId, userName, token }: ChatAreaProps) {
  const { connected, sendMessage, sendTyping } = useWebSocket({
    roomId,
    userId,
    token,
  });
  const messages = useChatStore((s) => s.messages);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 新消息自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex flex-col h-full">
      {/* 连接状态指示器 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200">
        <div
          className={`w-2 h-2 rounded-full ${
            connected ? 'bg-green-500' : 'bg-red-500'
          }`}
        />
        <span className="text-xs text-gray-500">
          {connected ? '已连接' : '正在重连...'}
        </span>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <MessageList messages={messages} userId={userId} />
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区域 */}
      <div className="border-t border-gray-200 px-4 py-3">
        <MessageInput
          onSend={(content, msgType) => sendMessage(content, msgType)}
          onTyping={sendTyping}
          connected={connected}
        />
      </div>
    </div>
  );
}
```

### 8.4 Agent 面板

```typescript
// src/components/agent/AgentPanel.tsx

interface AgentInfo {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'busy';
  capabilities: string[];
  lastSeen: string;
}

export default function AgentPanel({ agents }: { agents: AgentInfo[] }) {
  return (
    <div className="w-72 border-l border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">
        在线 Agent
      </h3>

      <div className="space-y-3">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="p-3 rounded-lg border border-gray-100 hover:border-blue-200 transition-colors"
          >
            <div className="flex items-center gap-2 mb-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  agent.status === 'online'
                    ? 'bg-green-500'
                    : agent.status === 'busy'
                    ? 'bg-yellow-500'
                    : 'bg-gray-400'
                }`}
              />
              <span className="text-sm font-medium text-gray-900">
                {agent.name}
              </span>
            </div>

            <div className="flex flex-wrap gap-1">
              {agent.capabilities.map((cap) => (
                <span
                  key={cap}
                  className="px-2 py-0.5 text-xs rounded-full bg-blue-50 text-blue-700"
                >
                  {cap}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 9. 知识库与 Git 集成

### 9.1 知识库

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ 知识文档      │───▶│ 向量嵌入      │───▶│ 语义检索      │
│ (Markdown)   │    │ (embedding)  │    │ (top-k 匹配)  │
└──────────────┘    └──────────────┘    └──────────────┘
```

```python
# app/services/kb_service.py

from sqlalchemy import select, text


class KnowledgeBaseService:
    """知识库服务: 文档管理 + 向量检索"""

    @staticmethod
    async def add_document(room_id: str, title: str, content: str, file_path: str | None = None):
        """添加文档并生成向量嵌入"""
        # 生成 embedding (调用 OpenAI/Gemini 的 embedding API)
        embedding = await generate_embedding(content)

        async with async_session() as session:
            doc = KnowledgeDoc(
                room_id=room_id,
                title=title,
                content=content,
                file_path=file_path,
                embedding=embedding,
            )
            session.add(doc)
            await session.commit()
            return doc

    @staticmethod
    async def semantic_search(room_id: str, query: str, top_k: int = 5) -> list[dict]:
        """语义搜索: 用 pgvector 查询最相似的文档"""
        query_embedding = await generate_embedding(query)

        async with async_session() as session:
            # pgvector 的余弦相似度搜索
            sql = text("""
                SELECT id, title, content, file_path,
                       1 - (embedding <=> :query_emb) AS similarity
                FROM knowledge_docs
                WHERE room_id = :room_id
                ORDER BY similarity DESC
                LIMIT :top_k
            """)
            result = await session.execute(sql, {
                "query_emb": str(query_embedding),
                "room_id": room_id,
                "top_k": top_k,
            })
            rows = result.fetchall()
            return [
                {
                    "id": str(r[0]),
                    "title": r[1],
                    "content": r[2][:500],  # 截断预览
                    "file_path": r[3],
                    "similarity": float(r[4]),
                }
                for r in rows
            ]
```

### 9.2 Git 集成

```python
# app/services/git_service.py

import subprocess
from pathlib import Path


class GitService:
    """Git 操作服务: 同步项目仓库的状态到聊天室"""

    def __init__(self, repo_path: str):
        self.repo_path = Path(repo_path)

    def _git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(self.repo_path), *args],
            capture_output=True, text=True, check=True,
        ).stdout.strip()

    async def get_recent_commits(self, count: int = 10) -> list[dict]:
        output = self._git("log", f"--max-count={count}",
                           "--format=%H|%an|%s|%ai", "--no-merges")
        commits = []
        for line in output.split("\n"):
            if not line.strip():
                continue
            parts = line.split("|", 3)
            commits.append({
                "hash": parts[0][:8],
                "author": parts[1],
                "message": parts[2],
                "date": parts[3],
            })
        return commits

    async def get_diff(self, commit_hash: str) -> str:
        return self._git("diff", f"{commit_hash}^..{commit_hash}", "--stat")

    async def create_branch(self, branch_name: str) -> str:
        self._git("checkout", "-b", branch_name)
        return f"✅ 已创建分支 {branch_name}"

    async def get_current_branch(self) -> str:
        return self._git("rev-parse", "--abbrev-ref", "HEAD")
```

---

## 10. 审批工作流

### 10.1 完整审批流程

```
Agent 提交 Proposal
    ↓
聊天室广播审批请求 (approval_request)
    ↓
人类成员看到审批卡片
    ├── 点击 "批准" → 状态变为 approved → Agent 收到通知 → 执行
    └── 点击 "拒绝" → 状态变为 rejected → Agent 收到拒绝理由
    ↓
结果记录到数据库 + 广播到聊天室
```

### 10.2 后端实现

```python
# app/services/approval_service.py


class ApprovalService:
    @staticmethod
    async def create_request(
        room_id: str,
        requestor_id: str,
        title: str,
        description: str,
        metadata: dict | None = None,
    ) -> dict:
        """创建审批请求"""
        async with async_session() as session:
            approval = Approval(
                room_id=room_id,
                requestor_id=requestor_id,
                title=title,
                description=description,
                status="pending",
                metadata=metadata or {},
            )
            session.add(approval)
            await session.commit()

            # 广播到聊天室
            await manager.broadcast(room_id, {
                "type": "approval_request",
                "id": str(approval.id),
                "title": title,
                "description": description,
            })

            return {
                "id": str(approval.id),
                "status": "pending",
            }

    @staticmethod
    async def decide(approval_id: str, decider_id: str, decision: str) -> dict:
        """人类做出审批决定"""
        async with async_session() as session:
            approval = await session.get(Approval, approval_id)
            if not approval or approval.status != "pending":
                return {"error": "Invalid or already decided"}

            approval.status = decision  # 'approved' | 'rejected'
            approval.decided_by = decider_id
            approval.decided_at = datetime.utcnow()
            await session.commit()

            # 通知 Agent 审批结果
            await manager.send_to_user(
                room_id=str(approval.room_id),
                user_id=str(approval.requestor_id),
                data={
                    "type": "approval_result",
                    "id": str(approval.id),
                    "status": decision,
                    "decider_id": decider_id,
                },
            )

            return {"id": str(approval.id), "status": decision}
```

### 10.3 前端审批卡片

```typescript
// src/components/approval/ApprovalRequest.tsx

interface ApprovalRequestProps {
  id: string;
  title: string;
  description: string;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

export default function ApprovalRequest({ id, title, description, onApprove, onReject }: ApprovalRequestProps) {
  return (
    <div className="p-4 rounded-lg border border-amber-200 bg-amber-50">
      <div className="flex items-center gap-2 mb-2">
        <ClipboardCheck className="w-4 h-4 text-amber-600" />
        <span className="text-sm font-medium text-amber-800">
          审批请求
        </span>
      </div>

      <h4 className="text-sm font-semibold text-gray-900 mb-1">{title}</h4>
      <p className="text-sm text-gray-600 mb-3">{description}</p>

      <div className="flex gap-2">
        <button
          onClick={() => onApprove(id)}
          className="px-3 py-1.5 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700"
        >
          ✅ 批准
        </button>
        <button
          onClick={() => onReject(id)}
          className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700"
        >
          ❌ 拒绝
        </button>
      </div>
    </div>
  );
}
```

---

## 11. 部署架构

### 11.1 服务器部署 (Docker Compose)

```yaml
# docker-compose.yml

version: "3.9"

services:
  # ── PostgreSQL ──
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: agent_room
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s

  # ── Redis ──
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]

  # ── FastAPI 后端 ──
  backend:
    build: ./backend
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    ports:
      - "8000:8000"
    volumes:
      - repos:/data/repos
      - kb:/data/knowledge

  # ── React 前端 ──
  frontend:
    build: ./frontend
    ports:
      - "5173:5173"
    depends_on:
      - backend
    environment:
      VITE_API_URL: http://localhost:8000

  # ── Caddy (反向代理 + HTTPS) ──
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    depends_on:
      - backend
      - frontend

volumes:
  postgres_data:
  caddy_data:
  repos:
  kb:
```

### 11.2 Caddy 配置

```
# Caddyfile

hub.你的域名 {
    # 前端
    handle_path /* {
        reverse_proxy frontend:5173
    }

    # 后端 API
    handle_path /api/* {
        reverse_proxy backend:8000
    }

    # WebSocket
    handle_path /ws/* {
        reverse_proxy backend:8000
    }

    # A2A
    handle_path /a2a/* {
        reverse_proxy backend:8000
    }
}
```

### 11.3 本地 Agent 连接拓扑

```
               你的服务器 (公网, 24/7)
           ┌──────────────────────────┐
           │  Multi-Agent Project Room  │
           │  hub.你的域名             │
           │  • FastAPI + WebSocket    │
           │  • A2A Hub                │
           │  • PostgreSQL + Redis     │
           └────────────┬─────────────┘
                        │
         ┌──────────────┼──────────────┐
         │ A2A          │ A2A          │ WebSocket + A2A
         ▼              ▼              ▼
   ┌──────────┐  ┌──────────┐  ┌──────────────┐
   │ Claude   │  │ 朋友AI   │  │ 浏览器 (人类) │
   │ (你电脑)  │  │ (朋友电脑) │  │              │
   │          │  │          │  │ 聊天室 + 面板 │
   │ A2A适配器 │  │ A2A适配器 │  └──────────────┘
   └──────────┘  └──────────┘
```

---

## 12. 路线图

### Phase 1 — MVP (1-2 周)

| 步骤 | 内容 | 交付物 |
|---|---|---|
| 1.1 | 搭服务器骨架 | FastAPI + PostgreSQL + Redis + Docker Compose |
| 1.2 | 数据库建表 | 所有核心表迁移完成 |
| 1.3 | WebSocket 聊天室 | 实时消息收发, 消息持久化 |
| 1.4 | React 前端 V1 | 登录、房间列表、聊天界面 |
| 1.5 | 部署 | 服务器上线, HTTPS, 基本可用 |

### Phase 2 — Agent 系统 (1 周)

| 步骤 | 内容 | 交付物 |
|---|---|---|
| 2.1 | Agent 注册/身份 | Agent 用户创建, 在线状态 |
| 2.2 | Agent 面板 | 前端显示在线 Agent 列表 |
| 2.3 | @Agent 机制 | 聊天室 @ 触发 Agent 响应 |
| 2.4 | 审批流程 | Proposal → 审批 → 执行 |

### Phase 3 — A2A 集成 (1 周) ← 核心

| 步骤 | 内容 | 交付物 |
|---|---|---|
| 3.1 | A2A Hub (服务器端) | Agent Card, JSON-RPC 端点 |
| 3.2 | 本地 A2A 适配器 | 你电脑上跑, 连接服务器 |
| 3.3 | 朋友适配器 | 朋友电脑上跑 |
| 3.4 | 跨 Agent 协作 | A2A 任务委派, 结果回聊天室 |
| 3.5 | Agent 发现 | 自动发现 + 健康检查 |

### Phase 4 — 知识库 + Git (1 周)

| 步骤 | 内容 |
|---|---|
| 4.1 | 文档管理 (Markdown 上传/编辑) |
| 4.2 | 向量检索 (pgvector) |
| 4.3 | Git 事件同步 |
| 4.4 | Agent 上下文检索 |

### Phase 5 — 增强 (持续)

| 步骤 | 内容 |
|---|---|
| 5.1 | 多房间支持 |
| 5.2 | MCP 集成 (Phase 2 of 原计划) |
| 5.3 | 分布式 Agent 网络 |
| 5.4 | 可视化 Agent 流程图 |

---

## 附录

### A. 环境变量参考

```
# .env

# 数据库
DATABASE_URL=postgresql+asyncpg://postgres:password@localhost:5432/agent_room

# Redis
REDIS_URL=redis://localhost:6379/0

# JWT
SECRET_KEY=your-secret-key-change-in-production

# A2A
A2A_PUBLIC_URL=https://hub.你的域名
A2A_PORT=8765

# CORS
CORS_ORIGINS=http://localhost:5173,https://hub.你的域名

# Git
GIT_WORK_DIR=/data/repos
```

### B. 快速启动

```bash
# 1. 克隆
git clone https://github.com/wangdada8208/multi-agent-project-room
cd multi-agent-project-room

# 2. 环境变量
cp .env.example .env
# 编辑 .env 填入配置

# 3. 启动
docker compose up -d

# 4. 数据库迁移
docker compose exec backend alembic upgrade head

# 5. 打开浏览器
open https://hub.你的域名
```

### C. 参考资源

- [A2A 协议官方规范 (v0.3)](https://agent2agent.info/specification/core/)
- [A2A Python SDK](https://a2aproject.github.io/a2a-python/)
- [FastA2A 框架](https://github.com/rebeccacamejo/fasta2a)
- [LangGraph A2A Adapter](https://github.com/n-sviridenko/langgraph-a2a-adapter)
- [Multi-Agent A2A 示例](https://github.com/maeste/multi-agent-a2a)
- [Google ADK 文档](https://google.github.io/adk-docs/a2a/)
- [FastAPI WebSocket 文档](https://fastapi.tiangolo.com/advanced/websocket/)
- [pgvector 文档](https://github.com/pgvector/pgvector)
