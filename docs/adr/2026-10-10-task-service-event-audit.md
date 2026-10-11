# 统一 TaskService、CAS 并发状态机与审计事件日志

状态：已批准并作为阶段二核心实施。

## 背景与问题

此前任务管理存在以下结构性缺陷：
1. `app/a2a/server.py` 挂载官方 A2A SDK 时使用 `InMemoryTaskStore`，与业务数据库 `a2a_tasks` 割裂，导致内存与 SQL 任务状态分叉，重启后 SDK 任务丢失。
2. 任务状态转移缺乏 CAS（Compare-And-Swap）原子条件更新：先读后写在并发时存在 TOCTOU（Time-of-check to time-of-use）竞争，远程 Agent 迟到的任务成功可能覆盖用户的取消请求。
3. 缺少不可变审计事件流与单调序列号，任务状态变更无法追溯与恢复。
4. 原 `MAX(event_seq) + 1` 在无锁高并发下存在主键/序号碰撞风险。

## 架构决策

### 1. 统一 TaskService 与 CAS 状态机
- 新增 `app/a2a/task_service.py` 作为任务生命周期的唯一业务事务入口。
- 所有状态变更执行原子 SQL 条件更新：
  - `complete_task`: `UPDATE a2a_tasks SET status='completed', result=:res, completed_at=:now WHERE id=:id AND status IN ('submitted', 'working', 'input_required', 'queued')`
  - `cancel_task`: `UPDATE a2a_tasks SET status='canceled', completed_at=:now WHERE id=:id AND status IN ('submitted', 'working', 'input_required', 'queued')`
- 若 `rowcount == 0`：
  - 检查当前实际状态：若任务已处于 `canceled`，迟到的 `complete_task` 坚决拒绝覆盖状态与结果，记入 `late_result_discarded` 审计事件，返回 `canceled_overridden_rejected`。
  - 终态幂等保护：已 `completed` 或 `failed` 的任务无法被重入取消。
  - 支持 `input_required`（审批挂起）恢复至 `working`。

### 2. 不可变 task_events 审计表与父行原子计数器
- 数据表 `task_events`: `id` (UUID PK), `task_id` (FK a2a_tasks.id ON DELETE CASCADE), `event_seq` (INT), `event_type` (VARCHAR), `payload` (JSON), `created_at` (TIMESTAMPTZ)。
- 唯一约束 `uq_task_event_seq UNIQUE (task_id, event_seq)`。
- **并发原子计数**：在 `a2a_tasks` 增加 `event_seq` 字段。每次追加事件时，在事务内对父任务执行 `UPDATE a2a_tasks SET event_seq = a2a_tasks.event_seq + 1 WHERE id = :task_id RETURNING event_seq`，通过行级写锁天然串行化并发写入，杜绝 `MAX+1` 并发重复与死锁。

### 3. 敏感数据递归脱敏
- `sanitize_payload()` 对所有写入 `task_events.payload` 的字段进行多层递归过滤。
- 匹配 `token`, `password`, `secret`, `authorization`, `api_key`, `enrollment_key` 等敏感字段名自动替换为 `[REDACTED]`。
- 正则脱敏字符串中的 `Bearer <token>` 明文。

### 4. SDK TaskStore 持久化适配器
- 实现 `TaskServiceTaskStore(TaskStore)`，桥接官方 `@a2a-sdk` 的 protobuf `Task` 与系统底层 `A2ATask` / `TaskService`。
- 替换 `app/a2a/server.py` 中的 `InMemoryTaskStore()`，在保留官方 SDK 协议与接口的同时，将任务真相源完全统一收敛至同一个 SQL 存储引擎，跨进程实例重启仍可查询与更新。

### 5. 迁移设计与安全性
- 新增 Alembic revision `b20c20261010`，以阶段一 `a10c20261010` 为 `down_revision`。
- 严格增量 DDL：
  - `a2a_tasks` 增加可空 `context_id` 及索引。
  - `a2a_tasks` 增加 `event_seq` (默认 0)。
  - 新建 `task_events` 表及唯一索引。
- 支持 SQLite batch 操作及 PostgreSQL 离线 DDL 生成，不包含任何 DROP TABLE 或无条件 UPDATE。
