# XMTP 双成员收发核对 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让加密房间的群里包含成员进程，并在 XMTP dev 网络上留下一份不含密钥的双成员收发证据。

**Architecture:** 浏览器不再调用 `createGroup([])`。它先建群，再用官方 `addMembersByIdentifiers` 把 `VITE_XMTP_WORKER_ADDRESS` 加进去，然后只把 group id 绑定到 Hub。另一份 Node 脚本用两个 `@xmtp/agent-sdk` 客户端在 dev 网络对发，并把结果写入证据文件。

**Tech Stack:** 已安装的 `@xmtp/browser-sdk@7.1.0`、`@xmtp/agent-sdk@2.3.0`、Vitest、Node 22。

**不要重做：** `d62a556` 到 `f217356` 已经接上 `deliverOutgoing` 和 `sendText`。`39e2621` 只勾选了旧计划，不能当作双成员收发已经发生。从本计划 Task 1 开始。

**批准范围：** 在 `feat/xmtp-e2e` 上改代码并跑本地测试。不合并 `main`。不在生产库执行迁移。不把私钥写入 git。证据文件里可以有 group id，不能有 `0x` 加 64 位十六进制的私钥。

**当天接口：** 浏览器加成员用的是本机已安装的 `@xmtp/browser-sdk@7.1.0` 里的 `Group.addMembersByIdentifiers`。Node 建群用的是 `@xmtp/agent-sdk@2.3.0` 里的 `Agent.create`、`createUser`、`createSigner`、`createGroupWithAddresses`。若升级 SDK 后这些名字变了，先改本计划再写代码。

---

### Task 1: 没有成员地址时不准建空群

**Files:**
- Create: `frontend/src/lib/xmtpGroup.ts`
- Create: `frontend/src/lib/xmtpGroup.test.ts`
- Modify: `frontend/src/pages/RoomPage.tsx`

当前 `RoomPage.tsx` 在没有 group id 时执行 `client.conversations.createGroup([])`。这个群只有浏览器自己，成员进程不在里面。

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { IdentifierKind } from "@xmtp/browser-sdk";
import { memberIdentifier, assertWorkerAddress } from "./xmtpGroup";

