# Multi-Agent Project Room — CLAUDE.md

> **Agent 入口文件** — 当你加入这个项目时，从这里开始。

---

## 1. 快速开始

```text
Step 1: 阅读 PLAN.md       → 了解当前阶段和你的任务
Step 2: 阅读 CONTEXT.md    → 理解项目理念
Step 3: 阅读 AGENTS.md     → 遵守 Agent 协作规则
Step 4: 查看 PLAN.md §14   → 找到当前未完成的 Phase
Step 5: 开始执行            → 完成后更新 PLAN.md 的 [ ] 为 [x]
```

## 2. 项目状态

```
当前阶段: Phase 1 (项目骨架搭建)
总体进度: 0/9 个 Phase 完成
```

## 3. 技术栈概要

| 技术 | 用途 |
|---|---|
| FastAPI + Python 3.12+ | 后端 API + WebSocket |
| React + Vite + TypeScript | 前端 |
| PostgreSQL 16 | 数据库 |
| Redis | 缓存 / Pub/Sub |
| Docker Compose | 部署 |
| A2A (JSON-RPC) | Agent 间通信 |

## 4. Agent 行为守则

```
1. 仓库是真相源 — 以 PLAN.md 和项目文件为准
2. 先讨论再执行 — 架构变更先出 Proposal
3. 人类审批优先 — 数据库/架构/主分支合并/部署需要人类点头
4. 保持沟通 — 不要默默改东西，在聊天室说明
5. 更新文档 — 完成任务后更新 PLAN.md 状态
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

如果你是**第一次加入**，先读 `PLAN.md` 全文，然后从 Phase 1 的第一个任务开始。

如果你是**回来继续工作**，看 `PLAN.md §14 当前进度`，找到未完成的 Phase，继续推进。

---

*如有问题，在聊天室提出或向项目维护者确认。*
