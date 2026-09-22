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

## 2026-09-22 新房间改为成员端端到端加密

### 决策背景

现有房间把聊天正文写入 `messages.content`。TLS 只保护到 Hub，Hub 和数据库都能阅读原文。
若以后作为公开产品，平台不应能够阅读房间正文。

XMTP 的加密群聊仍然经过投递服务器。服务器保存密文。官方说明网络节点和接入方应用都无法解密。能解密的是当前群成员，包括加入群的代理进程。

### 决策内容

1. 新房间采用 XMTP group 作为正文通道。官方 Node SDK `@xmtp/agent-sdk` 运行在独立成员进程，不嵌入 FastAPI。
2. Hub 继续负责账号、成员关系、审批状态和 group id 绑定。Hub 不保存加密房间的聊天正文，也不保管钱包私钥。
3. 2026-09-23 起，用户可见的历史明文房间删除，不再保留可读入口。`_agent_` 内部通道保留。生产库未清理。
4. `@` 叫醒和轮次调度改到能够解密的成员进程。A2A 仍只负责任务发现和任务回传。
5. 已完成的落库防护见 `docs/superpowers/plans/2026-09-22-xmtp-e2e.md`。下一位要做的收发闭环见 `docs/superpowers/plans/2026-09-23-xmtp-member-send.md`。
6. 本决策批准在功能分支上实现该计划。本决策不批准合并 `main`，也不批准在生产库执行迁移。

### 决策依据

成员端加密能让平台读不到新房间正文。
把调度留在 Hub 则要求 Hub 继续阅读明文，这两件事不能同时成立。
因此正文通道换成 XMTP，控制规则改由群内协调者执行。旧的授权、取消和最小披露规则仍然有效。

## 2026-09-23 删除用户可见的历史明文房间

### 决策背景

产品不再向用户提供历史明文房间。

### 决策内容

1. 2026-09-23 起，用户可见的历史明文房间删除，不再保留可读入口。
2. 创建房间接口只接受 `transport="xmtp"`。
3. 前端界面移除「历史明文房间」标记与 hub 发送逻辑。
4. 本地数据库中用户可见的 `transport=hub` 房间及其关联子表行全部删除。
5. `_agent_` 内部通道保留。
6. A2A 任务上的 `source_agent="hub"` 为系统名称，保持不变。
7. 生产库未清理。合并 `main` 与生产库迁移仍须单独审批。
