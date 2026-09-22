# XMTP 成员端真正收发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让加密房间里发出的正文进入 XMTP group，并在发送者自己的页面上显示。Hub 仍然只保存 group id。

**Architecture:** 浏览器安装官方 `@xmtp/browser-sdk`，作为群成员调用 `sendText`。FastAPI 继续不加入 group。`workers/xmtp-member` 仍是另一个群成员，负责按 `decideReply` 回复。本地明文只留在成员设备的内存和 XMTP 本地库里。

**Tech Stack:** 现有 React / Vitest 前端、FastAPI / pytest、Node 22、`@xmtp/browser-sdk@7.1.0`、已安装的 `@xmtp/agent-sdk@2.3.0`。

**不要重做：** `feat/xmtp-e2e` 上 `ea1f931` 到 `153267e` 这 8 个提交。它们已经挡住 `transport=xmtp` 房间的正文落库。从本计划 Task 1 开始。

**批准范围：** 可以在 `feat/xmtp-e2e` 上改代码并跑本地测试。不可以合并 `main`，不可以在生产库执行迁移，不可以把钱包私钥或 `XMTP_DB_ENCRYPTION_KEY` 写入 git。

**当天接口核对：** 开工前打开 https://docs.xmtp.org/sdks/browser 。本计划使用 2026-09-23 该页上的 `Client.create`、`conversations.createGroup` 和 `sendText`。若当天页面的方法名变了，先改本计划里的调用，再写实现。

---

### Task 1: 加密房间未投递时不准假装发送成功

**Files:**
- Modify: `frontend/src/lib/xmtpSend.ts`
- Modify: `frontend/src/lib/xmtpSend.test.ts`
- Modify: `frontend/src/hooks/useWebSocket.ts`
- Modify: `frontend/src/components/chat/ChatInput.tsx`

现在 `useWebSocket.ts` 在 `hubPayload === null` 时返回 `true`。`ChatInput` 看到 `true` 就清空输入框。正文没有进入 XMTP。

- [x] **Step 1: Write the failing test**

在 `frontend/src/lib/xmtpSend.test.ts` 追加：

```ts
import { deliverOutgoing } from "./xmtpSend";

it("does not report success when the xmtp sender is missing", async () => {
  const result = await deliverOutgoing({
    transport: "xmtp",
    content: "只有成员能看",
    xmtpGroupId: null,
  });
  expect(result.delivered).toBe(false);
  expect(result.hubPayload).toBeNull();
});

it("reports success only after the xmtp sender resolves", async () => {
  const seen: string[] = [];
  const result = await deliverOutgoing({
    transport: "xmtp",
    content: "只有成员能看",
    xmtpGroupId: "group-dev-1",
    sendToXmtp: async (groupId, content) => {
      seen.push(`${groupId}:${content}`);
    },
  });
  expect(result.delivered).toBe(true);
  expect(result.hubPayload).toBeNull();
  expect(seen).toEqual(["group-dev-1:只有成员能看"]);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test`

Expected: FAIL，`deliverOutgoing` 未导出。

- [x] **Step 3: Write minimal implementation**

在 `frontend/src/lib/xmtpSend.ts` 增加：

```ts
export async function deliverOutgoing(input: {
  transport?: string;
  content: string;
  xmtpGroupId?: string | null;
  sendToXmtp?: (groupId: string, content: string) => Promise<void>;
}): Promise<{ delivered: boolean; hubPayload: { content: string } | null }> {
  const route = routeOutgoing({
    transport: input.transport,
    content: input.content,
  });
  if (route.hubPayload) {
    return { delivered: true, hubPayload: route.hubPayload };
  }
  if (!input.xmtpGroupId || !input.sendToXmtp) {
    return { delivered: false, hubPayload: null };
  }
  await input.sendToXmtp(input.xmtpGroupId, input.content);
  return { delivered: true, hubPayload: null };
}
```

`useWebSocket` 的 `sendMessage` 改为 async，加密房间调用 `deliverOutgoing`。`delivered === false` 时返回 `false`。成功分支只有 `sendToXmtp` 正常返回之后才是 `delivered: true`。

`ChatInput` 的 `onSend` 改为返回 `boolean | Promise<boolean>`。只有结果为 `true` 时才 `setText("")`：

```ts
const submit = () => {
  if (!text.trim() || disabled) return;
  const pending = text.trim();
  void Promise.resolve(onSend(pending, "human")).then((ok) => {
    if (ok) setText("");
  });
};
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test`

Expected: PASS。原有 `routeOutgoing` 的 2 项测试仍然通过。

- [x] **Step 5: Commit**

