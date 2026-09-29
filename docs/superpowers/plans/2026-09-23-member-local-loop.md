# 成员端本地轮次 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加密房间的入站正文只在成员进程里决定回不回。轮次状态留在该进程本机，可恢复，且文件里没有正文。没被点名且没轮到时不发送。Hub 的 `messages` 不增加正文行。

**Architecture:** 纯函数 `ingest` 包住已经存在的 `decideReply`。`index.ts` 的 `text` 事件只调用这个函数，然后在需要时 `sendText` 占位回复，并把不含正文的状态写到本机文件。FastAPI 继续不加入 XMTP group，继续拒绝把 `transport=xmtp` 的正文写入 `messages.content`。Python 里的 `MessageLoop` 保留，它仍给现有测试和 `_agent_` 通道使用，本计划不搬迁它。

**Tech Stack:** 现有 `workers/xmtp-member`（Node 22、`node --experimental-strip-types --test`）、已安装的 `@xmtp/agent-sdk@2.3.0`、FastAPI / pytest。

**现状（动手前核对，不要凭本文改写历史）：**

- 基线是 `main` 的 `9d2fb5b`。用户房间只能 `transport=xmtp`。本地用户可见的 hub 房间已删除。`_agent_` 通道保留。
- `workers/xmtp-member/src/turnPolicy.ts` 的 `decideReply` 和它的三个测试已经存在。不要重写这套规则。
- `workers/xmtp-member/src/index.ts` 把 `turnIndex` 放在进程内存里，每来一条文本都加 1，回复固定为 `收到，本轮由 <selfName> 处理。`
- Hub 拒绝落库、搜索返回 `body_not_on_hub`、浏览器 `sendText`、dev 网络双成员证据都已经在仓库里。证据文件是 `docs/superpowers/evidence/dev-roundtrip.json`。

**不要做：**

- 不重做 `d62a556` 到 `316d0a9` 的 XMTP 收发，也不重做 `a9831f6` 到 `0eb4522` 的历史明文房间删除。
- 不改 `decideReply` 的三条规则，不改 `buildBindingPayload` 的字段。
- 不调用真实模型，不把 `CalendarOutboundFilter` 或 `PrivateReportService` 移植到 Node。那是本计划验收通过之后的下一份计划。
- 不把轮次状态、入站正文、占位回复 POST 回 Hub，不把它们写进日志或异常信息。
- 不合并 `main`，不连接、不修改生产库。
- 不把钱包私钥、`XMTP_DB_ENCRYPTION_KEY`、访问令牌写入 git。

从本计划 Task 1 开始。

---

### Task 1: 用纯函数覆盖「点名才回、轮到才回」

**Files:**
- Create: `workers/xmtp-member/src/localLoop.ts`
- Create: `workers/xmtp-member/src/localLoop.test.ts`

`decideReply` 已经决定回不回。缺的是一个不碰网络的状态转移：同一份状态连续吃进两条文本，只有点名或轮到自己时产出待发送正文。

- [x] **Step 1: Write the failing test**

在 `workers/xmtp-member/src/localLoop.test.ts` 写入：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createLocalLoop, ingest } from "./localLoop.ts";

test("two inbound messages reply only when mentioned or on turn", () => {
  let state = createLocalLoop({
    participants: ["Codex", "Claude"],
    selfName: "Codex",
  });

  const mentioned = ingest(state, "@Codex 看一下接口");
  assert.equal(mentioned.reason, "mentioned");
  assert.equal(mentioned.outbound, "收到，本轮由 Codex 处理。");
  assert.equal(mentioned.state.turnIndex, 1);
  assert.equal(JSON.stringify(mentioned.state).includes("看一下接口"), false);

  const silent = ingest(mentioned.state, "继续讨论");
  assert.equal(silent.reason, "not_this_turn");
  assert.equal(silent.outbound, null);
  assert.equal(silent.state.turnIndex, 2);
  assert.equal(JSON.stringify(silent.state).includes("继续讨论"), false);
});

