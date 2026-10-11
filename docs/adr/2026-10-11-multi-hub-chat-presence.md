# 阶段5-A：多Hub聊天与Presence

状态：用户在2026-10-11正式批准沿用PG唯一总线；本ADR记录实施前提案。
不引入新中间件。允许新增迁移，生产迁移、部署和前端写入均未授权。

消息采用每房间事务计数器：普通UPDATE rooms.message_seq + 1取得行锁并持有
到事务commit/rollback，Message.room_seq在同一事务分配，唯一(room_id,room_seq)。
因此同房间后一个序号不能比前一个先commit；rollback回退计数器。不是sequence、
UUID或created_at提交高水位。ORM统一flush钩子覆盖各现有Message写入入口，
同事务发送pg_wakeup协议room标识。未经该钩子的直接SQL写入不在应用契约内。
迁移历史消息按既有显示顺序初始化序号；部署须先在另行批准的维护步骤迁移。

在线连接仅本Hub拥有，RoomSynchronizer串行有界查DB并按room_seq递增发送。
启用后本地Message广播也进入该对账路径，避免直发乱序令游标跳过未发送消息。
新连接默认从留存起点重放，旧浏览器按Message.id去重；显式message_cursor可续传。
REST after_seq提供稳定分页；旧after=ISO仅为保守补偿提示，不能当提交顺序过滤。
所有重放仅hub房间，绝不读取/存储/通知XMTP明文。每帧复核签名访问令牌和当前权限。

room_presences按room/user/connection记录独立hub-owner租约，使用数据库时钟，
心跳只能续尚未过期的原租约；过期旧连接强制重连，不允许僵尸复活。跨tab/Hub
按user去重，当前RoomPermission过滤，Hub失联依TTL清理。公共presence_snapshot
维持旧消费格式并带全局人数/截断信息。元数据支持XMTP，正文不支持。

唯一PgWakeup仍由TaskReconciler持有，通知和LISTEN恢复唤醒聊天对账；聊天另有
有界轮询保险，无第二listener。房间删除/失活/撤权周期检查立即关闭失权连接，
不把通知或本地内存当权限/全局在线真源。客户端不可自报身份、Hub或租约。

前端交接：Message新增room_seq，REST新增after_seq/next_cursor/has_more，WS新增
message_cursor查询参数及messages_resume帧。旧消费者无需变更即可收message和
presence_snapshot；前端将来可用稳定cursor减少默认全留存重放流量。

## e50迁移、回填与恢复边界

迁移新增rooms.message_seq、messages.room_seq、可选client_message_id和room_presences。
历史已提交消息按每房间(created_at,id)稳定回填，唯一索引后把房间计数器置为最大值。
之后所有应用ORM插入在同房间行锁内分配最大值+1；任意晚提交必须等待前序事务结束。
迁移必须停写，不支持新旧Hub混跑：旧写入者没有事务计数器，不能安全滚回旧二进制
并继续写新schema。downgrade主动报错，防止错误标记已回退或删除可靠游标。

未来生产维护（本轮没有执行）：

1. 单独取得迁移/部署批准，停止所有Hub、任务写入与后台worker，排空连接；记录
   数据库版本、Alembic revision、镜像版本和备份校验。用一致性pg_dump自定义格式或
   已验证PITR基线保存**完整数据库**，在独立shadow库恢复并核对所有表/约束/行数。
2. 在shadow执行e50，核对每房间序号唯一、计数器等于最大值、正文/身份/权限/FK
   未改变，再运行新Hub回归。满足维护门禁后才可在停写的生产库执行并切换全部Hub。
3. 迁移失败时保持停写：PG事务回滚后检查实际schema/revision；若不能确认完整回滚，
   从迁移前完整备份恢复到**新shadow数据库**。不可就地DROP字段，也不能仅alembic stamp。
4. 切换新版本后需退回旧版本时，再停止所有写入并备份当前完整库。优先修复前进。
   确需回退，恢复迁移前备份到新shadow；对停写后当前库做全量旧schema兼容导出，
   迁入所有发生变化的旧表，保留消息、任务、事件、权限、审批、附件引用及删除记录。
   新增seq/key/presence字段仅保存在新版本归档中；旧schema不保留新增幂等能力。
   对比所有表的PK、业务字段、删除集合、外键与revision，明确RPO/RTO并经人类批准
   才切换连接。仅恢复旧备份会丢失切换后的写入，不能作为零丢失回滚。
5. 回退后旧浏览器/Hub不得继续使用新cursor；清除新增会话/游标缓存，要求重新认证
   并用旧历史接口。保留新库、归档与审计，方便再次前进。

隔离测试仅证明：SQLite/PG17合成历史数据回填、重复执行、后续ORM序号不冲突；
临时PG的pg_dump/pg_restore到独立shadow以及合成messages的旧列导出保留新写入。
**没有完成生产部署回滚演练**，也没有演练全业务表导出/PITR/真实RPO与RTO。

补充接口：DELETE /api/v1/rooms/{id}为owner专用软删除，保留历史FK；停止所有
房间订阅，分享链接拒绝失活房间。可选client_message_id按(room,sender,key)幂等，
重复同正文返回同Message；同key不同正文拒绝，不重复派发mention任务。


对账默认1秒+jitter、故障退避上限10秒，每轮16连接/50消息、过期租约删除100条；
每个worker串行使用至多一条请求池连接，网络send前关闭session。Presence TTL=30秒，
心跳TTL/3；网络半断开检测还依赖WS transport ping/pong，Hub SIGKILL依DB TTL。
200成员快照之外只保留准确总人数和truncated标识。高负载扫描轮转可能超过TTL，
会安全强制重连；需未来按真实负载配置或分片，不声称固定最坏延迟/无限规模。
逐帧验证包括控制响应和错误帧，失权后关闭而不再发送拒绝帧。
原有临时typing/system帧仍仅本Hub，不持久、没有跨Hub补偿；不做全局房间目录推送。
