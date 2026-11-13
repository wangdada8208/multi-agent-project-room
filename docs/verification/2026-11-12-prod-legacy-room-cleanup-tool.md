# 生产库旧明文房间清理 — 工具、本地验证与执行记录（2026-11-12）

> 决策依据：`decisions.md` 2026-09-22 / 2026-09-23 / 2026-11-12 节；
> 删除范围定义：`docs/superpowers/plans/2026-09-23-delete-legacy-rooms.md` Task 3。
> 2026-11-12 主人一次性批准全部剩余收尾事项，本项是其中之一。
>
> 删除范围：`rooms.transport = 'hub'` 且 id 不以 `_agent_` 开头的房间，及其全部子表行。
> **`_agent_` 内部通道与所有 xmtp 房间必须保留。**

## 背景

`ROADMAP.md` 原记录「生产库中的用户 hub 房间清理已获人类批准，尚未执行。现有脚本只处理本地 SQLite，
当前环境没有生产库连接」。本地脚本 `backend/scripts/delete_hub_rooms.py` 是 SQLite 版、写死表清单，
不能直接用于 PostgreSQL 生产库。本次补上 PostgreSQL 版工具，并在**本地真实 PostgreSQL 17** 上
用真实迁移建出的 schema 完整验证后，才由组长通过自建 runner 触发生产执行。

## 1. 工具

`scripts/verify/prod_legacy_rooms_cleanup.py`（Python 3.6 语法兼容，生产宿主机 python3 为 3.6）：

| 模式 | 行为 |
|---|---|
| `check` | 严格只读。会话先 `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` 并回读 `transaction_read_only` 确认；输出房间总数、xmtp 房间数、`_agent_` 房间数、待删房间数，以及**每一张含 `room_id` 列的表**中属于待删房间的行数；列出引用 `rooms` / `messages` 的外键依赖；打印将执行的 SQL 供人工复核；零写入。 |
| `backup` | 只做 `pg_dump -Fc` 备份，校验文件非空且以 `PGDMP` 开头，打印路径；不删除。 |
| `execute` | 必须先精确匹配 `--confirm DELETE-LEGACY-HUB-ROOMS`；先做一次**全新备份**并校验；随后在**单个 `BEGIN; ... COMMIT;` 事务**内删除；提交后重新取数并断言。任何断言失败即非零退出并保留备份。 |

安全性质：

- 子表与外键列**全部由数据库目录动态发现**（`information_schema` + `pg_constraint`），不写死表清单。
  实测发现 `analytics_events.room_id` 没有外键，写死清单会漏掉它并留下孤儿行。
- 删除顺序：`UPDATE messages SET parent_id = NULL ...`（自引用 FK）→ 按外键的
  `ON DELETE` 动作处理引用 `messages` 的表（`SET NULL`/`SET DEFAULT` 用 UPDATE 置空/置默认，
  只有 NO ACTION / RESTRICT / CASCADE 才删除整行）→ 删除所有含 `room_id` 的表 → 删除 `rooms`。
  **这一条很重要**：保留房间（例如 `_agent_`）里的任务行可能引用了旧房间的消息，
  整行删除会越出批准范围；置空引用才能既保住数据又不阻塞删除。
- 待删集合用 `left(id,7) <> '_agent_'` 界定，与 `transport='hub'` 同时成立才算，避免误伤内部通道。
- 单事务；`ON_ERROR_STOP=1`；空集合时回滚/直接零写入退出。
- 不打印数据库口令、房间完整 id、聊天正文；错误信息经过脱敏。
- DB 访问方式可由 `MAPR_HYGIENE_PSQL_CMD` 覆盖（本地验证用 psql），
  生产默认走 `docker exec -i <postgres容器> psql`；
  `MAPR_HYGIENE_DOCKER_CMD` 可设为 `sudo -n docker`（生产宿主 docker socket 常为 root 权限），
  `MAPR_HYGIENE_PG_CONTAINER` 可由工作流自动探测后注入。

`.github/workflows/prod-hygiene.yml`：`workflow_dispatch` 唯一入口，运行在
`[self-hosted, multi-agent]`（北京 `multi-agent-runner-bj`），`permissions: contents: read`，
输入 `mode`（默认 `check`）与 `confirm`。先探测 postgres 容器并配置 docker 命令，再调用工具。

