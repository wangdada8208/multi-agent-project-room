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
- 删除顺序：`UPDATE messages SET parent_id = NULL ...`（自引用 FK）→ 删除引用 `messages` 的表
  （如 `a2a_tasks.source_message_id`）→ 删除所有含 `room_id` 的表 → 删除 `rooms`。
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
- 工具源码通过 `ast.parse(feature_version=(3,6))` 语法兼容检查。

结果：

```text
$ .venv/bin/python -m pytest scripts/verify/test_prod_legacy_rooms_cleanup.py -q
5 passed in 16.88s
```

**过程中发现并修复的一个测试数据集缺陷**（不是产品缺陷）：`messages` 上
`uq_message_room_seq(room_id, room_seq)` 唯一索引、`room_seq` 默认 0，
同一房间插入多条消息会自相冲突。已为每条消息显式指定不同的 `room_seq`，
修复后 5/5 通过。这也说明工具的目录驱动方式是必要的——手写 SQL 很容易忽略唯一约束。

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

## 4. 生产执行记录

> 本节由组长在真实 dispatch 后补写，见下方「执行记录」。
> 截至本文初次落盘：工具与本地验证已完成，生产尚未执行。

（执行记录待补）
