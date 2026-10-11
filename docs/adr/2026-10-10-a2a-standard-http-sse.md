# 阶段四：标准 HTTP A2A 与持久 SSE

历史状态提示：进程级 SSE 配额已由本地全局租约接入替代，见 [2026-10-11 SSE 全局配额](2026-10-11-sse-global-quota.md)；以下保留当轮验收记录。
**最新状态（2026-10-11）**：旧 tasks/send 内部出站、默认非阻塞和缺流首帧的
候选缺口已修复；本文件以下测试数字/未完成描述为历史记录。
正式验收与剩余边界见 [2026-10-11 交付记录](2026-10-11-ws-sweeper-http-a2a-acceptance.md)。

状态：用户明确批准四阶段顺序研发，本 ADR 具体化阶段四授权；不批准生产操作。

复用 SDK 1.2.2 的 create_jsonrpc_routes/create_rest_routes、protobuf JSON schema，
使用受控 handler 和路由 wrapper。所有非 Card 入口在 SDK 调用前验证 Bearer、DB User、
真实房间角色及 Agent 永久归属。任务发起者使用 source_agent 中的真实 User ID；
旧任务以 source_message 的 sender_id 辅助校验，不信任客户端身份 metadata。
查询/订阅允许 human owner/member/viewer；取消仅 owner 或非 viewer 的发起者；
Agent 仅本人目标任务且本人及主人仍有房间成员权限。ListTasks 先按权限过滤再分页。
不新增 schema、不迁移数据库。旧 dialogue-rpc、业务 API、WS 保持。

REST /a2a/message:send、message:stream、tasks、tasks/{id}、tasks/{id}:cancel、
tasks/{id}:subscribe（GET/POST）；JSONRPC /a2a/rpc 使用官方 PascalCase methods。
不挂载 SDK tenant catch-all，也不提供 push notification 配置入口。
SSE 使用持久 event_seq 作为 id，Last-Event-ID/after_seq 回放，每页100，轮询新事件，
有界连接寿命、连接配额、send timeout 和心跳。每次重连及轮询重新核验权限与 token。
事件只映射状态与获准 artifact，不输出任意审计 payload。静态 SSE 信任边界为 Hub
可见的控制数据；XMTP 正文不得作为标准 send 输入存储，亦不得作为 artifact 输出。

旧 Python send_task/get_task 签名保留，转为官方 proto 请求；新 cancel/subscribe
同样使用 URL policy，固定已验证公网IP、Host/SNI、TLS校验、禁代理与redirect。
协议版本1.0，SDK版本1.2.2。真实跨机器、公网TLS、PostgreSQL及生产代理行为未证明。

## 实现细则与实际限制

正式 RequestHandler 重写 send/get/cancel/list，复用 TaskServiceTaskStore 的转换器。
SDK默认executor/内存队列不参与这些入站调用。POST JSONRPC 先guard再dispatcher；
REST 路由由官方create_rest_routes取得并逐条包装，省略tenant/push配置路由。
标准 stream 两入口由受控SSE wrapper序列化官方StreamResponse，确保持久id。
每个持久事件一个SSE frame；非完成控制事件为statusUpdate，完成事件为包含文本
Artifact的Task快照；SDK Store保存完成结果时，额外记录仅含artifact_index的持久
artifact_update事件，订阅时按获准结果投影官方artifactUpdate及lastChunk。
当前没有模型token流或逐chunk Artifact追加生产器，不宣称
已实现任意SDK流式扩展。增量进度仅phase/percent；原始payload绝不转发。

所有受保护URL：POST /a2a/rpc；POST /a2a/message:send、/a2a/message:stream；
GET /a2a/tasks、/a2a/tasks/{id}；POST /a2a/tasks/{id}:cancel；
GET/POST /a2a/tasks/{id}:subscribe。仅公开 /.well-known/agent-card.json。
请求需 A2A-Version: 1.0（SDK按主版本兼容1.x），默认缺失为0.3，拒绝标准调用。
标准HTTP额外接受三段式HS256 JWT，固定本地签名算法/密钥，强制exp与DB真实User，
校验nbf、拒绝none/未知算法/错误签名，不访问客户端jku/jwks URL。
兼容项目现有HMAC签名Bearer access token；DB核验账号类型、房间active及角色。
User没有disabled字段，删除账号/类型改变立即拒绝；旧登录接口仍发行旧Bearer，
本阶段没有改造全站登录发行格式或宣称第三方IdP/OIDC已联调。