## 2. 本地验证（真实 PostgreSQL 17 + 真实迁移 schema）

`scripts/verify/test_prod_legacy_rooms_cleanup.py` 在**隔离端口 55434**（数据目录
`/tmp/mapr-hygiene-pgdata`）启动 PG17，用
`MAPR_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55434/agent_room_hygiene PYTHONPATH=backend .venv/bin/python -m alembic upgrade head`
建出与生产同构的真实 schema（20 个迁移，head `i90c20261017`），再插入合成数据集：
2 个 legacy hub 房间、1 个 `_agent_` 房间、2 个 xmtp 房间，以及 11 张含 `room_id` 的表中的
legacy / 非 legacy 行、自引用 `parent_id` 消息、`a2a_tasks.source_message_id` 等。

验证内容：

- `check` 只读、计数正确、不产生任何写入；
- `backup` 生成非空 `PGDMP` 文件且不删除任何行；
- 错误 `--confirm` 零删除；
- 正确 `--confirm` 后：待删房间为 0，`_agent_` 与 xmtp 房间及其子表行完整保留，
  所有 legacy 子表行清空，无 `room_id` / `message` 孤儿行；
- 新增回归：**`_agent_` 房间里的任务引用了旧房间消息时，该任务行必须保留、
  只把 `source_message_id` 置空**（初版工具会整行删除，属于越界删除，已修正并加用例）；
- 工具源码通过 `ast.parse(feature_version=(3,6))` 语法兼容检查。

结果：

```text
$ .venv/bin/python -m pytest scripts/verify/test_prod_legacy_rooms_cleanup.py -q
6 passed in 18.54s
```

**过程中发现并修复的两个问题**：

1. 测试数据集缺陷（不是产品缺陷）：`messages` 上 `uq_message_room_seq(room_id, room_seq)`
   唯一索引、`room_seq` 默认 0，同一房间插入多条消息会自相冲突。已为每条消息显式指定
   不同的 `room_seq`。这也说明目录驱动方式是必要的——手写 SQL 很容易忽略唯一约束。
2. **工具本身的越界删除缺陷**：初版对引用 `messages` 的外键一律 `DELETE`，
   生产只读盘点显示 `a2a_tasks.source_message_id` 为 `ON DELETE SET NULL`，
   保留房间里的任务若引用旧消息会被误删。改为按 `confdeltype` 分别用
   `UPDATE ... SET col = NULL` / `SET DEFAULT` / `DELETE`，并补回归用例。
   该修正在**生产执行之前**完成并重新跑通全部 6 项本地测试。

## 3. 复核命令（任何人都可照抄）

```bash
# 只读盘点（不写库）
gh workflow run prod-hygiene.yml --ref main -f mode=check

# 只备份（不写库）
gh workflow run prod-hygiene.yml --ref main -f mode=backup

# 执行（必须精确填写确认串，工具内部还会再做一次全新备份）
gh workflow run prod-hygiene.yml --ref main \
  -f mode=execute -f confirm=DELETE-LEGACY-HUB-ROOMS

# 执行后复核
gh workflow run prod-hygiene.yml --ref main -f mode=check
```

## 4. 生产执行记录（真实运行结果）

执行时间：2026-11-14 00:27（Asia/Taipei）/ 2026-11-13 16:27 UTC。
全部通过 `prod-hygiene.yml` 的 `workflow_dispatch` 在北京自建 runner 上完成，组长未直接登录服务器。

| 运行 | 模式 | 结论 | 作用 |
|---|---|---|---|
| `43458683262` | check | failure | 首次尝试：`sudo -n docker` 因 sudo secure_path 找不到 docker 二进制（已修工作流） |
| `43459834227` | check | failure | runner 到 github.com 的 checkout 连接超时（网络抖动，重试后恢复） |
| `43460928682` | check | **success** | 只读盘点，输出 7 个待删房间与完整依赖图 |
| `43461966513` | check | **success** | 复核「保留房间任务引用旧消息」修正后的 SQL（UPDATE 置空而非 DELETE） |
| `43462676253` | execute | **success** | 备份 → 单事务删除 → 断言通过 |

