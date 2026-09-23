# 成员端主人记录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 每一轮处理完后，成员进程只在本机给主人留一条结果记录。这条记录不进群聊，不进 Hub，也不进轮次状态文件。

**Architecture:** `onInboundText` 在发送或拦截之后调用 `buildOwnerNote`。记录只含轮次、动作和原因，不含入站正文、模型回复和密钥。文件写在已经忽略的 `workers/xmtp-member/.state/owner-notes.jsonl`。没有批准星期列表时，不再把所有星期都当成未批准。

**Tech Stack:** 现有 `workers/xmtp-member`、Node 22、`node --experimental-strip-types --test`。不改 FastAPI。

**现状：**

- 分支 `cursor/member-local-loop-0591` 上，`f97c330` 到 `81bdaf5` 已完成模型回复和出站过滤。这 5 个提交还没推到远端。`main` 仍是 `9d2fb5b`。
- `filterOutbound` 在 `approvedDays` 为空时，正文里任何一个星期都会 `blocked: true`。
- `saveLoopState` 只写参与者、名字和计数。
- `.gitignore` 已包含 `workers/xmtp-member/.state/`。
- Python 的 `PrivateReportService` 仍在 `backend/app/collab/calendar_negotiation.py`。本计划不移植那份完整审计报告，也不做双方共识。

**不要做：**

- 不重做本地轮次、真实回复、XMTP 收发、历史明文房间删除。
- 不把主人记录交给 `sendText`，不 POST 到 Hub，不写进 `loop.json`。
- 不合并 `main`，不连接、不修改生产库。
- 不把密钥、入站正文、模型回复写入主人记录。

从本计划 Task 1 开始。

---

### Task 1: 没配置批准星期时不要拦截星期

**Files:**
- Modify: `workers/xmtp-member/src/outboundFilter.ts`
- Modify: `workers/xmtp-member/src/outboundFilter.test.ts`

- [x] **Step 1: Write the failing test**

在 `outboundFilter.test.ts` 追加：

```ts
test("does not block weekdays when no allowlist is configured", () => {
  const result = filterOutbound({
    content: "周五下午可以",
    sensitiveKeywords: ["秘密会议室"],
  });
  assert.equal(result.blocked, false);
  assert.equal(result.text, "周五下午可以");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/outboundFilter.test.ts`

Expected: FAIL，当前 `blocked` 为 `true`。

- [x] **Step 3: Write minimal implementation**

`approvedDays` 为 `undefined` 时跳过星期检查，只做私密词替换。传入空数组 `[]` 时仍表示没有任何批准星期，正文里的星期继续拦截。已有的「周五 + approvedDays: ['wed']」测试必须继续拦截。

- [x] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/outboundFilter.test.ts src/onInboundText.test.ts`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/outboundFilter.ts workers/xmtp-member/src/outboundFilter.test.ts
git commit -m "$(cat <<'EOF'
[XMTP] 未配置批准星期时不拦截星期

- Changed: approvedDays 缺省只做私密词替换
- Handoff: 显式传入空数组时仍然拦截星期

EOF
)"
```

---

### Task 2: 生成不含正文的主人记录

**Files:**
- Create: `workers/xmtp-member/src/ownerNote.ts`
- Create: `workers/xmtp-member/src/ownerNote.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildOwnerNote } from "./ownerNote.ts";

test("sent note has no inbound or model text", () => {
  const note = buildOwnerNote({
    selfName: "Codex",
    turnsSeen: 2,
    action: "sent",
    inbound: "@Codex 约时间",
    modelText: "周三 14:00 可以",
  });
  const encoded = JSON.stringify(note);
  assert.equal(note.action, "sent");
  assert.equal(note.turns_seen, 2);
  assert.equal(note.self_name, "Codex");
  assert.equal(encoded.includes("约时间"), false);
  assert.equal(encoded.includes("14:00"), false);
});

test("blocked note records the reason only", () => {
  const note = buildOwnerNote({
    selfName: "Codex",
    turnsSeen: 3,
    action: "blocked",
    blockReason: "unapproved_day",
    inbound: "周五秘密会议室",
    modelText: "周五可以，秘密会议室见",
  });
  const encoded = JSON.stringify(note);
  assert.equal(note.action, "blocked");
  assert.equal(note.block_reason, "unapproved_day");
  assert.equal(encoded.includes("秘密会议室"), false);
  assert.equal(encoded.includes("周五"), false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/ownerNote.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: Write minimal implementation**

`buildOwnerNote` 的返回值只有 `self_name`、`turns_seen`、`action`、`block_reason`。`action` 为 `"sent"`、`"blocked"` 或 `"silent"`。`silent` 和 `sent` 的 `block_reason` 为 `null`。函数可以接收 `inbound` 和 `modelText`，但返回对象里不得出现这两个字段。

- [x] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/ownerNote.test.ts`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/ownerNote.ts workers/xmtp-member/src/ownerNote.test.ts
git commit -m "$(cat <<'EOF'
[XMTP] 主人记录只保留轮次和结果