test("unmentioned message on own turn produces the placeholder", () => {
  const state = createLocalLoop({
    participants: ["Codex", "Claude"],
    selfName: "Claude",
    turnIndex: 1,
  });
  const result = ingest(state, "继续讨论");
  assert.equal(result.reason, "turn");
  assert.equal(result.outbound, "收到，本轮由 Claude 处理。");
  assert.equal(result.state.turnIndex, 2);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/localLoop.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: Write minimal implementation**

`workers/xmtp-member/src/localLoop.ts`：

```ts
import { decideReply } from "./turnPolicy.ts";

export interface LocalLoopState {
  participants: string[];
  selfName: string;
  turnIndex: number;
  turnsSeen: number;
  status: "active";
}

export function createLocalLoop(input: {
  participants: string[];
  selfName: string;
  turnIndex?: number;
}): LocalLoopState {
  return {
    participants: input.participants,
    selfName: input.selfName,
    turnIndex: input.turnIndex ?? 0,
    turnsSeen: 0,
    status: "active",
  };
}

export function ingest(state: LocalLoopState, text: string): {
  state: LocalLoopState;
  outbound: string | null;
  reason: "mentioned" | "turn" | "not_this_turn";
} {
  const decision = decideReply({
    text,
    selfName: state.selfName,
    participants: state.participants,
    turnIndex: state.turnIndex,
  });
  const next: LocalLoopState = {
    participants: state.participants,
    selfName: state.selfName,
    turnIndex: state.turnIndex + 1,
    turnsSeen: state.turnsSeen + 1,
    status: "active",
  };
  return {
    state: next,
    reason: decision.reason,
    outbound: decision.reply ? `收到，本轮由 ${state.selfName} 处理。` : null,
  };
}
```

每收到一条文本，`turnIndex` 和 `turnsSeen` 都加 1，包括决定不回复的那条。这样同一个进程按接收顺序推进。本计划不在两个进程之间同步这份计数，也不把计数发给 Hub。

`outbound` 只能是上面的占位句或 `null`。不要把 `text` 拼进占位句，不要把 `text` 放进返回的 `state`。

- [x] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/localLoop.test.ts`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/localLoop.ts workers/xmtp-member/src/localLoop.test.ts
git commit -m "$(cat <<'EOF'
[XMTP] 成员端用纯函数推进本地轮次

- Added: ingest，点名或轮到才产出占位回复
- Changed: 无
- Removed: 无
- Handoff: 状态还在内存里。index.ts 尚未改接

EOF
)"
```

---

### Task 2: 轮次状态写入本机文件，文件里没有正文

**Files:**
- Modify: `workers/xmtp-member/src/localLoop.ts`
- Modify: `workers/xmtp-member/src/localLoop.test.ts`
- Modify: `.gitignore`

进程重启后要能恢复「下一轮轮到谁」。恢复文件只保存计数字段。

- [x] **Step 1: Write the failing test**

在 `localLoop.test.ts` 追加：

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveLoopState, loadLoopState } from "./localLoop.ts";

test("saved loop state restores counters and omits message text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loop-"));
  const file = path.join(dir, "loop.json");
  const secret = "这句不能进状态文件";
  const state = ingest(
    createLocalLoop({ participants: ["Codex", "Claude"], selfName: "Codex" }),
    secret,
  ).state;

  await saveLoopState(file, state);
  const raw = await readFile(file, "utf8");
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes("content"), false);

  const restored = await loadLoopState(file);
  assert.deepEqual(restored, state);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/localLoop.test.ts`

Expected: FAIL，`saveLoopState` 未导出。

- [x] **Step 3: Write minimal implementation**

`saveLoopState(file, state)` 只序列化 `LocalLoopState` 的五个字段，先 `mkdir` 父目录，再写文件。`loadLoopState(file)` 读回并校验这五个字段的类型；文件不存在时抛出带路径的错误，错误文本里不要带消息正文。

不要接受调用方传入的正文参数。如果将来有人把多余字段塞进对象，写入前只挑这五个字段，多余字段丢弃。

`.gitignore` 增加一行：

```text
workers/xmtp-member/.state/
```

默认路径约定写在 `index.ts` 里，本任务先不改 `index.ts`。环境变量名定为 `XMTP_LOOP_STATE_PATH`。未设置时使用 `workers/xmtp-member/.state/loop.json`。这个默认路径必须被上面的 gitignore 盖住。

- [x] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/localLoop.test.ts`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/localLoop.ts workers/xmtp-member/src/localLoop.test.ts .gitignore
git commit -m "$(cat <<'EOF'
[XMTP] 本地轮次状态可恢复且不含正文

- Added: saveLoopState 与 loadLoopState
- Changed: .gitignore 盖住 workers/xmtp-member/.state
- Removed: 无
- Handoff: 状态文件只含 participants、selfName、turnIndex、turnsSeen、status