执行后另发起独立 `check` 复核。北京 runner 到 github.com 的 `actions/checkout` 偶发连接超时
（`43463042336`、`43463703590` 两次失败，均为网络抖动，不影响已提交的事务；
第三次 `43464569873` **成功**）。此前 `43458683262` 也因 `sudo` secure_path 找不到 docker
失败（已改为解析绝对路径后修复），`43459834227` 因同一网络抖动失败，
第三次 `43460928682` 成功。

成功的事后只读复核（`43464569873`）：

```text
CHECK OK - session was READ ONLY, nothing modified.
JSON_SUMMARY {"mode":"check","read_only":true,"rooms_total":5,"rooms_xmtp":1,
 "rooms_agent":4,"rooms_legacy":0,"msgs_in_legacy":0,"msgs_parent_ref":0,
 "room_id_tables":11,"fk_constraints":12}
```

即使不依赖事后复核，`43462676253` 自身在 COMMIT 之后已重新取数并断言通过：
`rooms_legacy 0`、`rooms_agent 4`、`rooms_xmtp 1`、`room_orphans 0`、
`message_orphans 0`、`assertions_ok=true`；再加上生产 `/health` 200、
`/ready` 仍为 `i90c20261017`（见本节末尾）。因此清理结果的证据是充分的，
事后 `check` 只是额外确认。

只读盘点（`43460928682` / `43461966513`）：

```text
read_only session         : on
total rooms 12 | xmtp rooms 1 | _agent_ rooms 4 | legacy hub rooms 7 (DELETE TARGET)
a2a_tasks 41 | analytics_events 15 | messages 15 | room_permissions 1
messages referencing them via parent_id: 25
CHECK OK - session was READ ONLY, nothing modified.
JSON_SUMMARY {"mode":"check","read_only":true,"rooms_total":12,"rooms_xmtp":1,
 "rooms_agent":4,"rooms_legacy":7,"msgs_in_legacy":15,"msgs_parent_ref":25,
 "room_id_tables":11,"fk_constraints":12}
```

执行（`43462676253`）：

```text
BACKUP_PATH /opt/multi-agent-project-room/backups/legacy-room-backup-20261114T002701102148/database.dump
backup verified: non-empty, starts with PGDMP
Running ONE transaction (BEGIN ... COMMIT) ...
Before / After counts:
  total rooms              12 ->  5
  xmtp rooms                1 ->  1
  _agent_ rooms             4 ->  4
  legacy hub rooms          7 ->  0
  messages in legacy rooms 15 ->  0
  room_id orphans           0 ->  0
  message-FK orphans        0 ->  0
  a2a_tasks                41 ->  0
  analytics_events          15 ->  0
  messages                  15 ->  0
  room_permissions           1 ->  0
EXECUTE OK - legacy hub rooms deleted; _agent_ and xmtp rooms preserved;
             no orphan rows; single transaction committed.
JSON_SUMMARY {"mode":"execute","backup_ok":true,"assertions_ok":true, ...}
```

执行后线上复核（同一时刻直接请求生产）：

```text
GET https://hub.wangdada8208.xyz/health
200 {"status":"ok","service":"Multi-Agent Project Room"}

GET https://hub.wangdada8208.xyz/ready
200 {"status":"ready","service":"Multi-Agent Project Room",
     "database":"connected","revision":"i90c20261017"}
```

**结论**：生产库 7 个旧明文房间及其 41 条任务、15 条埋点、15 条消息、1 条权限记录已删除；
4 个 `_agent_` 内部通道与 1 个 xmtp 房间完整保留；零孤儿行；删除在单个事务内完成，
删除前已生成并校验 `pg_dump` 备份；生产服务与迁移版本未受影响。

### 4.1 恢复方式（如需要）

备份位于生产主机 `/opt/multi-agent-project-room/backups/legacy-room-backup-20261114T002701102148/database.dump`
（`PGDMP` 自定义格式）。恢复须由人类批准，并且**必须先停掉所有写入该库的 Hub**，
按 `RUNBOOK.md` 的「Deploy Notes」把备份还原到独立的影子库验证后再决定，
不要在正在运行的库上直接覆盖。
