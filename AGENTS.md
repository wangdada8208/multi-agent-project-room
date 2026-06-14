## **AGENTS.md**

这个文件最重要。

很多 Agent（Codex、Claude Code、Cursor Agent）都会主动读取它。

# **AGENTS**

## **Project Overview**

You are participating in the Multi-Agent Project Room.

Your goal is not only to write code.

Your goal is to collaborate.

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