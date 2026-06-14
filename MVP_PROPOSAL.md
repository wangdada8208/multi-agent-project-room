# **MVP Proposal**

Version: Draft

Last Updated: 2026-06-14

# **Problem**

This project is not a general chat application.

It is a collaborative software development room for:

- Humans
- AI Agents
- Shared project documents
- Shared Git repository state
- Discussions
- Proposals
- Tasks
- Approvals
- Reports

The core question is:

Can humans and AI agents collaborate naturally inside the same project room as a real software team?

------

# **Core Need**

Build a Multi-Agent Project Room where multiple humans and multiple AI agents can work together around the same project context.

The room must allow participants to:

- Discuss requirements
- Propose solutions
- Split tasks
- Read project knowledge
- Observe repository state
- Request human approval
- Execute implementation work
- Report results

The repository and project documents are the durable source of truth.

Chat history is useful context, but it must not replace repository state, documentation, or recorded decisions.

------

# **MVP Goal**

The MVP should validate the collaboration model first.

It should prove that:

- Humans can create a project room.
- Humans can invite or activate agents.
- Humans and agents can chat in the same room.
- Agents can read shared project documents.
- Agents can read Git repository state.
- Agents can propose implementation plans.
- Humans can approve or reject important actions.
- Agents can execute tasks and report results.

Speed and simplicity are more important than perfect architecture.

------

# **Recommended Architecture**

Use the architecture already defined in `ARCHITECTURE.md`.

Frontend:

- React

Backend:

- FastAPI

Realtime:

- WebSocket

Database:

- PostgreSQL

Repository Integration:

- Local Git commands in MVP

Knowledge Base:

- Markdown project documents

------

# **MVP Modules**

## **1. Room And Chat Module**

Responsibilities:

- Create project rooms
- Manage room participants
- Send messages
- Broadcast messages over WebSocket
- Persist message history
- Display human, agent, and system messages

Message types:

- Human message
- Agent message
- System message
- Proposal
- Task
- Report
- Approval request

------

## **2. Agent Identity Module**

Responsibilities:

- Register agents
- Store agent identity
- Store agent capabilities
- Track agent status
- Control basic permissions

Suggested fields:

- `agent_id`
- `name`
- `type`
- `description`
- `permissions`
- `status`
- `created_at`

Suggested MVP permissions:

- `read_repo`
- `read_docs`
- `read_chat`
- `send_message`
- `create_proposal`
- `create_task`
- `request_approval`
- `execute_task_requires_approval`

------

## **3. Knowledge Base Module**

Responsibilities:

- Read project documents
- Track document update time
- Provide shared context to agents
- Support simple search

Initial documents:

- `AGENTS.md`
- `PROJECT.md`
- `ARCHITECTURE.md`
- `CONTEXT.md`
- `MVP_PROPOSAL.md`

Future documents:

- `DECISIONS.md`
- `TASKS.md`

MVP implementation:

- File scanning
- Markdown reading
- Metadata storage
- Simple keyword search
- Context assembly for agents

No vector database is required for the first version.

------

## **4. Repository Module**

Responsibilities:

- Read Git repository state
- Track current branch
- Track latest commit
- Track changed files
- Show recent commit history
- Provide repository context to agents

MVP implementation can use local Git commands:

- `git status`
- `git branch`
- `git log`
- `git diff`

This module should be read-focused at first.

Write operations should go through approval when they affect shared project state.

------

## **5. Approval Module**

Responsibilities:

- Create approval requests
- Track approval status
- Record human decisions
- Authorize sensitive execution

Human approval is required for:

- Database schema changes
- Architecture changes
- Main branch merges
- Production deployment
- Other high-risk operations

Suggested statuses:

- `pending`
- `approved`
- `rejected`
- `cancelled`

Suggested fields:

- `approval_id`
- `title`
- `description`
- `requested_by`
- `status`
- `risk_level`
- `created_at`
- `approved_by`
- `approved_at`

------

## **6. Structured Collaboration Messages**

The room should support structured messages based on `AGENTS.md`.

Proposal:

```text
[PROPOSAL]
Problem:
Solution:
Impact:
Approval Required:
```

Task:

```text
[TASK]
Description:
Files:
Dependencies:
```

Report:

```text
[REPORT]
Completed:
Files Changed:
Tests:
Next Step:
```

These message types make the room more than a chat stream.

They turn it into a shared collaboration log.

------

## **7. Agent Adapter Module**

The first version does not need full autonomous multi-agent orchestration.

Instead, create a simple Agent Adapter interface.

Each agent should be able to:

- Read room context
- Read project documents
- Read repository state
- Send a room message
- Create a proposal
- Create a task
- Request approval
- Report execution results

Suggested API shape:

```text
POST /agents/{agent_id}/respond
POST /agents/{agent_id}/propose
POST /agents/{agent_id}/execute
```

Future phases can connect this interface to:

- MCP
- A2A
- External agent runtimes
- More autonomous coordination

------

# **Suggested Database Tables**

Initial tables:

- `rooms`
- `participants`
- `agents`
- `messages`
- `knowledge_documents`
- `repository_snapshots`
- `approval_requests`
- `tasks`

These should remain simple in the MVP.

Database schema changes require human approval before implementation.

------

# **Suggested Screens**

## **Project Room Page**

Main screen for chat and collaboration.

Includes:

- Message timeline
- Message composer
- Structured proposal/task/report cards
- Agent action buttons

## **Agent Sidebar**

Shows:

- Active agents
- Agent status
- Agent permissions
- Agent actions

## **Knowledge Base Sidebar**

Shows:

- Project documents
- Last updated time
- Search results

## **Repository Panel**

Shows:

- Current branch
- Latest commit
- Changed files
- Recent commits

## **Approval Panel**

Shows:

- Pending approvals
- Approved requests
- Rejected requests
- Approval details

------

# **Development Plan**

## **Phase 1: Project Foundation**

- Create FastAPI backend
- Create React frontend
- Configure PostgreSQL
- Define environment configuration
- Add basic development scripts

## **Phase 2: Realtime Room**

- Create rooms
- Add participants
- Persist messages
- Implement WebSocket broadcast
- Build room UI

## **Phase 3: Agent Identity**

- Add agent registration
- Add agent list UI
- Add agent messages
- Add simple permissions

## **Phase 4: Knowledge Base**

- Read Markdown project documents
- Store document metadata
- Show knowledge base in UI
- Provide document context to agents

## **Phase 5: Repository State**

- Read Git status
- Read branch and latest commit
- Show changed files
- Show recent commits

## **Phase 6: Approval Workflow**

- Create approval requests
- Review approval requests
- Approve or reject requests
- Gate sensitive execution

## **Phase 7: Agent Adapter**

- Define agent adapter interface
- Add respond/propose/execute endpoints
- Connect first usable agent
- Add report generation

------

# **Implementation Principles**

- Optimize for collaboration, not output volume.
- Keep the MVP small.
- Prefer simple working software over complex infrastructure.
- Make repository state and documentation visible to agents.
- Require approval before major changes.
- Keep communication structured.
- Update documentation when architecture changes.

------

# **Open Questions**

These decisions should be confirmed before major implementation:

- Should the first implementation support one room or multiple rooms?
- Should agents execute code locally or only generate plans in the first MVP?
- Should Git write operations be disabled until approval workflow is complete?
- Which AI provider or runtime should be connected first?
- Should authentication be included in MVP or deferred?

------

# **Approval Required**

This proposal affects the architecture and implementation sequence.

Human approval is required before building the MVP from this plan.
