# Decisions

## 2026-06-17 Lightweight Auth And Task Traceability

Decision:

- Use a lightweight username/password account system for the MVP.
- Store password hashes with PBKDF2 from the Python standard library.
- Issue signed bearer tokens using the configured `MAPR_AUTH_SECRET_KEY`.
- Keep Agent registration and A2A discovery open for local adapter ergonomics.
- Require auth for room, message history, approval, and task REST APIs.
- Track A2A tasks with optional `room_id`, `source_message_id`, and `approval_id`.

Rationale:

- This gives real user identity for approvals and room creation without adding
  OAuth/SSO complexity.
- Task traceability makes the core collaboration loop inspectable from chat,
  approvals, and task panels.

Follow-up:

- Replace the default dev secret before production use.
- Introduce agent-specific tokens before exposing agent write APIs broadly.

## 2026-09-19 采纳代理间可信协作指导规范 (v0.2)

### 决策背景

系统已经具备基础的用户登录、WebSocket 房间广播与 A2A 对话协议。
在多名人类用户携带各自智能体进行协作的场景下，连接成功并不代表建立了可信协作。
现有的 Bearer 令牌仅能验证用户身份，无法证明其对特定智能体实例的所有权。
也无法证明其具备特定会话的调用授权。
此外，单纯依赖自然语言文本中的共识标记，无法作为可靠的业务承诺。
系统亟需一套明确的授权边界、数据防护与执行控制模型。

### 决策内容

1. 正式采纳 `docs/项目指导意见-代理间可信协作.md` 作为后续多智能体协作演进的核心设计指导。
2. 明确将远端仓库的 `origin/main`（提交哈希 `f1af097`）确立为阶段验收的参考基线。本地未提交的功能模块另行管理。
3. 选定虚构日历协商作为可信协作的首选最小验证场景。在通过专门评审前，系统禁止调用真实日历软件。
4. 确立严格的数据安全边界。外部智能体发来的消息一律视作不可信输入。传出数据必须经过白名单收敛，仅交换获批的空闲时间段。
5. 建立任务取消与底层执行进程的强联动机制。取消后的迟到模型响应必须予以丢弃，不得存盘与广播。
6. 分阶段稳步推进改造。按照 Phase 0 统一基线、Phase 1 模拟通道验证、Phase 2 有限模型协作的顺序实施。

### 决策依据

该决策从根本上防范了跨智能体交互中的越权调用与隐私泄露风险。
避免将未经审查的提示词误当做主人的授权指令。
通过引入虚构排期场景，团队可以在零真实副作用的前提下验证双机协作链路。
