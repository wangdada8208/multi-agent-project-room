# Multi-Agent Project Room — CLAUDE.md

> **Agent 入口文件** — 当你加入这个项目时，从这里开始。

---

## 1. 快速开始

```text
Step 1: 阅读 docs/superpowers/plans/2026-09-23-00-总路线与执行规则.md
Step 2: 阅读 AGENTS.md 与 RUNBOOK.md（密钥不进 git）
Step 3: 阶段 A 至阶段 F 已全部完成并合并入 main
Step 4: 生产环境已成功迁移至北京服务器，服务在线（https://hub.wangdada8208.xyz/health 为 200）
```

## 2. 项目状态

```
当前阶段: 研发阶段 A–F 与第四轮审计修复全部交付并合并 main，剩余收尾事项于 2026-11-12 关闭（2026-11-12）
总体进度: 阶段 A 至阶段 F（主人网关、协调者、连接器、代理自助接入与 Connect with MAPR）已全部完成并合入 main。生产库已迁移至 i90c20261017，北京生产 /health 为 200，自建 runner（multi-agent-runner-bj）在线。第四轮审计的 H1–H4 高危项与 CI 32 项失败根因已关闭（真实 CI：791 passed / 0 failed）。2026-11-12 主人一次性批准并收尾：接入层证书校验改严、main 合并门禁加固、生产库旧明文房间清理、alembic check 漂移治理、文档与验收状态同步。逐项证据见 docs/verification/2026-11-12-*.md。
```

> 注意：`docs/superpowers/plans/2026-09-23-00-总路线与执行规则.md` 第 8 节的旧进度表在 A–F 交付时未同步勾选；
> 以 `main` 的实际提交、`ACCEPTANCE_CHECKLIST.md` 和 `docs/verification/` 为准，不要以旧勾选框判断进度。

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

如果你是**回来继续工作**，看 `PLAN.md` 第 0 节、`ROADMAP.md` 第 0 节和
`docs/verification/2026-11-12-*.md`。阶段 A–F 与第四轮审计修复均已交付，
2026-11-12 的剩余收尾事项（证书校验、合并门禁、生产库旧明文房间清理、alembic 漂移、文档同步）已关闭；
新的工作从 `ACCEPTANCE_CHECKLIST.md` 的未勾选项与 `decisions.md` 的最新决策开始，
不要再按「阶段 C 尚未开始」展开——那是 2026-10-01 之前的陈旧描述。

---

*如有问题，在聊天室提出或向项目维护者确认。*