EOF
)"
```

提交前确认 `git diff --cached` 里没有 `.state/loop.json`，也没有 `0x` 加 64 位十六进制。

---

### Task 3: text 事件只走 ingest，不把正文交给 Hub

**Files:**
- Create: `workers/xmtp-member/src/onInboundText.ts`
- Create: `workers/xmtp-member/src/onInboundText.test.ts`
- Modify: `workers/xmtp-member/src/index.ts`

现在 `index.ts` 自己持有 `turnIndex` 并直接调用 `decideReply`。改成调用 Task 1 和 Task 2。

- [x] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createLocalLoop } from "./localLoop.ts";
import { onInboundText } from "./onInboundText.ts";

test("mentioned text is sent once and the saved state has no body", async () => {
  const sent: string[] = [];
  const saved: string[] = [];
  const inbound = "@Codex 看一下接口";
  await onInboundText({
    state: createLocalLoop({
      participants: ["Codex", "Claude"],
      selfName: "Codex",
    }),
    text: inbound,
    sendText: async (body) => {
      sent.push(body);
    },
    saveState: async (state) => {
      saved.push(JSON.stringify(state));
    },
  });
  assert.deepEqual(sent, ["收到，本轮由 Codex 处理。"]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].includes(inbound), false);
  assert.equal(sent[0].includes("看一下接口"), false);
});

test("silent turn does not send and still saves the advanced counter", async () => {
  const sent: string[] = [];
  let turnIndex = -1;
  await onInboundText({
    state: createLocalLoop({
      participants: ["Codex", "Claude"],
      selfName: "Codex",
      turnIndex: 1,
    }),
    text: "继续讨论",
    sendText: async (body) => {
      sent.push(body);
    },
    saveState: async (state) => {
      turnIndex = state.turnIndex;
    },
  });
  assert.deepEqual(sent, []);
  assert.equal(turnIndex, 2);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/onInboundText.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: Write minimal implementation**

`onInboundText` 调用 `ingest`。`outbound` 为 `null` 时不调用 `sendText`。有占位句时只把该句传给 `sendText`。两种情况都调用 `saveState(nextState)`。这个函数不接收 Hub 地址、令牌或 `fetch`。

`index.ts` 的 `agent.on("text", ...)` 改成：

1. 启动时若 `XMTP_LOOP_STATE_PATH`（或默认 `.state/loop.json`）存在，则 `loadLoopState`；不存在就 `createLocalLoop`，参与者与名字仍来自现有的 `XMTP_PARTICIPANTS` 和 `XMTP_SELF_NAME`。
2. 从 `ctx` 取出文本的方式保持现在的两行：`ctx.message.content` 是字符串就用它，否则用 `ctx.message.content.text`，再没有就用空字符串。
3. 调用 `onInboundText`。`sendText` 仍优先 `ctx.sendText`，否则 `ctx.conversation.sendText`。
4. 删除这个回调里的局部变量 `turnIndex` 和对 `decideReply` 的直接调用。
5. 不要 `console.log` 入站文本。现有的 `console.error("Worker process error:", err.message)` 可以保留。新增的 `catch` 同样只打印 `err.message`。

建群和 `bindGroupToHub` 的现有代码保持不动。绑定请求体仍然只有 group id。

- [x] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && npm test`

Expected: PASS。`turnPolicy`、`binding`、`evidence`、`localLoop`、`onInboundText` 都通过。

- [x] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/onInboundText.ts workers/xmtp-member/src/onInboundText.test.ts workers/xmtp-member/src/index.ts
git commit -m "$(cat <<'EOF'
[XMTP] 入站文本只在成员进程里决定回复

- Added: onInboundText
- Changed: index.ts 不再自己保存 turnIndex
- Removed: 无
- Handoff: 占位回复未改。没有把正文交给 Hub