describe("memberIdentifier", () => {
  it("rejects a missing worker address", () => {
    expect(() => assertWorkerAddress("")).toThrow(/worker address required/);
  });

  it("builds an ethereum identifier and hides nothing else", () => {
    const identifier = memberIdentifier("0x1111111111111111111111111111111111111111");
    expect(identifier).toEqual({
      identifier: "0x1111111111111111111111111111111111111111",
      identifierKind: IdentifierKind.Ethereum,
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/xmtpGroup.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: Write minimal implementation**

`frontend/src/lib/xmtpGroup.ts`：

```ts
import { IdentifierKind, type Identifier } from "@xmtp/browser-sdk";

export function assertWorkerAddress(address: string | undefined): string {
  const value = address?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("worker address required");
  }
  return value;
}

export function memberIdentifier(address: string): Identifier {
  return {
    identifier: assertWorkerAddress(address),
    identifierKind: IdentifierKind.Ethereum,
  };
}
```

`RoomPage.tsx` 里先取地址，再建群，再加成员，最后绑定。地址不合法时下面第一行就抛错，不要调用 `createGroup`：

```ts
const workerAddress = assertWorkerAddress(
  import.meta.env.VITE_XMTP_WORKER_ADDRESS as string | undefined,
);
const group = await client.conversations.createGroup([]);
await group.addMembersByIdentifiers([memberIdentifier(workerAddress)]);
```

地址缺失时 `memberIdentifier` 抛错，不要绑定 group id，不要 `console.log` 正文或私钥。在 `frontend/.env.example` 增加一行 `VITE_XMTP_WORKER_ADDRESS=`。如果该文件不存在就创建它，只写变量名。

- [x] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test`

Expected: PASS。原有 9 项加上这 2 项。

- [x] **Step 5: Commit**

```bash
git add frontend/src/lib/xmtpGroup.ts frontend/src/lib/xmtpGroup.test.ts frontend/src/pages/RoomPage.tsx frontend/.env.example
git commit -m "$(cat <<'EOF'
[前端] 加密房间建群时加入成员进程地址

- Added: memberIdentifier
- Changed: 空地址不再绑定 group id
- Removed: createGroup 之后不再把没有成员的群当成可收发房间
- Handoff: 浏览器环境变量是 VITE_XMTP_WORKER_ADDRESS，只填公开地址

EOF
)"
```

---

### Task 2: 用两个 Node 客户端在 dev 网络对发

**Files:**
- Create: `workers/xmtp-member/src/devRoundtrip.ts`
- Create: `workers/xmtp-member/src/evidence.ts`
- Create: `workers/xmtp-member/src/evidence.test.ts`

这一步才是双成员收发。不要再只勾选计划。

- [x] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidence } from "./evidence.ts";

test("evidence keeps the group id and rejects a private key", () => {
  const evidence = buildEvidence({
    groupId: "965627937735f844c4248315a1e8d966",
    probeReceivedByPeer: true,
    replyReceivedBySender: true,
    hubPlaintextCount: 0,
    messagesTablePresent: true,
    hubDatabase: "local-dev",
  });
  assert.equal(evidence.group_id, "965627937735f844c4248315a1e8d966");
  assert.equal(evidence.probe_received_by_peer, true);
  assert.throws(() =>
    buildEvidence({
      groupId: "group-1",
      probeReceivedByPeer: true,
      replyReceivedBySender: true,
      hubPlaintextCount: 0,
      messagesTablePresent: true,
      hubDatabase: "0x" + "ab".repeat(32),
    }),
  );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/evidence.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: Write minimal implementation**

`evidence.ts` 返回下面的字段，并在任一字符串匹配 `/0x[0-9a-fA-F]{64}/` 时抛错：

```ts
export function buildEvidence(input: {
  groupId: string;
  probeReceivedByPeer: boolean;
  replyReceivedBySender: boolean;
  hubPlaintextCount: number;
  messagesTablePresent: boolean;
  hubDatabase: string;
}): {
  checked_at: string;
  env: "dev";
  group_id: string;
  probe_name: "member-send-dev-ping";
  probe_received_by_peer: boolean;
  reply_received_by_sender: boolean;
  hub_plaintext_count: number;
  messages_table_present: boolean;
  hub_database: string;
} {
  const evidence = {
    checked_at: new Date().toISOString(),
    env: "dev" as const,
    group_id: input.groupId,
    probe_name: "member-send-dev-ping" as const,
    probe_received_by_peer: input.probeReceivedByPeer,
    reply_received_by_sender: input.replyReceivedBySender,
    hub_plaintext_count: input.hubPlaintextCount,
    messages_table_present: input.messagesTablePresent,
    hub_database: input.hubDatabase,
  };
  if (/0x[0-9a-fA-F]{64}/.test(JSON.stringify(evidence))) {
    throw new Error("evidence contains a private key");
  }
  if (!input.messagesTablePresent) {
    throw new Error("messages table absent");
  }
  return evidence;
}
```

`devRoundtrip.ts` 使用已安装 SDK 的这些调用：

```ts
import { writeFileSync } from "node:fs";
import { Agent, createSigner, createUser } from "@xmtp/agent-sdk";
import { buildEvidence } from "./evidence.ts";

const PROBE = "member-send-dev-ping";

const bobUser = createUser();
const bob = await Agent.create(createSigner(bobUser), { env: "dev", dbPath: null });
let probeReceived = false;
let replyReceived = false;

bob.on("text", async (ctx: { message?: { content?: unknown }; conversation?: { sendText?: (text: string) => Promise<unknown> } }) => {
  const text = typeof ctx.message?.content === "string" ? ctx.message.content : "";
  if (text === PROBE) {
    probeReceived = true;
    await ctx.conversation?.sendText?.("收到，本轮由 Codex 处理。");
  }
});
await bob.start();

const aliceUser = createUser();
const alice = await Agent.create(createSigner(aliceUser), { env: "dev", dbPath: null });
const group = await alice.createGroupWithAddresses([bob.address as `0x${string}`]);
await group.sendText(PROBE);

alice.on("text", async (ctx: { message?: { content?: unknown } }) => {
  const text = typeof ctx.message?.content === "string" ? ctx.message.content : "";
  if (text.includes("收到，本轮由")) replyReceived = true;
});
await alice.start();
```

`bob.address` 在 `Agent.create` 之后才会有。若类型允许 `undefined`，地址为空时直接抛错并退出，不要建群。

脚本要等 peer 收到探针并且 sender 收到回复，最多等 60 秒。超时就以非 0 退出，不要写证据文件。

Hub 计数另用一段 Python，对着真正有 `messages` 表的库执行。`backend/test.db` 当前没有这张表，不能用来得出 0。先确认表存在：

```bash
sqlite3 "$HUB_SQLITE" "select name from sqlite_master where type='table' and name='messages';"
```

有输出之后再查：

```bash
sqlite3 "$HUB_SQLITE" "select count(*) from messages where content like '%member-send-dev-ping%';"
```

把这个数字传给 `buildEvidence`。表不存在就让脚本失败。

证据写到 `docs/superpowers/evidence/dev-roundtrip.json`。文件内容只来自 `buildEvidence` 的返回值。

- [x] **Step 4: Run the unit test, then the network script**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/evidence.test.ts`

Expected: PASS

然后：

```bash
cd workers/xmtp-member && npx tsx src/devRoundtrip.ts
```

Expected: 进程退出码 0，并且 `docs/superpowers/evidence/dev-roundtrip.json` 里 `probe_received_by_peer` 和 `reply_received_by_sender` 都是 `true`，`hub_plaintext_count` 是 `0`，`messages_table_present` 是 `true`，`group_id` 非空。

- [x] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/devRoundtrip.ts workers/xmtp-member/src/evidence.ts workers/xmtp-member/src/evidence.test.ts docs/superpowers/evidence/dev-roundtrip.json
git diff --cached | rg "0x[0-9a-fA-F]{64}" && exit 1
git commit -m "$(cat <<'EOF'
[XMTP] 记录 dev 网络双成员收发证据

- Added: devRoundtrip 与 evidence
- Changed: 证据文件只含 group id 和核对结果
- Removed: 无
- Handoff: 私钥由 createUser 留在进程内存。Hub 查询的库必须有 messages 表

EOF
)"
```

`rg` 有匹配时提交必须中止。那表示证据里混进了私钥。

---

### Task 3: 浏览器路径和证据用同一个成员地址

**Files:**
- Modify: `frontend/src/pages/RoomPage.tsx`
- Modify: `docs/superpowers/plans/2026-09-23-xmtp-two-member.md`（只勾选本任务）

Node 脚本证明的是两个 agent-sdk 客户端。页面还要能把同一个公开地址加进群。

- [x] **Step 1: 把成员进程地址写进本机环境**

从一次 `createUser()` 打印出的公开地址，写入本机 `frontend/.env.local` 的 `VITE_XMTP_WORKER_ADDRESS`。不要提交 `.env.local`。地址是 42 个字符的 `0x` 开头，不是 66 个字符的私钥。

- [x] **Step 2: 打开加密房间并发送探针**

启动前端。进入一个新建的 `transport=xmtp` 房间。确认请求 `POST /api/v1/rooms/{id}/xmtp-binding` 的正文只有 `xmtp_group_id`。在输入框发送 `member-send-dev-ping`。

预期：输入框在发送成功后清空。发送者页面看得到这句。成员进程看得到这句并回复。Hub 的 `messages` 表计数仍是 0。

把这次浏览器使用的 group id 追加到证据文件的 `browser_group_id` 字段。它和 Node 脚本的 `group_id` 可以不同，因为那是两次独立建群。两个字段都要非空。

- [x] **Step 3: Commit**

```bash
git add docs/superpowers/evidence/dev-roundtrip.json docs/superpowers/plans/2026-09-23-xmtp-two-member.md
git diff --cached | rg "0x[0-9a-fA-F]{64}" && exit 1
git commit -m "$(cat <<'EOF'
[XMTP] 补上浏览器建群的 group id

- Changed: 证据同时包含 Node 对发和浏览器建群的 group id
- Handoff: 仍未合并 main，仍未迁移生产库

EOF
)"
```

---

## 计划自检

- 空群：Task 1 禁止 `createGroup([])` 之后直接绑定。
- 双成员网络证据：Task 2 写入 `docs/superpowers/evidence/dev-roundtrip.json`。
- 浏览器使用同一个公开地址：Task 3。
- 没有 `messages` 表时不准记录 Hub 计数为 0。
- 不重做 `sendText` 接线，不合并 `main`。
