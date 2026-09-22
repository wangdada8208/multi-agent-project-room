# 删除历史明文房间 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉用户可见的历史明文房间。本地库里的 `transport=hub` 房间及其聊天记录删除。产品里不再提供「历史明文房间」。

**Architecture:** 用户创建的房间只剩 `xmtp`。`_agent_` 开头的内部任务通道保留，它们不是用户的旧房间。A2A 任务上的 `source_agent="hub"` 是系统名称，不是房间，不要改。

**Tech Stack:** FastAPI、本地 SQLite、React、pytest、Vitest。

**不要做：**

- 不重做 `d62a556` 到 `316d0a9` 的 XMTP 发送和双成员脚本。
- 不连接、不修改生产库，包括 `hub.wangdada8208.xyz` 上的 PostgreSQL。
- 不合并 `main`。
- 不把私钥写入 git。

从本计划 Task 1 开始。

---

### Task 1: 创建房间不再接受 hub

**Files:**
- Modify: `backend/app/api/rooms.py`
- Modify: `backend/tests/test_xmtp_room_storage.py`
- Modify: `backend/tests/test_agent_dialogue_repro.py`

`CreateRoomRequest.transport` 现在是 `Literal["hub", "xmtp"]`。`test_agent_dialogue_repro.py` 会显式创建 `transport=hub` 的房间。

- [x] **Step 1: Write the failing test**

在 `backend/tests/test_xmtp_room_storage.py` 追加：

```python
@pytest.mark.asyncio
async def test_create_room_rejects_hub_transport(client, auth_headers):
    rejected = await client.post(
        "/api/v1/rooms",
        headers=auth_headers,
        json={"name": "旧房间", "description": "", "transport": "hub"},
    )
    assert rejected.status_code == 422
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd backend && ../.venv/bin/python -m pytest tests/test_xmtp_room_storage.py::test_create_room_rejects_hub_transport -v`

Expected: FAIL，当前返回 200。

- [x] **Step 3: Write minimal implementation**

`backend/app/api/rooms.py` 的字段改为：

```python
transport: Literal["xmtp"] = "xmtp"
```

`backend/tests/test_agent_dialogue_repro.py` 里创建 Identity Room 的请求删掉 `"transport": "hub"`。让它走默认的 `xmtp`。若该测试随后要把正文写入 `messages`，改成断言 Hub 拒绝落库，不要为了测试重新打开明文房间。

- [x] **Step 4: Run test to verify it passes**

Run: `cd backend && ../.venv/bin/python -m pytest tests/test_xmtp_room_storage.py tests/test_agent_dialogue_repro.py -q`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add backend/app/api/rooms.py backend/tests/test_xmtp_room_storage.py backend/tests/test_agent_dialogue_repro.py
git commit -m "$(cat <<'EOF'
[房间] 创建接口不再接受明文房间

- Changed: transport 只允许 xmtp
- Handoff: _agent_ 内部通道和 A2A 的 source_agent 名称未改

