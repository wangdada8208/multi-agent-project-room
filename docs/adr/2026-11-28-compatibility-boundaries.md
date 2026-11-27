# Hub 与成员端兼容入口

本表记录第二轮治理保留的入口及其消费者。新加密房间由 XMTP 成员收发正文，Hub 管理身份、席位和必要元数据。

| 入口 | 现有消费者和边界 | 回归入口 |
| --- | --- | --- |
| Hub `/ws/chat/{room_id}`、消息历史和游标 | 浏览器 Hub 模式、Python 本地适配器和 Runner。房间角色限制订阅和写入。XMTP 房间拒绝通过该路径写入正文。Nginx 保留 WebSocket 转发。 | `test_chat.py`、`test_pg_room_hubs_linux.py`、`test_local_agent_adapter.py` |
| `/a2a/dialogue-rpc` | `local_agent_adapter.py` 和 `trusted_runner.py` 的登录后对话。对话 JSON-RPC 与 SDK 任务使用各自的消息形状。 | `test_a2a_dialogues.py`、`test_trusted_collaboration.py` |
| `/a2a/rpc`、A2A HTTP 和 SSE、`/.well-known/agent-card.json` | 外部 A2A SDK 客户端从 Agent Card 发现任务端点。任务状态、授权、多 Hub 投递和取消保留现有语义。 | `test_a2a_protocol_v1_linux.py`、`test_a2a_acceptance_linux.py` |
| Python CLI | 安装助手列出 `local_agent_adapter.py`、`agent_gateway.py` 的命令。运行手册依赖适配器，`run_live_verification.py` 复用 `trusted_runner.py` 的 TLS 与 Runner 能力。 | `test_compatibility_entrypoints.py`、`test_local_agent_process_lifecycle.py`、`test_tls_verification.py` |
| Node Helper 与成员端 | 浏览器访问回环 Helper，Hub 管配对、席位与心跳。发布包提供 `mapr up`、`mapr join`、成员进程和 Bot Bridge。云席位根据 Hub 状态停止服务。 | `test_helper_pairing_linux.py`、`test_helper_seats_linux.py`、`helper/*.test.ts`、`cli.test.ts`、`bot-bridge.test.ts` |

`Audit Round 4 CI` 在 PR 上运行。主分支 push 和手动触发由独立工作流负责部署或发布下载包。

清理限于无调用方的内部全局任务列表、旧适配器私有 stderr 函数及一次性开发隧道脚本。A2A SDK 的 `ListTasks`、房间任务列表和正在使用的进程控制都保留。开发隧道脚本从未进入安装、发布包或部署工作流。
