# 阶段三：本地 Agent WebSocket 持久投递

**最新状态（2026-10-11）**：后台租约扫描已实现，以下“无后台守护进程”等限制
为此前 revision 的历史记录；当前行为与验收见
[2026-10-11 交付记录](2026-10-11-ws-sweeper-http-a2a-acceptance.md)。

## 本次增量实施提案（2026-10-10）

依据主人本次“直接实施代码和测试”的明确授权，在既有阶段三模型上补齐：
派发与过期检查统一按父任务→投递加锁，并在锁后重读状态；进度 ACK 返回已持久化
event_seq，提交后在原任务房间发送 task_progress；新增房间内 task_events 请求，
按 task_id/after_seq/limit 重放同一 TaskService 事件流并逐次验证当前成员权限。
保持既有 ACK/lease/resume/message 格式与 HTTP 事件接口，无新增表或迁移。
空闲订阅在每次广播前复核当前 JWT/账号/房间权限；失败移除连接，检查与发送共用
既有 2 秒超时上限，不让撤销后的连接继续接收进度或任务消息。
取消/完成使用既有 CAS 的单一终态规则：取消先落库时拒绝结果，完成先落库时返回
already_completed，不能承诺撤回已完成动作。第四阶段继续消费相同 event_seq。

状态：用户明确批准本阶段实现、增量模型及合成库迁移验证。生产迁移、部署和合并不在授权范围。

现状：@mention 主路径已创建 A2ATask；旧客户端历史消息可能使用消息 ID。
新增投递只接受经认证账号、源 human 消息及房间角色校验的真实 A2ATask。
源 message_id 单列，绝不把未知聊天 ID 当任务 FK；旧无投递任务保留既有权限检查。

agent_task_deliveries 保存 delivery_id、task_id FK、message_id、agent_user_id FK、
target_room、state、attempt、lease_owner、ACK/租约/投递/取消/创建/更新时间。
任务与投递同事务创建，提交后发送。正文仅从既有合法 hub 消息重建，不进入投递或事件表。
唯一 task_id 防止两个 Agent 争同任务；所有 agent 控制帧必须来自本人专用通道，
DB 重查账号、任务目标、源 human 角色和目标房间，服务端连接 UUID 绑定执行租约。

v=1：ACK 获服务端 task_ack_result accepted 后才执行；attempt 必须匹配。
同连接 ACK 幂等；lease/progress/result 必须持有未过期租约。
未 ACK 的投递可分页重放且增加 attempt；已 ACK 但断线/过期任务禁止自动重跑，
进入 uncertain，需人工核实实际副作用。取消先由 TaskService CAS，然后持久取消投递，
优先发本人通道 task_cancel，重连再次回放，task_cancel_ack 记录回收确认。
进度只接受枚举 phase 与 0..100 数字，无任意文本；事件复用 TaskService 原子序号。
单帧上限 64KiB，重放页/事件页上限 50/100。

适配器单 worker，待办最多32；接收循环不等待 CLI。async subprocess 无 shell，
取消 TERM→限时 KILL→wait，禁止取消后发送输出。租约定期续期，断线停止执行；
重连使用持久投递分页而非最近20条消息。运行内去重加服务端 fail-closed，
不宣称跨崩溃 exactly-once，也不自动恢复不明外部动作。

## 已实现边界

新投递唯一 task_id，原始 message_id 仅追溯引用；未知消息 ID 不转成任务。
隐藏通道保留仅含 ID 的历史 task 标记；新客户端从 delivery 分页恢复。
旧无投递任务继续接受无版本帧，但也以 TaskService 和消息同事务提交终态，
新建可靠任务必须携带 delivery/attempt 并取得连接租约，旧客户端需升级才能执行这些任务。
进度查询复用 /api/v1/tasks/{id}/events?after_seq=N&limit=100，现有房间 viewer 权限检查不变。
ACK、lease、progress、cancel_ack 每次重查账号和任务源权限，并检查 JWT 未过期。
人类取消仅限源房 owner，或有 member 权限的原请求者；Agent 不可假冒主人取消。
租约锁顺序父任务→投递，降低取消/完成并发死锁风险；PostgreSQL 在线锁尚未验收。