```bash
git add frontend/src/lib/xmtpSend.ts frontend/src/lib/xmtpSend.test.ts frontend/src/hooks/useWebSocket.ts frontend/src/components/chat/ChatInput.tsx
git commit -m "$(cat <<'EOF'
[前端] 加密房间未投递时不再清空输入

- Added: deliverOutgoing
- Changed: 没有 group id 或发送函数时，发送返回失败
- Removed: 无
- Handoff: 这一步还没有安装浏览器 SDK，也还没有真正 sendText

EOF
)"
```

---

### Task 2: 发送函数改用官方 sendText

**Files:**
- Modify: `frontend/src/lib/xmtpSend.ts`
- Modify: `frontend/src/lib/xmtpSend.test.ts`

当前 `sendXmtpMessage` 调用 `conversation.send`，官方浏览器快速开始写的是 `sendText`。这个函数也还没有任何调用方。

- [x] **Step 1: Write the failing test**

```ts
it("sends with sendText and does not call send", async () => {
  const sendText = vi.fn(async (_text: string) => {});
  const send = vi.fn(async (_text: string) => {});
  const client = {
    conversations: {
      getConversationById: async () => ({ sendText, send }),
    },
  };
  await sendXmtpMessage({
    groupId: "group-dev-2",
    content: "phase-send-text",
    client,
  });
  expect(sendText).toHaveBeenCalledWith("phase-send-text");
  expect(send).not.toHaveBeenCalled();
});
```

文件顶部增加 `import { vi } from "vitest"`。

- [x] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/xmtpSend.test.ts`

Expected: FAIL，因为实现调用的是 `send`。

- [x] **Step 3: Write minimal implementation**

把 `sendXmtpMessage` 里的 `conversation.send` 换成 `conversation.sendText`。找不到会话时抛出的错误只包含 group id，不包含正文。

- [x] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/lib/xmtpSend.ts frontend/src/lib/xmtpSend.test.ts
git commit -m "$(cat <<'EOF'
[前端] 加密发送改用官方 sendText

- Changed: sendXmtpMessage 调用 conversation.sendText
- Handoff: 仍未安装 @xmtp/browser-sdk，调用方还没接上

EOF
)"
```

---

### Task 3: 安装浏览器 SDK，并接上本地身份

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Create: `frontend/src/lib/xmtpLocalIdentity.ts`
- Create: `frontend/src/lib/xmtpLocalIdentity.test.ts`

2026-09-23 `npm view @xmtp/browser-sdk version` 的结果是 `7.1.0`。安装前再跑一次该命令。版本仍是 `7.1.0` 就安装这个版本。若更高，安装当天版本，并在提交说明里写上版本号。

- [x] **Step 1: Write the failing test**

```ts
import { hubSafeIdentity } from "./xmtpLocalIdentity";

it("hub payload contains the address and not the private key", () => {
  const key = "0x" + "ab".repeat(32);
  const payload = hubSafeIdentity({
    privateKey: key,
    address: "0x1111111111111111111111111111111111111111",
  });
  expect(payload).toEqual({
    address: "0x1111111111111111111111111111111111111111",
  });
  expect(JSON.stringify(payload)).not.toContain(key);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/xmtpLocalIdentity.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: Write minimal implementation**

```bash
cd frontend && npm install @xmtp/browser-sdk@7.1.0
```

`xmtpLocalIdentity.ts`：

```ts
const STORAGE_KEY = "mapr-xmtp-inbox-key";

export function hubSafeIdentity(input: { privateKey: string; address: string }): {
  address: string;
} {
  return { address: input.address };
}

export function loadOrCreateInboxKey(): string {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing)) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const created = "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(STORAGE_KEY, created);
  return created;
}
```

按 https://docs.xmtp.org/sdks/browser 的 Quickstart 写 `createBrowserSigner(privateKey)`。`type` 为 `"EOA"`。`signMessage` 返回 `Uint8Array`。安装后运行 `npm ls viem`，用已经存在的那份 viem 把十六进制签名转成字节。不要把私钥写进 `console.log`、请求体或异常文本。

`Client.create` 的环境使用 `dev`。不要把私钥放进发往 Hub 的 JSON。

- [x] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test && npm run build`

Expected: 测试 PASS，`tsc -b && vite build` 成功。

- [x] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/lib/xmtpLocalIdentity.ts frontend/src/lib/xmtpLocalIdentity.test.ts
git commit -m "$(cat <<'EOF'
[前端] 安装官方浏览器 SDK 并保存本地身份

- Added: @xmtp/browser-sdk，以及只留在浏览器里的 inbox 密钥
- Changed: 发给 Hub 的身份对象只有地址
- Removed: 无
- Handoff: 密钥键名是 mapr-xmtp-inbox-key，只存在浏览器本地存储