- Added: buildOwnerNote
- Handoff: 记录还没有写入磁盘，也还没有接到发送路径

EOF
)"
```

---

### Task 3: 发送路径写主人记录，但不发到群里

**Files:**
- Modify: `workers/xmtp-member/src/onInboundText.ts`
- Modify: `workers/xmtp-member/src/onInboundText.test.ts`
- Modify: `workers/xmtp-member/src/index.ts`

- [x] **Step 1: Write the failing test**

在 `onInboundText.test.ts` 追加：

```ts
test("owner note is recorded and not sent to the room", async () => {
  const sent: string[] = [];
  const notes: string[] = [];
  await onInboundText({
    state: createLocalLoop({
      participants: ["Codex", "Claude"],
      selfName: "Codex",
    }),
    text: "@Codex 约时间",
    complete: async () => "周五下午可以",
    approvedDays: ["wed"],
    sensitiveKeywords: [],
    sendText: async (body) => {
      sent.push(body);
    },
    saveState: async () => {},
    recordOwner: async (note) => {
      notes.push(JSON.stringify(note));
    },
  });
  assert.deepEqual(sent, []);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].includes("blocked"), true);
  assert.equal(notes[0].includes("约时间"), false);
  assert.equal(notes[0].includes("周五"), false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/onInboundText.test.ts`

Expected: FAIL，`recordOwner` 未被调用。

- [x] **Step 3: Write minimal implementation**

`onInboundText` 增加可选参数 `recordOwner`。每一轮结束时都调用它：

- 没回复：`action: "silent"`
- 已 `sendText`：`action: "sent"`
- `filterOutbound` 拦截：`action: "blocked"`，`blockReason: "unapproved_day"`

`index.ts` 把记录追加到 `workers/xmtp-member/.state/owner-notes.jsonl`，每行一个 JSON。不要把入站正文传进文件。不要把这行 JSON 交给 `sendText` 或 Hub。

- [x] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/*.test.ts`

Expected: PASS。现有 18 项加上本计划新增的测试都通过。

- [x] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/onInboundText.ts workers/xmtp-member/src/onInboundText.test.ts workers/xmtp-member/src/index.ts
git commit -m "$(cat <<'EOF'
[XMTP] 每轮结果只记在主人本机

- Added: owner-notes.jsonl 追加写入
- Changed: 拦截或发送后都留下不含正文的记录
- Handoff: 该文件位于已忽略的 .state 目录

EOF
)"
```

---

### Task 4: 入口改指向本计划

**Files:**
- Modify: `CLAUDE.md`
- Modify: `PLAN.md`
- Modify: `ROADMAP.md`

- [x] **Step 1: 改三份入口**

写明四条事实：

1. 成员端真实回复已经完成，不要从 `2026-09-23-member-model-reply.md` 的 Task 1 重做。
2. 当前工作是本计划：主人记录只留在成员本机。
3. 没配置 `XMTP_APPROVED_DAYS` 时不拦截星期。显式空列表仍然拦截。
4. 不合并 `main`，不清理生产库，不把记录发进群或 Hub。

- [x] **Step 2: Commit**

```bash
git add CLAUDE.md PLAN.md ROADMAP.md docs/superpowers/plans/2026-09-23-member-owner-note.md
git commit -m "$(cat <<'EOF'
[文档] 当前入口改为主人本机记录

- Changed: 入口指向 member-owner-note 计划
- Handoff: 生产库仍未清理。这 5 个模型回复提交仍待推送

EOF
)"
```

---

## 计划自检

- 未配置批准星期不再误拦：Task 1。
- 主人记录不含入站正文和模型回复：Task 2。
- 记录不进群、不进 Hub、不进 `loop.json`：Task 3。
- 不重做 `f97c330` 到 `81bdaf5`。
