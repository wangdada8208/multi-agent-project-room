# Agent 永久归属与一次性绑定

状态：用户已审阅归属绑定数据库、一次性码及四阶段顺序，并明确批准研发实施。
本 ADR 具体化该已批准方向；不代表生产 DDL、真实数据库迁移、部署或主分支合并获批。

## 数据与约束

users 增加可空 owner_user_id（users.id 外键、索引）和 owner_bound_at。
只允许真实 human 成为 owner、真实 agent 被绑定；业务入口验证类型。
owner_user_id 非空后不允许本阶段重新绑定、解除或转让。
agent_card_records 增加可空 agent_user_id（users.id 外键、索引）。
历史 User/Card 均保持空值，不通过用户名、显示名或 URL 自动推断主人。
只有经过已有认证/唯一账号检查的注册入口能把 Card 关联到当前 Agent。
旧 Card 在经过本人认证的重新注册时可关联；关联冲突拒绝。

agent_binding_invites 新增：id、token_hash（唯一）、token_salt、issuer_user_id
（非空 FK/索引）、target_agent_user_id（可空 FK）、expires_at（索引）、
consumed_at、claimed_agent_user_id（可空 FK）、revoked_at、created_at。
令牌为 secrets.token_urlsafe(32)，随机盐 SHA256；明文仅签发响应一次。
邀请只赋予永久身份归属，不授予房间、私有文件、工具或任务执行权限。

## API 与事务

POST /api/v1/agent-bindings/invitations：真实 human 签发，10分钟有效。
可指定 target_agent_user_id 或 target_agent_username，互斥；目标无效统一403。
数据库签发记录限制每主人每10分钟10次（包括撤销/已消费），并在 human 行
获取写锁以串行化计数。未指定目标时知码者可兑换，建议使用指定目标。
POST /claim：已认证 agent，DB重查类型及唯一 casefold 用户名；禁止请求指定owner。
按码定位随机盐并校验哈希；条件 UPDATE 未用、未撤销、未过期、目标匹配的邀请，
再条件 UPDATE 未绑定agent；任一rowcount非1整体回滚。无进程内锁。
GET /agents：仅列当前 human 的真实DB归属，Card关联不能代替归属。
POST /invitations/{id}/revoke：只有签发人可以软撤销未消费邀请，保留审计。
不提供解绑/转让；非法、过期、错目标、已用统一409，不提供账号存在性区别。
claim失败以真实主体限制频率；不在日志输出请求码或hash。

## 迁移与兼容

静态确认现有11个revision为单线，头 f9a1c2d3e4b5。
新revision手写有限增量：两表可空列、命名FK/索引、邀请表/索引。
不改历史revision、不补历史数据、不执行任何现存数据库 upgrade/autogenerate。
历史缺口：room_permissions、room_templates、analytics、room_shares等模型
未在历史Alembic建表中完整体现；env.py和init_db模型导入不同；create_all
不能更新已有表。这些需另行审计，不借本阶段自动修正或删除。
新revision通过batch操作兼容SQLite；用独立临时库构造旧users/Card基线后
upgrade/downgrade验证有限DDL，不能声称整个历史链SQLite兼容。
生产实施前须备份、核验真实alembic_version/列/FK、审阅SQL并单独批准。
回滚优先应用版本回滚并保留归属数据；DDL downgrade会丢弃绑定审计与归属，
仅限合成库自动验证，生产必须备份导出并单独审核，禁止自动降级。

## 验收与范围

合成SQLite测试越权、过期/撤销/重放、重复绑定、指定目标、并发兑换、
旧账号/Card、REST/RPC身份关联、秘密不回显；保留既有Enrollment/SSRF规则。
SQLite不代表PostgreSQL锁/DDL已通过生产验收。
本阶段不修改task_manager、WS或HTTP A2A客户端功能。

## 实现补充

绑定码格式为随机邀请ID加256位随机secret，ID仅用于定位独立盐；摘要覆盖整个码。
签发响应 Cache-Control: no-store。存储错误统一503，不回显SQL参数。
失败兑换与失败签发还有按真实账号ID计数的进程内限流（不信任IP转发头）；
有效签发另有上述跨进程DB配额。多副本失败请求限流需后续共享存储支持，
不能把进程内限流当作分布式限流；原子兑换始终以数据库条件更新为准。
REST与RPC注册都显式传入认证User ID，已关联Card冲突返回403。
已有注册RPC回归增加认证ID参数断言，保留原授权拒绝测试。

## 本轮验证结果（2026-10-10）

先修正pytest-asyncio strict夹具声明，再确认2项有效红测试：旧入口404。
实现后最终122 passed（14.42s）：新增14项绑定/增量迁移测试，加既有
Enrollment、registry、room authz、adapter、Agent URL SSRF、collab回归。
测试从mktemp新建cwd运行；应用/测试URL分别指向不同临时SQLite，随机认证密钥
不输出，关闭pytest cache与字节码；未启动服务、未安装依赖、未访问真实数据库。
迁移验证包括：新建合成SQLite旧表的升降级/旧记录保留/FK，以及PostgreSQL
离线DDL生成；静态确认旧11个revision头与新revision唯一头。
未验证整个历史迁移链与PostgreSQL在线锁/迁移；生产DDL仍待单独审核。