EOF
)"
```

提交前确认 diff 里没有真实私钥。

---

### Task 4: 加密房间显示成员端消息，而不是等 Hub 回传

**Files:**
- Modify: `frontend/src/hooks/useWebSocket.ts`
- Modify: `frontend/src/pages/RoomPage.tsx`
- Modify: `frontend/src/lib/xmtpSend.ts`

`chatStore.addMessage` 接收完整的 `ChatMessage`。加密房间的历史不能靠 `GET /rooms/{id}/messages`，那里没有正文。

- [x] **Step 1: Write the failing test**

在 `xmtpSend.test.ts` 增加：

```ts
import { toLocalChatMessage } from "./xmtpSend";

it("builds a local chat message without a hub id", () => {
  const message = toLocalChatMessage({
    roomId: "room-1",
    content: "成员端可见",
    senderId: "me",
    senderName: "我",
  });
  expect(message.room_id).toBe("room-1");
  expect(message.content).toBe("成员端可见");
  expect(message.id.length).toBeGreaterThan(0);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/xmtpSend.test.ts`

Expected: FAIL，函数不存在。

- [x] **Step 3: Write minimal implementation**

`toLocalChatMessage` 用 `crypto.randomUUID()` 生成 id，`msg_type` 为 `"text"`，`sender_type` 为 `"human"`，`created_at` 为当前 ISO 时间。

`useWebSocket` 在 `transport === "xmtp"` 时不要调用 `fetchMissedMessages`。

发送成功后调用 `addMessage(toLocalChatMessage(...))`，再返回 `true`。

收到官方 `streamAllMessages` 的文本消息时，同样 `addMessage`。流回调里不要 `console.log` 正文。官方流接口以当天的 https://docs.xmtp.org/chat-apps/list-stream-sync/stream 为准，2026-09-23 的方法名是 `client.conversations.streamAllMessages`。

房间还没有 `xmtp_group_id` 时，由浏览器创建 group，然后只把 group id 提交到已有的 `POST /api/v1/rooms/{room_id}/xmtp-binding`。请求体只有 `xmtp_group_id`。创建 group 的调用使用 `client.conversations.createGroup`。

- [x] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add frontend/src/lib/xmtpSend.ts frontend/src/lib/xmtpSend.test.ts frontend/src/hooks/useWebSocket.ts frontend/src/pages/RoomPage.tsx
git commit -m "$(cat <<'EOF'
[前端] 加密房间在成员端显示正文

- Added: toLocalChatMessage
- Changed: xmtp 房间不再向 Hub 拉历史；发送成功后写入本地消息列表
- Removed: 无
- Handoff: dev 网络双成员核对还没做

EOF
)"
```

---

### Task 5: 未知房间不再被 WebSocket 建成明文房间

**Files:**
- Modify: `backend/app/chat/ws_handler.py`
- Test: `backend/tests/test_xmtp_room_storage.py`

`persist_incoming_message` 在房间不存在时调用 `get_or_create_room`。那个函数创建的房间默认 `transport=hub`，随后正文会被写入 `messages.content`。`_agent_` 开头的任务通道保持原样。

- [x] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_unknown_room_does_not_store_plaintext(db):
    from app.chat.ws_handler import persist_incoming_message
    from app.models.room import Room

    user_id = str(uuid.uuid4())
    room_id = str(uuid.uuid4())
    db.add(User(id=user_id, username="stranger", display_name="Stranger", user_type="human"))
    await db.commit()

    result = await persist_incoming_message(
        room_id=room_id,
        sender_id=user_id,
        sender_type="human",
        sender_name="Stranger",
        content="不能因临时建房而落库",
        msg_type="text",
        parent_id=None,
    )
    assert result is None
    room = await db.get(Room, room_id)
    assert room is not None
    assert room.transport == "xmtp"
```

测试文件里已经有 `uuid`、`User`、`Room` 的导入。没有就补上，不要改断言。

- [x] **Step 2: Run test to verify it fails**

Run: `cd backend && ../.venv/bin/python -m pytest tests/test_xmtp_room_storage.py::test_unknown_room_does_not_store_plaintext -v`

Expected: FAIL。当前会创建 `hub` 房间并返回一条已保存消息。

- [x] **Step 3: Write minimal implementation**

在 `persist_incoming_message` 中，房间不存在且 `room_id` 不以 `_agent_` 开头时，创建 `transport="xmtp"` 的房间并返回 `None`。不要调用 `save_message`。不要记录 `content`。

`_agent_` 通道继续走现有的 `get_or_create_room` 和 `save_message`。

- [x] **Step 4: Run test to verify it passes**

Run: `cd backend && ../.venv/bin/python -m pytest tests/test_xmtp_room_storage.py tests/test_agent_mention.py -q`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add backend/app/chat/ws_handler.py backend/tests/test_xmtp_room_storage.py
git commit -m "$(cat <<'EOF'
[聊天] 未知房间不再通过 WebSocket 收明文

- Changed: 非 _agent_ 的新房间创建为 xmtp，并且不保存正文
- Handoff: _agent_ 任务通道仍是 hub

EOF
)"
```

---

### Task 6: 创建房间只接受 hub 或 xmtp

**Files:**
- Modify: `backend/app/api/rooms.py`
- Test: `backend/tests/test_xmtp_room_storage.py`

`CreateRoomRequest.transport` 现在是普通字符串，默认 `xmtp`。调用方可以传入别的值，从而绕过明文防护。

- [x] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_create_room_rejects_unknown_transport(client, auth_headers):
    rejected = await client.post(
        "/api/v1/rooms",
        headers=auth_headers,
        json={"name": "坏通道", "description": "", "transport": "plaintext"},
    )
    assert rejected.status_code == 422
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd backend && ../.venv/bin/python -m pytest tests/test_xmtp_room_storage.py::test_create_room_rejects_unknown_transport -v`

Expected: FAIL，当前返回 200。

- [x] **Step 3: Write minimal implementation**

把字段改成：

```python
transport: Literal["hub", "xmtp"] = "xmtp"
```

从 `typing` 导入 `Literal`。不传 `transport` 时仍创建 `xmtp` 房间。显式 `hub` 仍允许，用来保留历史明文房间的创建能力。

- [x] **Step 4: Run test to verify it passes**

Run: `cd backend && ../.venv/bin/python -m pytest tests/test_xmtp_room_storage.py -q`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add backend/app/api/rooms.py backend/tests/test_xmtp_room_storage.py
git commit -m "$(cat <<'EOF'
[房间] 传输方式只允许 hub 或 xmtp

- Changed: 其他 transport 值返回 422
- Handoff: 省略该字段时新房间仍是 xmtp

EOF
)"
```

---

### Task 7: 在 dev 网络做一次双成员收发

**Files:**
- Modify: `docs/superpowers/plans/2026-09-23-xmtp-member-send.md`（只把本任务勾上）

这一步不进默认 CI。没有完成这一步，不能说加密聊天已经可用。

- [x] **Step 1: 准备两个身份**

浏览器打开本地前端并登录。加密房间页面生成的地址留在本机，不要写进仓库。

成员进程使用另一把密钥。生成命令各跑两次，分别填进本机环境的 `XMTP_WALLET_KEY` 和 `XMTP_DB_ENCRYPTION_KEY`：

```bash
node -e "console.log('0x' + require('crypto').randomBytes(32).toString('hex'))"
```

`XMTP_ENV=dev`。`XMTP_PEER_ADDRESSES` 填浏览器那个地址。

- [x] **Step 2: 发送一句固定文本**

在加密房间发送 `member-send-dev-ping`。

预期：

- 输入框在发送成功后清空。
- 发送者页面能看到这句。
- 成员进程按 `decideReply` 决定是否回复。回复若出现，也只出现在两个成员的页面或进程输出里。
- Hub 日志里没有 `member-send-dev-ping`。
- 在数据库执行正文搜索，结果为 0 行。测试库可以用：

```bash
sqlite3 backend/test.db "select count(*) from messages where content like '%member-send-dev-ping%';"
```

生产库不要查，也不要迁移。

- [x] **Step 3: 把结果写进提交说明**

只写「dev 网络双成员收发已核对，Hub 中该句出现 0 次」。不要贴密钥、地址或数据库文件。

```bash
git add docs/superpowers/plans/2026-09-23-xmtp-member-send.md
git commit -m "$(cat <<'EOF'
[XMTP] 记录 dev 网络双成员收发已核对

- Changed: 勾选成员端收发计划的 Task 7
- Handoff: 仍未合并 main，仍未迁移生产库

EOF
)"
```

---

## 计划自检

- 未投递却显示成功：Task 1。
- 官方 `sendText`：Task 2。
- 浏览器 SDK 真正安装，密钥不进 Hub：Task 3。
- 发送者能看见自己的话，历史不从 Hub 正文接口补：Task 4。
- WebSocket 临时建房不再落明文：Task 5。
- 非法 transport 被拒绝：Task 6。
- 真网络核对：Task 7。
- 旧的 8 个提交不在本计划里重做。
