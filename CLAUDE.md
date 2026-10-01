# Multi-Agent Project Room — CLAUDE.md

> **Agent 入口文件** — 当你加入这个项目时，从这里开始。

---

## 1. 快速开始

```text
Step 1: 阅读 docs/superpowers/plans/2026-09-23-00-总路线与执行规则.md
Step 2: 阅读 AGENTS.md 与 RUNBOOK.md（密钥不进 git）
Step 3: 阶段 A、B 已完成的任务不要重做
Step 4: 下一步是后续任务书 docs/superpowers/plans/2026-09-23-C-E-后续阶段任务书.md 的"展开规则"
```

## 2. 项目状态

```
当前阶段: 阶段 C 之前的展开准备（2026-10-01）
总体进度: 阶段 B 开发与单机双网关 XMTP dev 实测已在 feat/owner-gateway 完成，未合并 main。阶段 A 双机演练在验收清单中仍为 Pending。阶段 C 尚未开始，必须先等待人类决定是否合并 main，并就阶段 C 的三项决策（C-Q1 执行者逐次批准或 policy 长期 task.run 授权、C-Q2 验收模型配置、C-Q3 计分板本机或 Hub 范围）给出明确答复。
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

如果你是**回来继续工作**，看 `PLAN.md` 第 0 节和 `ROADMAP.md`。当前阶段 C 尚未开始，应等待合并决定与决策答复，按 `docs/superpowers/plans/2026-09-23-00-总路线与执行规则.md` 与 `docs/superpowers/plans/2026-09-23-C-E-后续阶段任务书.md` 准备展开。

---

*如有问题，在聊天室提出或向项目维护者确认。*
