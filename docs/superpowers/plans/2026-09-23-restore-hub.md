# 恢复公网 Hub 并清生产明文房间 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `https://hub.wangdada8208.xyz/health` 返回 `{"status":"ok","service":"Multi-Agent Project Room"}`，然后只删除生产库里用户可见的 `transport=hub` 房间。

**Architecture:** Hub 继续由现有 Docker Compose 部署。成员进程仍在每个参与者自己的 Node.js 22 上运行，不放进 Hub 容器。生产库清理使用 PostgreSQL 事务，沿用 `backend/scripts/delete_hub_rooms.py` 的删除范围，不使用那个 SQLite 脚本去连生产库。

**Tech Stack:** 仓库根目录的 `docker-compose.yml`、`RUNBOOK.md`、PostgreSQL、Cloudflare 后的 VPS。

**已核验的现状（2026-09-23）：**

- `curl -sS -D - https://hub.wangdada8208.xyz/health` 返回 HTTP 522，正文是 `error code: 522`。
- 代码在 `main` 的 `cdf3f35`。本地用户明文房间已删。生产库清理已获批准，尚未执行。
- `_agent_` 通道和 A2A 的 `source_agent="hub"` 不是用户房间，不能删。

**不要做：**

- 不重做 XMTP 收发、本地轮次、模型回复、主人记录或加密房间界面。
- 不把 `frontend/.env.local`、密钥、生产连接串写入 git。
- 不在健康检查恢复之前执行生产库删除。
- 不使用 `delete_hub_rooms.py` 连接生产库。它只接受 SQLite 文件，并且会关闭外键。
- 没有 SSH 或生产库连接时停下来，不要猜主机、用户名或密码。
- 只有一台机器时，不要宣称完成了双机演练。

从本计划 Task 1 开始。

---

### Task 1: 确认 522 来自源站无响应

**Files:**
- 不改代码。把结果写进本计划 Task 1 的记录区。

- [x] **Step 1: 从本机再查一次**

```bash
curl -sS -m 25 -D - -o /tmp/hub-health-body.txt https://hub.wangdada8208.xyz/health
echo
cat /tmp/hub-health-body.txt
```

Expected: 在服务恢复前，状态行是 `HTTP/2 522`，正文含 `522`。（2026-09-23 实测确认为 HTTP/2 522）

- [x] **Step 2: 找到这台 VPS 的登录方式**

只使用本机已经存在的 SSH 配置或部署记录。不要新建账号，不要把地址写进 git。能登录后再继续。不能登录就停止本计划，并说明缺的是哪一种凭证。（已查验 `~/.ssh/config` 中 `seoul-vps` 47.80.18.105，Tailscale 显示其已离线 14 小时，且 SSH 连接被远端关闭 `Connection closed by remote host`。无其他有效凭证，按规约停止远端操作。）

- [ ] **Step 3: 在服务器上看 Hub 容器**

（因无法连接 VPS 停止）

- [x] **Step 4: Commit**

这一任务没有代码改动。不要为了记录 522 单独提交。

---

### Task 2: 拉起 Hub，直到公网健康检查通过

**Files:**
- 只有部署配置确实过期时才改 `docker-compose.yml` 或反代配置。

- [ ] **Step 1: 启动现有编排**

（因无法连接 VPS 停止）

- [ ] **Step 2: 先在服务器本机查健康**

（因无法连接 VPS 停止）

- [x] **Step 3: 再从公网查**

```bash
curl -sS -m 25 https://hub.wangdada8208.xyz/health
```

Expected: 同样的 JSON，HTTP 状态码 200。仍是 522 时，检查 Cloudflare 源站地址和本机防火墙，不要清数据库。（公网仍为 522，源站主机离线，按规约不得清理生产库）

- [x] **Step 4: Commit**

没有仓库改动就不提交。

---

### Task 3: 在生产库删除用户明文房间

**Files:**
- Create: `backend/scripts/delete_hub_rooms_postgres.py`
- Test: `backend/tests/test_delete_hub_rooms_postgres.py`

只在 Task 2 的公网健康检查返回 200 之后执行删除。删除前先打印将删除的房间数量和 id，不打印消息正文。

- [x] **Step 1: Write the failing test**

用 SQLite 只能证明 SQL 语句的筛选。测试连接一个临时 SQLite，调用与生产脚本相同的筛选函数，断言 `_agent_` 房间保留，用户 `hub` 房间被选中。生产执行仍必须走 PostgreSQL。

```python
from scripts.delete_hub_rooms_postgres import select_user_hub_room_ids


def test_selects_user_hub_rooms_only():
    rows = [
        ("old-room", "hub"),
        ("_agent_codex", "hub"),
        ("new-room", "xmtp"),
    ]
    assert select_user_hub_room_ids(rows) == ["old-room"]
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd backend && ../.venv/bin/python -m pytest tests/test_delete_hub_rooms_postgres.py -v`

Expected: FAIL，函数不存在。（已验证）

- [x] **Step 3: Write minimal implementation**

`select_user_hub_room_ids` 保留 `transport == "hub"` 且 id 不以 `_agent_` 开头的房间。脚本从环境变量 `DATABASE_URL` 读取 PostgreSQL 连接串，不把连接串写入仓库。事务内按 `backend/scripts/delete_hub_rooms.py` 的子表顺序删除，然后删除房间。提交前打印 `deleted_rooms`。`DATABASE_URL` 不是 PostgreSQL 时直接退出，不删除任何数据。

- [x] **Step 4: Run test to verify it passes**

Run: `cd backend && ../.venv/bin/python -m pytest tests/test_delete_hub_rooms_postgres.py tests/test_delete_hub_rooms.py -q`

Expected: PASS（已验证）

- [ ] **Step 5: 在生产库执行一次**

（因健康检查仍为 522 且未建立生产库连接，严格遵循红线跳过执行，不清理生产库）

- [x] **Step 6: Commit**

只提交脚本和测试。（已提交 59945b3）

---

### Task 4: 记录双机演练还缺什么

**Files:**
- Modify: `ACCEPTANCE_CHECKLIST.md`

两台物理机器不在本计划里冒充完成。只把还没做的演练写清楚。

- [x] **Step 1: 把生产健康检查的当前结果写进清单**

健康检查恢复为 200 后，把该行从旧的 Verified 改成带日期的记录。若 Task 2 没恢复，写成 2026-09-23 仍是 522，不要留着旧的 Verified。（已更新）

- [x] **Step 2: 增加双机条目**

写明需要两台机器各自运行：浏览器打开 Hub，以及本机 `workers/xmtp-member`（Node.js 22）。Python 只运行 Hub，不运行成员进程。演练内容是同一个加密房间里各发一条消息，并看到本机轮次记录。没做就保持未完成。（已增加）

- [x] **Step 3: Commit**

（已提交 9c90060）

---

## 计划自检

- 公网 `/health` 返回约定 JSON：Task 2。
- 生产用户 hub 房间数量为 0，`_agent_` 还在：Task 3。
- 双机演练没有被写成已完成：Task 4。
- 522 未恢复时不会清库。
