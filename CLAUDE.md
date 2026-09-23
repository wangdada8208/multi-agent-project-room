# Multi-Agent Project Room — CLAUDE.md

> **Agent 入口文件** — 当你加入这个项目时，从这里开始。

---

## 1. 快速开始

```text
Step 1: 阅读 docs/superpowers/plans/2026-09-23-member-finish.md
Step 2: 阅读 AGENTS.md（不合并 main，不动生产库，密钥不进 git）
Step 3: 不要重做主人记录、真实回复、本地轮次、XMTP 收发和历史明文房间删除
Step 4: 从收尾计划的 Task 1 做到 Task 4。做完后不要再写下一份编码计划
```

## 2. 项目状态

```
当前阶段: 收尾，让主人在页面上看见本机轮次结果
总体进度: 主人记录已写入本机文件。当前执行 docs/superpowers/plans/2026-09-23-member-finish.md。做完后不再写成员进程编码计划。不合并 main。生产库未清理。
```

## 3. 技术栈概要

| 技术 | 用途 |
|---|---|
| FastAPI + Python 3.12+ | 后端 API + WebSocket |
| React + Vite + TypeScript | 前端 |
| PostgreSQL 16 | 数据库 |
| Redis | 缓存 / Pub/Sub |
| Docker Compose | 部署 |
| A2A (JSON-RPC) | 任务发现与任务回传，不是加密聊天的底层 |
| XMTP（`@xmtp/agent-sdk`，Node 22） | 计划中的端到端加密群聊。官方 SDK 不进 FastAPI 进程 |

## 4. Agent 行为守则

```
1. 仓库是真相源 — 以 PLAN.md 和项目文件为准
2. 先讨论再执行 — 架构变更先出 Proposal
3. 人类审批优先 — 数据库/架构/主分支合并/部署需要人类点头
4. 保持沟通 — 不要默默改东西，在聊天室说明
5. 更新文档 — 完成任务后更新 PLAN.md 状态
6. 提交写清楚 — 每次 git commit 写明新增/修改/删除/对方需知
```

## 5. 目录结构

```
AGENTS.md         Agent 行为规则
CONTEXT.md        项目理念
PLAN.md           项目规划书（当前最重要的文档）
PROJECT.md        原始项目愿景
ARCHITECTURE.md   架构设计

backend/          FastAPI 后端
frontend/         React 前端
```

## 6. 从哪里开始

如果你是**第一次加入**，先读 `PLAN.md` 全文，然后看
`ACCEPTANCE_CHECKLIST.md` 和 `RUNBOOK.md` 了解当前上线状态。

如果你是**回来继续工作**，看 `PLAN.md` 第 0 节和 `ROADMAP.md`，
执行 `docs/superpowers/plans/2026-09-23-member-finish.md`。做完 Task 4 后不要再写下一份编码计划。不要合并 main，不要清理生产库。

---

*如有问题，在聊天室提出或向项目维护者确认。*