EOF
)"
```

---

### Task 2: 去掉「历史明文房间」界面

**Files:**
- Modify: `frontend/src/pages/RoomPage.tsx`
- Modify: `frontend/src/lib/xmtpSend.ts`
- Modify: `frontend/src/lib/xmtpSend.test.ts`
- Modify: `frontend/src/hooks/useWebSocket.ts`

`RoomPage.tsx` 在 `transport === "hub"` 时渲染「历史明文房间」。

- [x] **Step 1: Write the failing test**

把 `frontend/src/lib/xmtpSend.test.ts` 里「hub 房间走 websocket」的用例改成：

```ts
it("treats a missing transport as not deliverable on the hub", async () => {
  const result = await deliverOutgoing({
    transport: "hub",
    content: "旧明文",
    xmtpGroupId: null,
  });
  expect(result.delivered).toBe(false);
  expect(result.hubPayload).toBeNull();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/xmtpSend.test.ts`

Expected: FAIL，当前 `transport=hub` 仍返回 hub 载荷。

- [x] **Step 3: Write minimal implementation**

`routeOutgoing` 只在 `transport === "xmtp"` 时走成员端发送。其他值，包括 `hub`，返回 `{ channel: "xmtp", hubPayload: null }`，并且 `deliverOutgoing` 在没有 group id 时返回 `delivered: false`。

删除 `RoomPage.tsx` 里这段：

```tsx
{roomQuery.data?.transport === "hub" && (
  <span style={{ fontSize: 12, fontWeight: "normal", marginLeft: 8, color: "#f59e0b" }}>
    历史明文房间
  </span>
)}
```

`useWebSocket` 的默认参数从 `"hub"` 改为 `"xmtp"`。

- [x] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/pages/RoomPage.tsx frontend/src/lib/xmtpSend.ts frontend/src/lib/xmtpSend.test.ts frontend/src/hooks/useWebSocket.ts
git commit -m "$(cat <<'EOF'
[前端] 去掉历史明文房间入口

- Removed: 房间标题上的历史明文房间标记
- Changed: hub 传输不再从浏览器把正文发给 Hub

EOF
)"
```

---

### Task 3: 删除本地库里的旧房间

**Files:**
- Create: `backend/scripts/delete_hub_rooms.py`
- Create: `backend/tests/test_delete_hub_rooms.py`

只处理仓库里的本地 SQLite。已知 `agent_room.db` 在仓库根目录，并且有 `messages` 表。不要使用生产连接串。

删除范围：`rooms.transport = 'hub'` 且 `rooms.id` 不以 `_agent_` 开头的房间。同时删除这些房间在下列表中的行，顺序必须先子表后房间：

1. `messages`（先把指向这些消息的 `parent_id` 置空）
2. `room_permissions`
3. `room_files`
4. `room_share_tokens`
5. `knowledge_docs`
6. `approvals`
7. `action_grants`
8. `a2a_tasks` 里 `room_id` 属于这些房间的行
9. `analytics_events` 里 `room_id` 属于这些房间的行
10. `rooms`

某张表不存在就跳过该表。`_agent_` 房间留在库里。

- [x] **Step 1: Write the failing test**

```python
import sqlite3
from pathlib import Path

from scripts.delete_hub_rooms import delete_hub_rooms


def test_delete_hub_rooms_keeps_agent_channels(tmp_path: Path):
    db_path = tmp_path / "rooms.db"
    conn = sqlite3.connect(db_path)
    conn.execute("create table rooms (id text primary key, transport text)")
    conn.execute("create table messages (id text primary key, room_id text, content text, parent_id text)")
    conn.execute("insert into rooms values ('old-room', 'hub')")
    conn.execute("insert into rooms values ('_agent_codex', 'hub')")
    conn.execute("insert into rooms values ('new-room', 'xmtp')")
    conn.execute("insert into messages values ('m1', 'old-room', '旧正文', null)")
    conn.execute("insert into messages values ('m2', 'new-room', '新正文', null)")
    conn.commit()
    conn.close()

    summary = delete_hub_rooms(db_path)

    conn = sqlite3.connect(db_path)
    remaining = {row[0] for row in conn.execute("select id from rooms")}
    messages = {row[0] for row in conn.execute("select content from messages")}
    conn.close()
    assert remaining == {"_agent_codex", "new-room"}
    assert messages == {"新正文"}
    assert summary["deleted_rooms"] == 1
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd backend && ../.venv/bin/python -m pytest tests/test_delete_hub_rooms.py -v`

Expected: FAIL，函数不存在。

- [x] **Step 3: Write minimal implementation**

`backend/scripts/delete_hub_rooms.py` 实现 `delete_hub_rooms(db_path: Path) -> dict`。用 sqlite3 标准库。删除前先选出要删的房间 id。不要打印消息正文。返回值只含 `deleted_rooms` 和 `database` 的文件名。

然后对仓库根目录的 `agent_room.db` 执行一次。若文件不存在就跳过，并在提交说明里写明。

- [x] **Step 4: Run test and the local cleanup**

Run: `cd backend && ../.venv/bin/python -m pytest tests/test_delete_hub_rooms.py -q && ../.venv/bin/python -m scripts.delete_hub_rooms`

Expected: 测试 PASS。命令输出的 `deleted_rooms` 是数字。再查：

```bash
sqlite3 agent_room.db "select count(*) from rooms where transport='hub' and id not like '\\_agent\\_%' escape '\\';"
```

Expected: `0`

- [x] **Step 5: Commit**

`agent_room.db` 如果已被 git 跟踪，不要把它加进提交。脚本和测试要提交。

```bash
git add backend/scripts/delete_hub_rooms.py backend/tests/test_delete_hub_rooms.py
git commit -m "$(cat <<'EOF'
[房间] 删除本地历史明文房间

- Added: delete_hub_rooms
- Changed: 本地 SQLite 中的用户 hub 房间已删除
- Handoff: 生产库未执行。_agent_ 通道保留

EOF
)"
```

---

### Task 4: 文档不再要求保留历史明文房间

**Files:**
- Modify: `decisions.md`
- Modify: `docs/xmtp端到端加密-执行文档.md`
- Modify: `ROADMAP.md`
- Modify: `CLAUDE.md`

- [x] **Step 1: 改四份入口**

写明：2026-09-23 起，用户可见的历史明文房间删除，不再保留可读入口。`_agent_` 内部通道保留。生产库未清理。

删掉「界面要把旧房间标成历史明文房间」和「旧房间保持可读」这两类句子。

- [x] **Step 2: Commit**

```bash
git add decisions.md docs/xmtp端到端加密-执行文档.md ROADMAP.md CLAUDE.md
git commit -m "$(cat <<'EOF'
[文档] 取消历史明文房间

- Changed: 入口文档不再要求保留旧房间
- Handoff: 生产库里的旧房间还在，未删

EOF
)"
```

---

## 计划自检

- 用户不能再创建 `hub` 房间：Task 1。
- 界面没有「历史明文房间」：Task 2。
- 本地 `agent_room.db` 里不再有用户可见的 hub 房间：Task 3。
- `_agent_` 与 `source_agent="hub"` 不动。
- 生产库不动。