EOF
)"
```

---

### Task 4: 确认 Hub 仍然拒绝加密房间正文

**Files:**
- Modify: `backend/tests/test_xmtp_room_storage.py`（只在缺少断言时追加；已有测试就不要改产品代码）

成员进程改完后，Hub 侧的拒绝必须仍然有效。不要为了让成员进程「汇报轮次」而打开落库。

- [x] **Step 1: 先跑已有测试**

Run: `cd backend && ../.venv/bin/python -m pytest tests/test_xmtp_room_storage.py -q`

Expected: PASS。其中已包含 `test_xmtp_room_rejects_message_body`、`test_ws_persist_skips_xmtp_body`、`test_search_xmtp_room_has_no_body`、`test_create_room_rejects_hub_transport`。

若虚拟环境不在 `../.venv`，改用仓库里已经能跑 pytest 的那个解释器，不要新装一套无关依赖。

- [x] **Step 2: 测试失败时的处理**

失败原因是断言过期：只改断言，让它符合「xmtp 房间正文不能进 `messages`」。

失败原因是产品代码把正文写进去了：停止，把失败命令和断言交给人类。不要放宽 `PlaintextStorageForbidden`，不要给绑定接口加正文或轮次字段。

本任务不新增 Hub 端点。

- [x] **Step 3: Commit**

只有测试文件真有改动才提交。

```bash
git add backend/tests/test_xmtp_room_storage.py
git commit -m "$(cat <<'EOF'
[房间] 复核加密房间仍然拒绝正文落库

- Changed: 补上与当前拒绝行为一致的断言
- Handoff: 未改 Hub 的写入规则

EOF
)"
```

没有改动就不要做空提交。

---

### Task 5: 入口文档指向本计划

**Files:**
- Modify: `CLAUDE.md`
- Modify: `PLAN.md`
- Modify: `ROADMAP.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/xmtp端到端加密-执行文档.md`
- Modify: `docs/superpowers/plans/2026-09-23-member-local-loop.md`（只勾选已完成步骤）

本计划第一次提交时，这些入口已经改过。核对句子是否符合下面四条，符合就勾选，不要再改措辞。

写进去的事实只有这四条：

1. 加密房间的收发和本地历史明文房间删除已经完成。不要从 `2026-09-23-delete-legacy-rooms.md` 或 `2026-09-23-xmtp-two-member.md` 的 Task 1 重做。
2. 当前工作是本计划：成员进程本地轮次，正文不进 Hub。
3. `_agent_` 内部通道保留。生产库未清理。不合并 `main`。
4. `MessageLoop` 仍在 Hub 源码里，服务于现有测试和 `_agent_` 通道。加密房间的回不回复以成员进程的 `ingest` 为准。

删掉仍写着「旧明文房间在迁移完成前继续可用」和「加密房间的正文还不会进入 XMTP」的句子。

- [x] **Step 1: 改入口并勾选本计划里已完成的任务**

- [x] **Step 2: Commit**

```bash
git add CLAUDE.md PLAN.md ROADMAP.md ARCHITECTURE.md docs/xmtp端到端加密-执行文档.md docs/superpowers/plans/2026-09-23-member-local-loop.md
git commit -m "$(cat <<'EOF'
[文档] 当前入口改为成员端本地轮次

- Changed: 入口文档指向 member-local-loop 计划
- Handoff: 生产库仍未清理。真实模型和日历过滤不在本计划

EOF
)"
```

---

## 计划自检

- 两条入站文本，一条点名，一条不点名：Task 1 的第一个测试。只有点名或轮到的那次 `outbound` 非空。
- 轮次状态在本机、重启可恢复、文件无正文：Task 2。
- 发送路径不把正文交给 Hub：Task 3 的 `onInboundText` 没有 Hub 客户端。Task 4 复核 Hub 拒绝落库。
- 占位回复保持 `收到，本轮由 <selfName> 处理。`
- 不重做收发和明文删除，不合并 `main`，不碰生产库，密钥不进 git。

## 交给其他 Agent 的原话

把下面这段原样发给执行者：

```text
仓库是 https://github.com/wangdada8208/multi-agent-project-room 。阅读并只执行 docs/superpowers/plans/2026-09-23-member-local-loop.md ，从 Task 1 做到 Task 5。每做完一个 Task 就按计划里的命令跑测试并提交。

不要从 CLAUDE.md 的旧入口重做「删除历史明文房间」。不要重做 d62a556 到 316d0a9 的 XMTP 收发。不要改 decideReply 的规则。不要调用真实模型，不要移植 CalendarOutboundFilter 或 PrivateReportService。不要把聊天正文、占位回复或轮次状态写进 Hub、日志或 git。不要合并 main，不要连接或修改生产库，不要提交私钥、XMTP_DB_ENCRYPTION_KEY 或访问令牌。

Python 的 MessageLoop 保留。加密房间回不回复以成员进程的 ingest 为准。Hub 对 transport=xmtp 仍必须拒绝把正文写入 messages。测试失败若是因为产品代码把正文写进了 Hub，停下来交给人类，不要放宽校验。
```
