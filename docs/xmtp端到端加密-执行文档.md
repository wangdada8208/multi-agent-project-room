# XMTP 端到端加密迁移执行文档

状态：2026-09-23。加密房间的收发和本地历史明文房间删除已经完成。dev 网络双成员证据在 `docs/superpowers/evidence/dev-roundtrip.json`。

下一位只执行 `docs/superpowers/plans/2026-09-23-member-local-loop.md`，从 Task 1 开始。
不要从删除明文房间或双成员收发计划的 Task 1 重做。

本文件发布时的那句「运行代码仍把所有正文写入 messages.content」已经过时。`transport=xmtp` 的房间会拒绝落库。2026-09-23 起，用户可见的历史明文房间删除，不再保留可读入口。`_agent_` 内部通道保留。生产库未清理。

## 1. 要做成什么样

新的加密房间里，聊天正文在发送方设备上加密，经投递网络安全送达，只在群成员自己的设备上解密。

投递路径上的服务器会收到并保存数据。它们保存的是密文。XMTP 官方安全说明写明：网络节点读不到正文，接入方自己的应用服务器也读不到。能解密的是当前群里的每一个成员，包括被加进群的代理进程。

这不是「消息不经过服务器」。

## 2. 密钥从哪里来

现在没有这批密钥。`messages.content` 是普通文本列，仓库里没有正文加密。

密钥在某个成员第一次加入加密会话时，由该成员自己的程序生成并保存在该程序本地。Hub 不生成、不保管、不备份钱包私钥和本地库加密密钥。

2026-09-23 起，用户可见的历史明文房间删除，不再保留可读入口。`_agent_` 内部通道保留。生产库未清理。

## 3. 什么留下，什么搬走

留下在 FastAPI Hub 上的：

- 账号、登录令牌、房间名单、成员关系。
- 审批记录的状态、作用域和凭据哈希。审批理由里的私密正文不进 Hub。
- 任务编号、房间和 XMTP group id 的对应关系。
- A2A Agent Card。它仍是任务发现，不是这条加密聊天的底层。

搬走、改由群成员在本地做的：

- 聊天正文的保存、搜索和展示。
- `@` 叫醒和 `MessageLoop` 轮次。这两处现在在 `backend/app/chat/ws_handler.py` 与 `backend/app/collab/message_loop.py`，因为 Hub 看得到明文。加密之后 Hub 看不懂，调度必须放在已解密的成员进程里。
- 日历出站白名单。过滤发生在成员把文字送进模型之前。

明确不采用：

- 不把 PyPI 上的非官方 `xmtp` 包装进 FastAPI 进程。2026-09-22 核对时，官方代理 SDK 是 Node 的 `@xmtp/agent-sdk`，文档在 https://docs.xmtp.org/agents/get-started/build-an-agent 。
- 不把产品绑到 agentpicnic.com。Picnic 只说明「协调者是群成员」这种形态。
- 不在本阶段替换 A2A 的任务协议。

## 4. 身份和成员

沿用现有关系，并加上加密身份：

`owner_id → agent_id → 本地 inbox 密钥 → XMTP group 成员`

- 一个房间对应一个 XMTP group。官方文档写明单个 group 最多 250 名成员。
- 人类、协调者、每个代理各有自己的 inbox。
- 协调者是群成员，所以它能读正文。Hub 进程不是群成员，所以它不能读正文。
- 钱包密钥丢失后，旧会话无法再解。执行时要在界面写明这一点。密钥只放本机环境变量或本机密钥文件，并确认 `.gitignore` 盖住它们。

开发用 `XMTP_ENV=dev`。生产网络要等阶段 4 验收后再单独批准。

## 5. 执行顺序

### 阶段 1：Hub 拒绝再存加密房间的正文

2026-09-23 起，用户可见的历史明文房间删除，不再保留可读入口。`_agent_` 内部通道保留。生产库未清理。
新的 `transport=xmtp` 房间只保存 group id 和 inbox id。
`save_message` 若收到这种房间的正文，直接拒绝。
另建一个 Node 22 成员进程，用官方 SDK 在 dev 网络建群、发一条消息。该进程不得把正文 POST 回 Hub。

验收：测试证明明文被拒绝。人工用 dev 网络发出的那句话不出现在数据库和 Hub 日志里。

### 阶段 2：叫醒和轮次改到成员进程

成员进程解密后自己决定回不回。
没被点名且没轮到时，不回复。
`MessageLoop` 的轮次状态放在协调者本地，不把每轮正文写回 `messages.content`。

验收：两条入站消息，一条点名，一条不点名。只有点名或轮到的成员回复。Hub 的 `messages` 表不增加正文行。

### 阶段 3：浏览器改为成员端收发

`frontend/src/hooks/useWebSocket.ts` 的 `sendMessage` 今天会把 `content` 经 WebSocket 发给 Hub。
加密房间必须停止这条路径。浏览器作为 XMTP 成员直接收发。
执行当天打开 https://docs.xmtp.org/ 的 Build chat apps，按当天文档里的浏览器客户端包名和版本来接，不凭记忆写接口。

验收：加密房间发一句话，Hub 的 WebSocket 入站 JSON 里没有这句正文。人类刷新后仍能在自己的页面看到这句话。

### 阶段 4：新建房间走加密，取消历史明文房间

新建房间只支持 `transport=xmtp`。
2026-09-23 起，用户可见的历史明文房间删除，不再保留可读入口。界面不再展示历史明文房间标记。`_agent_` 内部通道保留。生产库未清理。
搜索接口对加密房间返回空列表和原因码 `body_not_on_hub`，不假装搜到了正文。

验收：新建房间走加密。界面上已无历史明文房间。

## 6. 停手条件

遇到下面任一条，停止写代码并交给人类：

- 需要把钱包私钥、数据库加密密钥或访问令牌写进 git。
- 需要在生产库执行迁移，或把分支合并进 `main`。
- 阶段验收测试失败，且失败原因不是断言写错。
- 发现官方 SDK 当天的建群接口和计划里写的 `createGroupWithAddresses` 不一致。先改计划里的调用，再写实现。

## 7. 执行者先读的文件

1. 本文。
2. `docs/superpowers/plans/2026-09-23-xmtp-member-send.md`。
3. `decisions.md` 里 2026-09-22 的决策。
4. `backend/app/chat/models.py`、`backend/app/chat/service.py`、`backend/app/chat/ws_handler.py`。
5. https://docs.xmtp.org/protocol/security
6. https://docs.xmtp.org/agents/build-agents/create-conversations
7. https://docs.xmtp.org/agents/build-agents/groups
