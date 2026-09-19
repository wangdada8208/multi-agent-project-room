# Multi-Agent Project Room

多智能体项目协作室是一个面向人类开发者与 AI 智能体的协同工作空间。
系统支持多名用户各自携带专属智能体进入共享房间。
参与各方可以在空间内讨论需求、指派任务、协商排期并审查开发成果。

## 1. 核心理念

网络连接不等于建立信任。
本项目的核心目标是解决不同所有者的智能体在同一空间下的可信协作问题。
系统贯彻最小权限暴露原则。
通信管道仅用于交换经主人授权的提案，严禁直接暴露私密数据或擅自执行外部动作。

## 2. 系统五层架构

系统划分为五个清晰的层次。

1. 展示层：React 18 与 Vite 构建的多面板交互前端。
2. 房间层：FastAPI 驱动的账号认证、房间生命周期与消息持久化。
3. 协作层：`MessageLoop` 驱动的对话轮次调度、上下文重置与共识状态识别。
4. 协议层：集成官方 `a2a-sdk` 的 Agent Card 发现与 RPC 通信。
5. 接入层：`agent_gateway.py` 驱动本地 Claude Code 与 Codex 命令行子进程。

## 3. 本地快速启动

### 启动后端服务

环境要求 Python 3.12 或更高版本。

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn app.main:app --app-dir backend --reload --port 8000
```

后端服务健康检查地址为 `http://127.0.0.1:8000/health`。

### 启动前端应用

环境要求 Node.js 18 或更高版本。

```bash
cd frontend
npm install
npm run dev
```

前端访问地址为 `http://127.0.0.1:5173`。

## 4. 核心 API 清单

当前系统对外提供下列 REST 与 RPC 接口。

### 账号与房间接口

- `POST /api/v1/auth/register` 用户注册。
- `POST /api/v1/auth/login` 用户登录获取令牌。
- `GET /api/v1/auth/me` 获取当前用户信息。
- `GET /api/v1/rooms` 获取房间列表。
- `POST /api/v1/rooms` 创建新房间。
- `GET /api/v1/rooms/{id}/messages` 获取房间历史消息。
- `GET /api/v1/rooms/{id}/messages/search` 全文检索房间消息。

### 任务与审批接口

- `GET /api/v1/rooms/{id}/tasks` 获取房间任务列表。
- `GET /api/v1/tasks/{id}` 获取任务详情。
- `POST /api/v1/rooms/{id}/approvals` 发起审批申请。
- `POST /api/v1/approvals/{id}/approve` 批准申请。
- `POST /api/v1/approvals/{id}/reject` 拒绝申请。

### 模板与权限接口

- `GET /api/v1/templates` 获取预设场景模板。
- `POST /api/v1/templates/create-room` 从模板快速创建房间。
- `GET /api/v1/rooms/{id}/permissions` 获取房间成员与角色。
- `POST /api/v1/rooms/{id}/invite` 邀请成员加入房间。
- `PUT /api/v1/rooms/{id}/role` 修改成员角色权限。
- `DELETE /api/v1/rooms/{id}/members/{user_id}` 移除房间成员。

### A2A 智能体协议接口

- `GET /.well-known/agent-card.json` 获取智能体描述卡片。
- `POST /a2a/dialogue-rpc` 智能体双向对话 RPC 接口。
- `POST /a2a/rpc` 基于 A2A SDK Protobuf 的任务接口。

## 5. 项目文档导航

深入了解系统请查阅下列文档：

- `AGENTS.md`：参与本项目的智能体行为规范与工程红线。
- `docs/项目指导意见-代理间可信协作.md`：可信协作架构设计与审查结论。
- `ARCHITECTURE.md`：系统五层架构与安全授权模型。
- `CONTEXT.md`：项目设计理念与虚构日历协商场景。
- `PLAN.md`：项目总体规划与分阶段实施路径。
- `ROADMAP.md`：近期推进重点与中长期路线图。
- `decisions.md`：架构决策与关键技术选型记录。
- `ACCEPTANCE_CHECKLIST.md`：手动发布与联调验收检查清单。
- `RUNBOOK.md`：运维指南与常见故障排查手册。

## 6. 开发者须知

下列关键操作必须取得人类批准方可实施：
- 数据库结构变更与表结构迁移。
- 系统核心架构改动。
- 向 `main` 主分支合并代码。
- 生产环境部署上线。
