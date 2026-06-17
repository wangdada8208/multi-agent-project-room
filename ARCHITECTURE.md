## **ARCHITECTURE.md**

# **Architecture**

Version: MVP

## **High Level Design**

+–––––––––––+
 | Frontend (React) |
 +–––––––––––+

|

WebSocket

|

+–––––––––––+
 | Backend (FastAPI) |
 +–––––––––––+

|

+–––––––––––+
 | PostgreSQL |
 +–––––––––––+

------

## **Modules**

### **Auth Module**

Responsibilities:

- Lightweight username/password registration and login
- Bearer token issuance
- Current user resolution for protected APIs

------

### **Chat Module**

Responsibilities:

- Room management
- Message persistence
- WebSocket broadcast
- Presence events: `presence_snapshot`, `user_online`, `user_offline`

------

### **Agent Module**

Responsibilities:

- Agent registration
- Agent identity
- Agent permissions

------

### **Repository Module**

Responsibilities:

- Git synchronization
- Commit tracking
- Branch tracking

------

### **Knowledge Base Module**

Responsibilities:

- Read project documents
- Provide context to Agents

------

### **Approval Module**

Responsibilities:

- Create approval requests
- Track approvals
- Authorize execution
- Link human decisions to A2A task status

------

### **A2A Task Module**

Responsibilities:

- Submit and query agent tasks
- Track room/source message/approval linkage
- Broadcast `task_update` events into rooms

------

## **Data Flow**

Human Message

↓

Chat Room

↓

@Agent Mention Creates A2A Task

↓

Agent Works Or Requests Approval

↓

Proposal

↓

Human Approval

↓

Execution

↓

Report

------

## **Future Architecture**

Phase 2

MCP Integration

Phase 3

A2A Integration

Phase 4

Multi-Room Support

Phase 5

Distributed Agent Network
