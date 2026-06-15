## **AGENTS.md**

这个文件最重要。

很多 Agent（Codex、Claude Code、Cursor Agent）都会主动读取它。

# **AGENTS**

## **Project Overview**

You are participating in the Multi-Agent Project Room.

Your goal is not only to write code.

Your goal is to collaborate.

## **Start Here**

**Before doing anything, read these documents in order:**

1. **`PLAN.md`** — 项目总体规划书。当前做什么、怎么做、验收标准
2. **`CONTEXT.md`** — 项目理念：为什么做这个、核心原则
3. **`AGENTS.md`**（本文档）— Agent 行为规则

## **Current Phase Tracking**

The project has 9 phases, tracked in `PLAN.md` section 14.

Check `PLAN.md` for the latest status before starting work.

When you complete a task, update `PLAN.md` by changing `[ ]` to `[x]`.

## **Communication Protocol**

- Use **WebSocket** chat room for human-visible discussion
- Use **A2A (JSON-RPC)** for direct agent-to-agent coordination
- When a message in chat room starts a task, the Hub routes it via A2A to appropriate agents

## **Git Commit Convention**

Every commit **must** include clear handoff information for the other agent:

```text
[Module] Short description (past tense)

- Added:   new files / endpoints / features
- Changed: what was modified and why
- Removed: deleted files or deprecated APIs
- Handoff: what the other agent needs to know
  - API changes: new/removed endpoints, format changes
  - New dependencies: pip install / npm install
  - Required actions: alembic upgrade, db migration
  - Frontend/backend: what needs to be updated on the other side
```

**Rule: Write every commit message assuming the other agent knows nothing about what you just did.**

------

# **Core Rules**

Rule 1

Repository is the source of truth.

Never assume chat history is fully accurate.

Always verify against project files.

------

Rule 2

Discuss before major implementation.

If a design decision affects the architecture:

Create a proposal first.

------

Rule 3

Human approval is required for:

- Database schema changes
- Architecture changes
- Main branch merges
- Production deployment

------

Rule 4

Keep messages concise.

Prefer structured communication.

------

Rule 5

Update documentation.

Whenever architecture changes:

Update:

- architecture.md
- decisions.md

------

# **Agent Behavior**

When receiving a task:

1. Understand the requirement
2. Read repository state
3. Read project knowledge base
4. Check recent discussions
5. Generate a plan
6. Request approval if necessary
7. Execute

------

# **Communication Format**

## **Proposal**

[PROPOSAL]

Problem:

Solution:

Impact:

Approval Required:

------

## **Task**

[TASK]

Description:

Files:

Dependencies:

------

## **Report**

[REPORT]

Completed:

Files Changed:

Tests:

Next Step:

------

# **Collaboration Principles**

Avoid duplicate work.

Avoid editing files owned by another active Agent.

Communicate before large changes.

Prefer pull requests.

Keep context synchronized.