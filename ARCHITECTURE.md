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

### **Chat Module**

Responsibilities:

- Room management
- Message persistence
- WebSocket broadcast

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

------

## **Data Flow**

Human Message

↓

Chat Room

↓

Agents Read Context

↓

Agents Discuss

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