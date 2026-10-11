# 阶段三可靠性收尾与阶段四正式验收

历史状态提示：进程级 SSE 配额已由本地全局租约接入替代，见 [2026-10-11 SSE 全局配额](2026-10-11-sse-global-quota.md)；以下保留当轮验收记录。
状态：主人 2026-10-11 明确授权直接实施本次后台扫描、协议修复及验收；不批准生产操作。

实施提案：复用已有 Task/Delivery/Event 表，在 FastAPI lifespan 启动唯一进程内
扫描任务；每周期最多 50 条，每条独立事务，按父任务→投递锁顺序重读并 CAS。
已 ACK 且租约过期的投递改为 uncertain，任务暂停为 input_required 等待人工核实，
追加同事务事件；续租、完成、取消或其他副本先获锁时，不覆盖新状态。
扫描不依赖账号/房间仍有权限，不重新派发，不自动重跑副作用；运行与关闭都有界。
不新增结构或执行迁移。仅存在 Redis 服务配置，没有可复用 Pub/Sub 代码，
本次不引入新的跨副本总线；内存广播保持单进程，持久事件支持 HTTP/SSE 补偿。

阶段四提案：内部自动对话改走 A2AClient 的标准 SendMessage 和既有固定 IP 出站。
对照 SDK 1.2.2 与官方 A2A v1 规范修复默认阻塞/显式非阻塞、流首帧 Task、
标准错误码及 interrupted/terminal 关闭规则。Last-Event-ID/after_seq 属本项目
持久回放扩展，允许携带 cursor 重播终态；无 cursor 的终态 SubscribeToTask 按
规范拒绝。保留身份/owner/房间与 XMTP 边界，补取消竞态、限流/释放、真实标准
远端和内部对话流程测试。所有测试使用隔离临时库和合成身份，不访问真实私人数据。

