# 收尾：主人能看见记录，并把本地提交推上去 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主人在自己的页面上能看到每轮结果。做完后把本分支全部本地提交推到远端功能分支。到此没有下一份编码计划。

**Architecture:** 成员进程在 `127.0.0.1` 上提供只读的主人记录。页面只显示 `turns_seen`、`action`、`block_reason`。记录文件仍在已忽略的 `.state` 目录。Hub 继续不保存加密房间正文。

**Tech Stack:** 现有 `workers/xmtp-member`、React、Node 22 测试。不新增 Python 依赖。

**已经做完，不要重做：**

- `d62a556` 到 `316d0a9` 的 XMTP 收发。
- `a9831f6` 到 `0eb4522` 的历史明文房间删除，以及 `9d2fb5b` 的默认加密通道。
- `3fd6258` 到 `bbd4f08` 的本地轮次。
- `f97c330` 到 `81bdaf5` 的模型回复和出站过滤。
- `d3dac45` 到 `f237bb1` 的主人记录。这些提交加上前面的真实回复提交，目前比 `origin/cursor/member-local-loop-0591` 超前 9 个，还没推送。

**做完这份之后仍然留给人类，不要擅自做：**

- 不合并 `main`。
- 不连接、不修改生产库，不在生产库执行 `e8f2b1c93a40`。
- 不把 `frontend/.env.local`、`.state/`、私钥或模型密钥提交进 git。
- 不移植 Python 的 `PrivateReportService` 和双向共识。
- 不把占位句换成必须付费的真实模型联调。没密钥时继续发占位句。

从本计划 Task 1 开始。

---

### Task 1: 只从本机读出主人记录

**Files:**
- Create: `workers/xmtp-member/src/ownerNotesHttp.ts`
- Create: `workers/xmtp-member/src/ownerNotesHttp.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { handleOwnerNotes } from "./ownerNotesHttp.ts";

test("returns saved notes for loopback and nothing else", async () => {
  const response = await handleOwnerNotes({
    host: "127.0.0.1",
    notes: [
      { self_name: "Codex", turns_seen: 2, action: "blocked", block_reason: "unapproved_day" },
    ],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.notes, [
    { self_name: "Codex", turns_seen: 2, action: "blocked", block_reason: "unapproved_day" },
  ]);
});

test("refuses a non-loopback host", async () => {
  const response = await handleOwnerNotes({
    host: "10.0.0.8",
    notes: [
      { self_name: "Codex", turns_seen: 1, action: "sent", block_reason: null },
    ],
  });
  assert.equal(response.status, 403);
  assert.deepEqual(response.body.notes, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/ownerNotesHttp.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Write minimal implementation**

`handleOwnerNotes` 在 `host` 不是 `127.0.0.1` 且不是 `localhost` 时返回 403 和空列表。否则返回 200 和传入的 notes。不要接受正文、密钥字段。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/ownerNotesHttp.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/ownerNotesHttp.ts workers/xmtp-member/src/ownerNotesHttp.test.ts
git commit -m "$(cat <<'EOF'
[XMTP] 主人记录只允许本机读取

- Added: handleOwnerNotes
- Handoff: 还没有监听端口，页面也还看不到

EOF
)"
```

---

### Task 2: 成员进程只监听 127.0.0.1

**Files:**
- Modify: `workers/xmtp-member/src/index.ts`
- Modify: `workers/xmtp-member/src/ownerNotesHttp.ts`
- Modify: `workers/xmtp-member/.env.example`

- [ ] **Step 1: Write the failing test**

在 `ownerNotesHttp.test.ts` 追加：

```ts
test("bind address is loopback only", () => {
  assert.equal(ownerNotesBindAddress(), "127.0.0.1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/ownerNotesHttp.test.ts`

Expected: FAIL，函数不存在。

- [ ] **Step 3: Write minimal implementation**

导出 `ownerNotesBindAddress()`，固定返回 `127.0.0.1`。`index.ts` 在 `startMember` 里用 `node:http` 监听这个地址和 `process.env.OWNER_NOTES_PORT || "8787"`。`GET /owner-notes` 读取 `owner-notes.jsonl`，每行解析成 `OwnerNote` 后交给 `handleOwnerNotes`。不要把入站正文写进响应。`.env.example` 增加 `OWNER_NOTES_PORT=`，值留空。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/*.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/index.ts workers/xmtp-member/src/ownerNotesHttp.ts workers/xmtp-member/src/ownerNotesHttp.test.ts workers/xmtp-member/.env.example
git commit -m "$(cat <<'EOF'
[XMTP] 在本机端口提供主人记录

- Added: GET /owner-notes
- Handoff: 只绑定 127.0.0.1。页面尚未读取

EOF
)"
```

---

### Task 3: 房间页只显示轮次结果

**Files:**
- Create: `frontend/src/lib/ownerNotes.ts`
- Create: `frontend/src/lib/ownerNotes.test.ts`
- Modify: `frontend/src/pages/RoomPage.tsx`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { visibleOwnerNotes } from "./ownerNotes";

describe("visibleOwnerNotes", () => {
  it("keeps only the four allowed fields", () => {
    const notes = visibleOwnerNotes([
      {
        self_name: "Codex",
        turns_seen: 2,
        action: "blocked",
        block_reason: "unapproved_day",
        inbound: "不能出现",
      },
    ]);
    expect(notes).toEqual([
      {
        self_name: "Codex",
        turns_seen: 2,
        action: "blocked",
        block_reason: "unapproved_day",
      },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/ownerNotes.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Write minimal implementation**

`visibleOwnerNotes` 只复制那四个字段。`RoomPage` 在加密房间向 `http://127.0.0.1:8787/owner-notes` 读取。失败时显示「本机成员进程未启动」，不要显示报错正文。列表里用中文显示动作：`sent` 为「已发送」，`blocked` 为「未发送」，`silent` 为「未轮到」。不要渲染任何额外字段。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/ownerNotes.ts frontend/src/lib/ownerNotes.test.ts frontend/src/pages/RoomPage.tsx
git commit -m "$(cat <<'EOF'
[前端] 加密房间显示本机轮次结果

- Added: visibleOwnerNotes
- Handoff: 只读 127.0.0.1:8787。成员进程没开时页面给出固定提示

EOF
)"
```

---

### Task 4: 推送本分支，使远端和本地提交一致

**Files:**
- 无新文件。只推送 `cursor/member-local-loop-0591`。

- [ ] **Step 1: 确认没有密钥和本地环境文件**

Run: `git status --short`

Expected: 只有 `frontend/.env.local` 未跟踪。不要 `git add` 它。不要添加 `.state/` 或任何数据库文件。

- [ ] **Step 2: 推送功能分支**

```bash
git push -u origin HEAD
```

Expected: `origin/cursor/member-local-loop-0591` 和本地 `HEAD` 的提交哈希相同。

不要执行 `git push origin HEAD:main`。不要合并 `main`。

- [ ] **Step 3: 核对**

```bash
git rev-parse HEAD
git rev-parse origin/cursor/member-local-loop-0591
git merge-base --is-ancestor HEAD main; echo "merged:$?"
```

Expected: 前两行哈希相同。`merged:` 为 `1`。

---

## 计划自检

- 主人在页面上看见轮次结果，看不见聊天正文：Task 1 到 Task 3。
- 远端功能分支等于本地提交：Task 4。
- `main` 和生产库保持不动。
- 做完后没有下一份成员进程编码计划。