限制：未实现后台重派守护进程、自动人工恢复工具或跨 Hub 副本实时广播。
未 ACK 任务在 resume 时重新投递；繁忙/排队超出 deadline 的任务不执行，需再 resume。
ACK 丢失且已经落库时不假定未执行，租约到期只标记 uncertain；已有 ACK 的跨连接
接管不允许自动重新启动。适配器去重仅进程内（最多4096项），跨重启由服务端
持久 ACK/租约阻止盲目重跑；无法保证 exactly-once 或撤销已经发生的外部副作用。
取消回执仅证明本适配器已停止当前工作并回收其子进程，不证明外部动作被撤销。
CLI 输出保留有界，stderr/异常细节不输出；单元测试使用模拟子进程，未调用真实CLI。
本 revision 仅以合成 SQLite 验证有限增量建表/回滚；未运行历史整条迁移链或生产迁移。

## 独立 QA 修复与收尾门禁

四项中危问题均先写有效负测，修复前四项失败：
1. 已 ACK 执行的取消回执必须匹配原 lease_owner；同账号第二连接不能冒充原执行者。
   重连没有持久执行者证明，因此只回放取消指令，不将新连接回执当作旧 CLI 已停止。
   原连接已丢失时须人工核实，不能声称取消已被执行器确认。
2. 每个本次创建的 subprocess 共用一个 cleanup Task；重复 cancel 与 stop 不二次中断
   清理，shield 保护到 wait 完成。同步 stop 返回可等待的关闭 Task，astop/run finally 等待回收。
3. 清理不依赖 leader.returncode；TERM 后有界等待、KILL 整个本次 start_new_session
   创建的 PGID，再 wait，期间排空管道。未经本适配器创建/标记的 PGID 不发信号。
4. 广播并发向各连接发送；单连接 send_json 最多2秒（硬上限3秒），失败从连接集合移除，
   有界关闭，不阻塞健康连接接收。未实现每连接持久队列或控制帧优先队列。

普通 message、人类取消、Agent 控制帧统一逐帧核对 JWT 时效和 DB 当前账号类型。
Agent 用户名按 casefold/slug 检查全账号歧义，历史 human/agent 重名均 fail-closed。
原始 ASGI 文本/bytes 在 json.loads 前检查64KiB；Docker CMD和本地启动脚本显式
使用 --ws websockets --ws-max-size 65536，限制协议栈消息缓冲。
外部自定义启动命令仍须同步配置此限额；未启动真实网络服务验证代理层或线上配置。

本轮触及文件（保留全部既有未提交安全改动）：
- ARCHITECTURE.md、docs/adr/2026-10-10-ws-reliable-delivery.md
- backend/Dockerfile、scripts/start.sh
- backend/alembic/env.py、backend/alembic/versions/c30c20261010_agent_task_deliveries.py
- backend/app/core/database.py、backend/app/models/agent_task_delivery.py
- backend/app/chat/delivery_service.py、backend/app/chat/ws_handler.py
- backend/app/ws/connection_manager.py
- backend/app/a2a/task_service.py（仅事件分页上限）、task_manager.py、routes.py
- local_agent_adapter.py、local_agent_reliable.py
- backend/tests/test_ws_reliable_delivery_linux.py、tests/test_local_agent_reliable_linux.py
- backend/tests/test_agent_mention.py（合法账号/房间权限夹具与隐藏标记）
- backend/tests/test_agent_owner_binding_linux.py（严格新增阶段三单线迁移头校验）

最终新旧专项58 passed（11.61s），0 warnings。c30c 合成SQLite有限升降级/旧记录保留、
离线PostgreSQL DDL均通过；未访问真实数据库，也未应用真实迁移。
适配器已有的注册/对话 RPC 仍使用旧 /a2a 路径，本阶段未迁移这些 HTTP 调用；
可靠 WS 投递要求已合法登记的 Agent，后续阶段四应核对 HTTP 接入兼容。
测试未调用真实 CLI、未进行双机联调，不把单元全绿描述为 exactly-once 或生产验收。

## 本次增量交付记录

起始分支 fix/audit-hardening-20261008，HEAD da28ab1；起始工作区已有 54 个
已修改/未跟踪文件或目录条目，包含阶段一至四候选代码。本地无 origin/main 引用，
未 fetch，不宣称已验证远端 f1af097。保留全部已有未提交工作，不创建提交。

前两阶段代码核验：永久主人绑定已存在；任务统一走 TaskService，状态条件更新为
CAS；事件通过父任务 event_seq + 1 RETURNING 串行递增，task_events 有任务/序号
唯一约束。阶段三既有 ACK、attempt/连接租约、取消控制与适配器 worker 继续沿用。

