# SSE 全局配额接入

状态：用户收尾冲刺指令明确批准本次接入与隔离测试；不批准生产迁移、部署、提交或推送。
实施前提案：沿用独立 SSEGlobalQuota Core 表与固定 PG 事务锁；新增 f60 接在
 e50 之后，只存不含凭据/正文的租约元数据。HTTP 先认证与授权，再以独立事务
申请租约，满额返回 HTTP 429 / Retry-After，REST RESOURCE_EXHAUSTED，JSON-RPC
使用 SDK 通用 InternalError 码及 google.rpc.ErrorInfo（SDK 没有配额专用错误）。订阅记录 task ID；
流式创建在任务创建前以随机 reservation UUID 占位，创建成功后绑定真实 task ID。
每进程随机 boot UUID；独立心跳续租，每次 ASGI 写前验证单调时钟截止时间，续租
失败取消响应；响应及生成器 finally 幂等、有界、取消屏蔽释放。每 10 秒独立短
事务 sweep，崩溃后 30 秒 TTL 回收。SQLite 仅本机开发自动建独立表；PG 必须显式
迁移，缺表返回 503，不自动迁移。多 Hub 需同主库、同策略与 READ COMMITTED。
f60 可降回 e50（仅删除暂态配额表，须停 SSE）；e50 自身禁止破坏性 downgrade，
其回滚依赖停写备份恢复。演练只用本轮临时合成数据库。

本轮最终本地验收：后端与适配器 618 passed / 0 failed，36 项 PG 门禁在
SQLite 轮次跳过；独立真实 PostgreSQL 后端全量 617 passed / 0 failed /
0 skipped，覆盖共享配额、续租、释放、崩溃回收及多 Hub。前端 55 项通过，
build、依赖检查、git diff --check 通过。完整迁移链、f60→e50→f60、合成库
20 表 shadow 恢复及真实本机 Nginx SSE/WS 验证通过。Mac Tailscale 可达但
SSH 策略拒绝，真机 E2E 未完成；Docker 镜像运行和 systemd 启动亦未验收。
以上不代表已具备生产发布条件。文件清单及证据见
`docs/verification/2026-10-11-a2a-final.json`，没有执行提交、推送、生产迁移或部署。