参考：本机安装的 a2a-sdk 1.2.2 源码；
[官方 A2A v1 规范](https://a2a-protocol.org/v1.0.1/specification/)，
尤其 SendMessageConfiguration、流首帧、SubscribeToTask 与各绑定错误映射。

## 实际交付

- 后台扫描默认每 10 秒一次、每次 50 条、单轮超时 5 秒；每条独立事务与取消/完成
  使用相同父行锁顺序，只有 CAS 赢家追加 delivery_uncertain。任务变为 input_required，
  不假报失败/成功，也不自动重试外部动作。不存在仍有权限或 resume 的前提。
- lifespan 在 init_db 成功后启动，关闭时取消并等待扫描任务，start/stop 可重复调用。
  超时与异常只记录固定警告并于下轮重试；通知在提交后发送，通知失败不撤销 fencing。
- 内部 _send_to_agent 复用 A2AClient.send_task(return_immediately=False)，统一 PascalCase
  SendMessage 与 protobuf Message；正确提取标准 text parts。不存在、失败或处理中
  远端不再伪造同意。凭据不自动转发。DNS/IP/Host/SNI/TLS/代理/重定向防护保持。
- 自动对话在等待返回后重查停止与角色；使用真实账号、合法消息外键及同一持久消息
  ID 广播。hub 只是控制发起者，不当作远端执行者；未登记的其他 Agent 拒绝执行。
  持久化失败不追加成功轮次、不广播临时正文；对话状态本身仍保存在单进程内存。
- 标准 send 默认等待完成/取消/失败/input_required；显式 returnImmediately=true
  非阻塞。兼容旧 Python send_task 的默认行为，在线上信封中显式设置 true；内部
  自动对话显式 false。阻塞上限 60 秒，超时为标准 InternalError 并保留可查询任务 ID。
- SSE 首帧为无 id 的当前 Task 快照，不吞掉 replay cursor；随后使用 event_seq id，
  Last-Event-ID 优先于 after_seq。终态或中断状态且事件已追平时关闭。没有 cursor
  的终态 SubscribeToTask 按标准拒绝；携带 cursor 的终态重播是本项目扩展。
- 标准 JSON-RPC Parse/InvalidRequest/InvalidParams/MethodNotFound/Version 等错误
  使用 SDK 码表；REST 使用 SDK 标准 error/status/details。身份/权限失败保持 HTTP
  401/403，未知和无权任务同为 403。SDK 1.2.2 build_error_response 的 EXCEPTION_MAP
  遗漏 JSONParseError，会尝试把 -32700 传给固定 -32603 的模型；本轮使用 SDK 通用
  JSONRPCError 模型及码表解决该错误，未改依赖或 SDK 安装文件。
- 配额为每进程 64/每账号 4，轮询 0.25 秒，心跳 10 秒，寿命 60 秒，send 超时 5 秒。
  权限/令牌重查、创建失败、断线、终态、背压或响应退出都释放已取得的配额。
  XMTP 不接受 Hub 明文 send，query/history 不返回，XMTP 和失败结果不返回 artifact。

## 本轮修改文件（相对开始时的未提交工作区）

代码：
- backend/app/chat/delivery_service.py
- backend/app/chat/delivery_sweeper.py（新增）
- backend/app/main.py
- backend/app/a2a/task_service.py
- backend/app/a2a/client.py
- backend/app/a2a/server.py
- backend/app/a2a/http_protocol.py
- backend/app/a2a/agent_card.py

测试：
- backend/tests/test_delivery_sweeper_linux.py（新增 10 项）
- backend/tests/test_a2a_acceptance_linux.py（新增 27 项，含真实 loopback SDK 远端）
- backend/tests/test_ws_reliable_delivery_linux.py
- backend/tests/test_a2a_protocol_v1_linux.py
- backend/tests/test_a2a_egress_ssrf_linux.py（保持原真实安全断言，仅同步标准请求格式）

文档：ARCHITECTURE.md、本 ADR，以及两份 2026-10-10 阶段三/四 ADR 的历史状态提示。
未修改 connection_manager（评估结果没有现成 Redis 通道），未改适配器、凭据、
迁移文件、依赖、Dockerfile 或启动器。原分支与 HEAD 保持不变，原工作全部保留。

## 验证范围

新增扫描与阶段四验收 37 passed，0 warnings，8.49 秒；其中 JSON parse 首轮
1 failed/21 passed 暴露 SDK 错误映射缺陷，已修复。专项五文件合计 129 passed、
0 failed、5 warnings、32.79 秒（阶段三 48+10；阶段四 36+27；生命周期 8）。
内部真实标准远端及正常/停止流程补充验证 1 passed/26 deselected，0 warnings。
前端 npm test：34 passed、7 files passed，0 warnings，623ms；npm run build：
tsc -b + Vite 成功，Vite 5.31 秒，只有临时 outDir 在项目外的提示，未部署产物。
bash -n scripts/start.sh scripts/deploy.sh 与 git diff --check 通过。
最终最新代码门禁：backend/tests + tests/test_local_agent_adapter.py +
tests/test_local_agent_reliable_linux.py + tests/test_deploy_script.py：
**433 passed、0 failed、0 errors、0 skipped、5 warnings，74.36 秒，退出码 0**。
JUnit 按文件归类：后端全量 409 passed，两个客户端文件 19 passed，部署脚本 5 passed。
5 条警告均来自原 --ws websockets 实现弃用。新增用例相对起始 396 项增加 37 项，
未删减旧安全断言。测试使用独立 mktemp cwd、应用/测试 SQLite、随机合成认证 key，
禁字节码与 pytest cache。分支 fix/audit-hardening-20261008 / HEAD da28ab1 保持。
本轮修改 17 个源代码/测试/文档文件，范围与上一节一致；未改其他机器或仓库。

## 剩余风险、不支持项与迁移

1. Redis 仅有部署配置和依赖，无实际 Pub/Sub 通道；WS 即时投递/取消/进度仅在同一
   进程内有效，多 worker/副本不能保证实时广播。共享 SQL 过期 fencing 与 SSE 轮询
   能跨副本读取持久状态，不等于实时总线；SSE 配额也是进程级，非全局配额。
2. SQLite 并发与合成迁移已测，真实 PostgreSQL 行锁/负载、两台机器、公网 TLS 与
   生产反代未验收。真实网络测试仅本机受控监听及合成 allowlist，未调用真实 CLI。
   扫描依赖异步 DB 驱动配合取消；未测数据库不可取消的驱动故障或大规模候选排序。
3. 已 ACK 外部动作不明时仍需人工核实，没有自动人工恢复工具，不保证 exactly-once。
   扫描不重新派发未 ACK 任务；它们仍由 Runner resume 补偿。
4. HTTP SendMessage 没有持久 messageId 去重承诺（规范允许可选幂等）；客户端不做
   自动发送重试。阻塞超时后应按返回的 taskId 查询，不能盲目新建第二项外部动作。
5. 明确拒绝 taskId 续接、非文本输入、push 配置和非空 tenant；没有模型 token 流/
   逐 chunk Artifact 生产器，没有 gRPC/扩展 Card/OIDC 集成或跨 Hub room ID 映射。
   Python 客户端支持显式远端 token，内部自动对话没有远端凭据配置且不转发本方
   token；受保护真实远端会明确失败，不能声称跨组织身份互操作已经验收。
6. 自动 dialogue 的进度/共识仍是进程内控制逻辑，不是持久 TaskService 任务或主人
   业务承诺；重启恢复自动对话和该循环的跨副本取消未支持。停止远端 HTTP 请求
   不证明已撤销远端副作用。当前 WS 库产生 5 条弃用警告，本轮未迁移启动器。
7. 本轮不新增 schema 或迁移文件。未来生产上线仍需要单独审批并应用此前已有
   a10c20261010 → b20c20261010 → c30c20261010 迁移；绝未对真实库执行迁移。
   合并、生产部署、真实远端凭据配置均不在本轮授权范围。