本次新增 15 个参数展开后的 WS 测试用例，其中前 9 项修改前 9 failed/33 passed，
证明派发/过期竞态、实时进度/序号重放及拒绝非法重放的缺口。补充真正重叠事务的
取消/完成两种赢家、进度事务回滚、空闲订阅撤权和不同主人取消隔离。
真实 loopback Uvicorn/WebSocket 验证分页重投、ACK、实时进度及重连 seq 重放；
不启动应用 lifespan，不连接真实库，不调用真实 CLI。

全量首轮 392 passed/3 failed，失败是已有第四阶段客户端标准请求与旧 SSRF 测试
期望不符；同步 AgentCard/SendMessage/GetTask 断言，保留全部出站安全校验。
随后全量（不含后来新增的真实网络用例）395 passed，43.23s，0 warnings；
协议/权限/任务/适配器专项 116 passed，19.83s。
最终 backend/tests + tests/test_local_agent_adapter.py +
tests/test_local_agent_reliable_linux.py + tests/test_deploy_script.py：
396 passed，5 warnings，52.78s，退出码 0。警告均来自真实网络用例的旧 WS 实现。
使用 mktemp 隔离 cwd、独立应用/测试 SQLite、随机测试密钥，禁 pytest cache 和字节码；
git diff --check 通过。此“全量”仅指列出的后端、适配器和部署脚本测试范围。

本次实际写入 7 个文件：ARCHITECTURE.md、本 ADR、delivery_service.py、
ws_handler.py、connection_manager.py、test_ws_reliable_delivery_linux.py、
test_a2a_egress_ssrf_linux.py。未改动既有阶段四实现、适配器或迁移文件。

剩余边界：生产/真实 PostgreSQL 行锁、跨 Hub 副本广播与双机断线尚未验证；
已 ACK 后崩溃或外部副作用不明仍需人工核实，不自动重跑；没有后台重派守护进程。
UUID cursor 只用于一次分页扫描，新一轮 resume 从空 cursor 开始，不能作为新增任务的
永久高水位。进度限频 5 秒，序号可能与其他事件交错；客户端以 event_seq 去重/补偿。
新增广播逐连接查库，较大订阅规模的性能未测，数据库迟滞会触发既有有界断开。
使用当前 --ws websockets 的真实网络测试有 5 条 Uvicorn/websockets 弃用警告；
本次不改启动器或依赖。与既有 HTTP/SSE 使用相同持久序号，非跨副本实时保证。

最终全量：backend/tests + tests/test_local_agent_adapter.py +
tests/test_local_agent_reliable_linux.py + tests/test_deploy_script.py：345 passed（49.77s），
0 warnings，退出码0。专项及全量均从 mktemp 专用cwd运行、独立应用/测试SQLite、
随机测试密钥、禁pytest cache与字节码。git diff --check通过；全部变更留在未提交工作区。

## 2026-10-11 真机收尾：重连前未执行投递

主人收尾指令批准失败直接修复；本提案限本地内存执行状态，不变更数据库或协议。
Mac 真机断线暴露：worker 将投递标为 running 后，ACK 发送/等待期间断线，尚未
启动 CLI 的记录也被保留 uncertain，重连忽略服务端重新提供的 pending offer。
新增仅本机 `execution_started` 标记，在获准 ACK、租约有效、progress 发送之后，
启动 CLI 之前置 true。断线清理仅丢弃明确尚未执行、且未被主人取消的本机记录，
随后仍必须接受服务端 offer 并再次获得提交成功的 ACK 才能执行。已启动、未知旧
记录、已取消记录保留 fencing，不自动重跑。取消等待、完成与队列断线均补回归。

进一步真机控制帧证据：同一重连 socket 先收到 pending attempt=1，resume 随后
提供 attempt=2，客户端仍等待旧 ACK，忽略新 offer；旧 ACK 被服务端正确拒绝。
修复提案沿用已有 attempt：未执行且未主人取消的记录允许更高代次替代，停止旧
ACK 等待并用独立状态对象重新排队，旧 worker 不得覆盖新代次。执行过/未知记录
不重跑。delivery_denied 控制错误补齐请求的整数 attempt，客户端忽略已知旧代次
错误；无代次的旧服务端错误仍 fail closed。这是兼容性的错误元数据补齐，无新
端点、数据库字段、权限或执行授权。继续依赖服务端提交 ACK 才启动 CLI。