发送文本仅限合法非XMTP Hub房间；message.metadata.roomId及targetAgent是真实
Room ID与Agent User ID，不是授权来源；source/user由认证上下文给定。
创建Message、Task、Delivery和offer在同一事务，提交后向私有Agent通道广播。
消息taskId续接409拒绝，避免默认SDK绕过角色或创建无房间孤儿任务。
不信任客户端自造Task ID，旧send_task(query,task_id)中的task_id映射messageId，
最终Task ID由远端响应确定。旧Python返回的status字符串从proto enum转换；
Get/Cancel同理，caller无需按proto status对象读取状态。

SSE：页100、每进程64连接/每账号4连接、poll=0.25s、心跳10s、寿命60s、send timeout5s。
不宣称多副本全局连接配额；客户端应以最新event id重连。每轮重查DB身份/权限及
令牌时效。未匹配和未知Task ID同为403，不公开敏感Room ID。
输出完成结果时再次刷新ORM，避免producer在task读取和event查询之间提交造成
已看见完成事件却丢失Artifact。XMTP结果始终隐藏，不输出任务query/history正文。

安全出站stream连接5s/read30s/write30s、关闭环境代理和redirect、TLS默认校验，
每次解析全部DNS并固定验证IP，Host/SNI保留原域名；关闭上下文回收连接。
SSE单frame/未换行buffer均限64KiB；未知Content-Type和redirect直接失败，错误不含URL。
没有把本方用户Bearer自动转发给远端；第三方调用者须显式提供对端认可的token，
通用client池没有对端凭据配置。自动对话的旧_send_to_agent路径仍是历史tasks/send，
不把该旧路径描述为标准互操作已完成。真实远端身份签发与跨Hub房间ID映射未验证。
本阶段标准HTTP与SSE契约测试完全使用ASGI/mocked TCP/TLS，不访问真实外网。

## 测试门禁与未完成项

首次负面门禁4 failed：缺少REST/SSE路由、匿名JSONRPC返回200，未强制身份验证。
最新专项：test_a2a_protocol_v1_linux.py + test_task_lifecycle_linux.py：44 passed，
0 warnings（8.25s）。覆盖官方protobuf ParseDict、client→安全pinned helper→SDK
ASGI闭环、HS256JWT/旧Bearer、账户删除/类型、角色/归属、CAS迟到结果、持久
Artifact及Store重建、seq分页重放、心跳/生命周期、配额和背压退出、加密正文保护。
安全流式出站既mock transport，也保持HTTPX/httpcore真实、只替换TCP/TLS stream，
核验固定IP/原Host/SNI、证书验证、忽略环境代理、connect5s及连接回收。

全量门禁尚未全绿：既有test_a2a_egress_ssrf_linux.py的3项send/status/card测试
硬编码tasks/send、tasks/get、旧参数与旧URL，而阶段四要求改为官方协议。
依用户“保留全部345项旧测试断言”指令，本轮尚未修改任何这些断言；已明确提出
是否仅更新协议预期、完整保留安全断言的问题，未获答复前不修改。
不通过退回旧协议或放宽SSRF保护制造全绿；不宣称阶段四正式验收完成。
生产服务/迁移/部署/Git提交和推送均未执行，旧修改与f9→a10→b20→c30链保留。
旧自动对话outbound尚未迁移，增量模型文本chunk生产器、第三方真实网络身份与
跨机器互操作仍未验收。requirements收紧SDK最低版本1.2.2，无新依赖安装。

最终完整门禁（最新代码）：378 passed、3 failed、0 warnings，59.10s，退出码1。
范围为backend/tests及指定adapter/reliable/deploy三文件，共381项（原345+新36）。
上述3项均为保留的旧协议硬编码断言冲突；其余342项原测试与新增36项通过。
所有测试运行在独立mktemp cwd，应用/测试SQLite分离、随机合成认证key不输出，
PYTHONPATH为绝对repo/backend:repo，禁字节码及pytest cache，单次timeout180s。
git diff --check通过，status已核验，全部变更未提交；正式全绿验收仍未完成。
