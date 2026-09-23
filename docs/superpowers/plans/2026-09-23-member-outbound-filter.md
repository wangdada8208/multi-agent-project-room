# 成员端出站过滤与私有汇报 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 成员进程在调用 `sendText` 之前，用与 `CalendarOutboundFilter` 相同的规则涂掉私密词，并拦住未批准的星期。被拦住时不发送。私有汇报只写本机文件，不进 Hub。

**Architecture:** 纯函数放在 `workers/xmtp-member`。`onInboundText` 先走已经存在的 `ingest`。`ingest` 决定不回复时，行为与现在相同。决定回复时，先对待发送文本做过滤；未批准的星期把轮次状态改成 `suspended`，不调用 `sendText`，并写一份不含正文的私有汇报。Python 的 `CalendarOutboundFilter`、`PrivateReportService` 和 `MessageLoop` 保留，本计划不搬迁、不删除它们。

**Tech Stack:** 现有 `workers/xmtp-member`（Node 22、`node --experimental-strip-types --test`）。不新增 npm 依赖。

**现状（动手前核对）：**

- `main` 已包含成员端本地轮次，顶端包含 `bbd4f08`。`ingest` 的回复固定为 `收到，本轮由 <selfName> 处理。`
- 星期检测和私密词涂改的现有实现在 `backend/app/collab/calendar_negotiation.py` 的 `CalendarOutboundFilter`。对照测试在 `backend/tests/test_calendar_negotiation.py`。
- `loadLoopState` 目前只接受 `status === "active"`。
- 生产库用户 hub 房间的清理已获人类批准，但没有生产库连接，本计划不执行。

**不要做：**

- 不重做 `d62a556` 到 `316d0a9` 的 XMTP 收发，不重做 `2026-09-23-member-local-loop.md` 的 Task 1 到 Task 5。
- 不改 `decideReply` 的三条规则。不改 `buildBindingPayload`。
- 不调用真实模型，不把模型 SDK 加进 `package.json`。
- 不把待发送正文、入站正文、涂改前的原文、私有汇报 POST 回 Hub，也不写进日志或异常信息。
- 不连接、不修改生产库。不合并 `main`。
- 不把钱包私钥、`XMTP_DB_ENCRYPTION_KEY`、访问令牌、真实日程标题写入 git。

从本计划 Task 1 开始。

---

### Task 1: 涂掉私密词，并认出未批准的星期

**Files:**
- Create: `workers/xmtp-member/src/outboundPolicy.ts`
- Create: `workers/xmtp-member/src/outboundPolicy.test.ts`

规则与 `CalendarOutboundFilter.filter_message`、`detect_unapproved_proposal` 对齐。Node 侧不要去调用 Python。

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { detectUnapprovedDay, redactKeywords } from "./outboundPolicy.ts";

test("redacts private keywords and keeps the approved slot text", () => {
  const raw =
    "I can meet on Wednesday 14:00-16:00 after my Doctor Appointment with Dr. Smith near Room 302 Medical Center.";
  const filtered = redactKeywords(raw, [
    "Doctor Appointment with Dr. Smith",
    "Room 302 Medical Center",
  ]);
  assert.equal(filtered.includes("Doctor Appointment with Dr. Smith"), false);
  assert.equal(filtered.includes("Room 302 Medical Center"), false);
  assert.equal(filtered.includes("[REDACTED]"), true);
  assert.equal(filtered.includes("Wednesday 14:00-16:00"), true);
});

test("ignores keywords of one character or empty", () => {
  assert.equal(redactKeywords("周三见", ["", "三"]), "周三见");
});

test("detects an unapproved weekday and allows an approved one", () => {
  const approved = ["Wednesday"];
  assert.equal(detectUnapprovedDay("How about Wednesday 14:00?", approved), null);
  assert.equal(detectUnapprovedDay("周三下午两点合适吗？", approved), null);
  assert.equal(detectUnapprovedDay("Can we reschedule to Thursday 10:00?", approved), "thursday");
  assert.equal(detectUnapprovedDay("我们改到周四上午碰头吧", approved), "周四");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/outboundPolicy.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Write minimal implementation**

`redactKeywords`：对每个长度大于 1 的词做大小写不敏感替换，换成 `[REDACTED]`。先替换更长的词，避免短词先把长词拆开。

`detectUnapprovedDay` 使用这张表，键出现在文本里（英文先转小写）就算命中：

```ts
const weekdays: Record<string, string> = {
  monday: "mon",
  tuesday: "tue",
  wednesday: "wed",
  thursday: "thu",
  friday: "fri",
  saturday: "sat",
  sunday: "sun",
  周一: "mon",
  周二: "tue",
  周三: "wed",
  周四: "thu",
  周五: "fri",
  周六: "sat",
  周日: "sun",
};
```

已批准集合是 `approvedDays` 每一项 `toLowerCase().slice(0, 3)`。命中的码不在这个集合里时，返回表里的那个键（英文键返回小写英文，中文键返回原文）。都批准时返回 `null`。按上面对象的插入顺序检查，先命中先返回。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/outboundPolicy.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/outboundPolicy.ts workers/xmtp-member/src/outboundPolicy.test.ts
git commit -m "$(cat <<'EOF'
[XMTP] 成员端可涂掉私密词并认出未批准星期

- Added: redactKeywords 与 detectUnapprovedDay
- Changed: 无
- Removed: 无
- Handoff: 尚未接到 sendText

EOF
)"
```

---

### Task 2: 未批准的星期不准进入待发送文本

**Files:**
- Modify: `workers/xmtp-member/src/outboundPolicy.ts`
- Modify: `workers/xmtp-member/src/outboundPolicy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { prepareOutbound } from "./outboundPolicy.ts";

test("prepareOutbound redacts and still returns the text when the day is approved", () => {
  const result = prepareOutbound(
    "Wednesday plan after Doctor Appointment with Dr. Smith",
    {
      approvedDays: ["Wednesday"],
      sensitiveKeywords: ["Doctor Appointment with Dr. Smith"],
    },
  );
  assert.equal(result.status, "active");
  assert.equal(result.unapproved, null);
  assert.equal(result.outbound, "Wednesday plan after [REDACTED]");
});

test("prepareOutbound blocks an unapproved day and does not return the sentence", () => {
  const secret = "Thursday plan after Doctor Appointment with Dr. Smith";
  const result = prepareOutbound(secret, {
    approvedDays: ["Wednesday"],
    sensitiveKeywords: ["Doctor Appointment with Dr. Smith"],
  });
  assert.equal(result.status, "suspended");
  assert.equal(result.unapproved, "thursday");
  assert.equal(result.outbound, null);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("Doctor Appointment"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/outboundPolicy.test.ts`

Expected: FAIL，`prepareOutbound` 未导出。

- [ ] **Step 3: Write minimal implementation**

```ts
export interface OutboundPolicy {
  approvedDays: string[];
  sensitiveKeywords: string[];
}

export function prepareOutbound(content: string, policy: OutboundPolicy): {
  outbound: string | null;
  status: "active" | "suspended";
  unapproved: string | null;
} {
  const redacted = redactKeywords(content, policy.sensitiveKeywords);
  const unapproved = detectUnapprovedDay(redacted, policy.approvedDays);
  if (unapproved) {
    return { outbound: null, status: "suspended", unapproved };
  }
  return { outbound: redacted, status: "active", unapproved: null };
}
```

先涂改，再检测。这样私密词里碰巧含有星期名时，检测看不到那个词。拦住时返回值只有 `status` 和星期键，没有原句。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/outboundPolicy.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/outboundPolicy.ts workers/xmtp-member/src/outboundPolicy.test.ts
git commit -m "$(cat <<'EOF'
[XMTP] 未批准的星期不进入待发送文本

- Added: prepareOutbound
- Changed: 无
- Removed: 无
- Handoff: 拦住时的返回值不含原句

EOF
)"
```

---

### Task 3: 发送前过滤；拦住后轮次挂起且不发送

**Files:**
- Modify: `workers/xmtp-member/src/localLoop.ts`
- Modify: `workers/xmtp-member/src/onInboundText.ts`
- Modify: `workers/xmtp-member/src/onInboundText.test.ts`
- Modify: `workers/xmtp-member/src/index.ts`

`LocalLoopState.status` 从只允许 `"active"` 改为 `"active" | "suspended"`。`saveLoopState` / `loadLoopState` 按这个并集校验。其它四个字段的规则不变。`ingest` 继续推进 `turnIndex` 和 `turnsSeen`，并保留进入时的 `status`，不要在 `ingest` 里把 `suspended` 改回 `active`。

- [ ] **Step 1: Write the failing test**

在 `onInboundText.test.ts` 追加。现有两个测试不传 `policy`，必须仍然通过。

```ts
test("approved placeholder is sent and a leaking compose is redacted", async () => {
  const sent: string[] = [];
  await onInboundText({
    state: createLocalLoop({
      participants: ["Codex", "Claude"],
      selfName: "Codex",
    }),
    text: "@Codex 看一下",
    policy: {
      approvedDays: ["Wednesday"],
      sensitiveKeywords: ["Doctor Appointment with Dr. Smith"],
    },
    compose: () => "Wednesday slot after Doctor Appointment with Dr. Smith",
    sendText: async (body) => {
      sent.push(body);
    },
    saveState: async () => {},
  });
  assert.deepEqual(sent, ["Wednesday slot after [REDACTED]"]);
});

test("unapproved day does not send and suspends the saved state", async () => {
  const sent: string[] = [];
  let saved = "";
  const next = await onInboundText({
    state: createLocalLoop({
      participants: ["Codex", "Claude"],
      selfName: "Codex",
    }),
    text: "@Codex 看一下",
    policy: { approvedDays: ["Wednesday"], sensitiveKeywords: [] },
    compose: () => "请改到周四",
    sendText: async (body) => {
      sent.push(body);
    },
    saveState: async (state) => {
      saved = JSON.stringify(state);
    },
  });
  assert.deepEqual(sent, []);
  assert.equal(next.status, "suspended");
  assert.equal(saved.includes("周四"), false);
  assert.equal(saved.includes("请改到"), false);
});

test("suspended state does not send until the matching grant is supplied", async () => {
  const sent: string[] = [];
  const suspended = createLocalLoop({
    participants: ["Codex", "Claude"],
    selfName: "Codex",
  });
  suspended.status = "suspended";
  await onInboundText({
    state: suspended,
    text: "@Codex 继续",
    sendText: async (body) => {
      sent.push(body);
    },
    saveState: async () => {},
  });
  assert.deepEqual(sent, []);

  await onInboundText({
    state: suspended,
    text: "@Codex 继续",
    grantScope: "calendar:expand_slots",
    sendText: async (body) => {
      sent.push(body);
    },
    saveState: async () => {},
  });
  assert.deepEqual(sent, ["收到，本轮由 Codex 处理。"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/onInboundText.test.ts`

Expected: FAIL，参数或挂起分支尚不存在。

- [ ] **Step 3: Write minimal implementation**

`onInboundText` 增加可选字段 `policy?: OutboundPolicy`、`compose?: () => string`、`grantScope?: string | null`。

处理顺序：

1. `state.status === "suspended"` 且 `grantScope !== "calendar:expand_slots"`：不调用 `sendText`，不调用 `compose`，原样 `saveState`，返回原状态。
2. 若 `grantScope === "calendar:expand_slots"`，先把状态视为 `active` 再进入 `ingest`。
3. `ingest`。`outbound === null` 时不发送，保存 `ingest` 返回的状态。
4. 待发送文本优先用 `compose()`，没有 `compose` 就用 `ingest` 的占位句。
5. 没有 `policy` 时，待发送文本原样发给 `sendText`。有 `policy` 时先 `prepareOutbound`。`outbound === null` 时不发送，把保存状态的 `status` 设为 `suspended`。否则发送过滤后的文本，`status` 保持 `active`。

`index.ts` 从环境读取策略，传给 `onInboundText`，不传 `compose`。因此现有占位句仍是默认回复，但会经过过滤。

```ts
function loadOutboundPolicy(): OutboundPolicy {
  const days = (process.env.XMTP_APPROVED_DAYS || "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
  const keywords = (process.env.XMTP_SENSITIVE_KEYWORDS || "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
  return { approvedDays: days, sensitiveKeywords: keywords };
}
```

`XMTP_GRANT_SCOPE` 只在值恰好是 `calendar:expand_slots` 时作为 `grantScope` 传入，否则传 `null`。不要从文件或 Hub 读取正文。

`workers/xmtp-member/.env.example` 追加空值：

```text
XMTP_APPROVED_DAYS=
XMTP_SENSITIVE_KEYWORDS=
XMTP_GRANT_SCOPE=
```

`text` 事件的 `catch` 仍只打印 `err.message`。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && npm test`

Expected: PASS。已有的 `localLoop`、`turnPolicy`、`binding`、`evidence` 测试保持通过。

- [ ] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/localLoop.ts workers/xmtp-member/src/onInboundText.ts workers/xmtp-member/src/onInboundText.test.ts workers/xmtp-member/src/index.ts workers/xmtp-member/.env.example
git commit -m "$(cat <<'EOF'
[XMTP] 发送前过滤，未批准星期则挂起

- Changed: onInboundText 在 sendText 前调用 prepareOutbound
- Changed: 轮次状态可以是 suspended
- Handoff: 默认回复仍是占位句。没有 compose，也就没有模型

EOF
)"
```

提交前确认 `git diff --cached` 没有 `.env`、没有 `.state/`、没有 `0x` 加 64 位十六进制。

---

### Task 4: 私有汇报写在本机，文件里没有正文

**Files:**
- Create: `workers/xmtp-member/src/privateReport.ts`
- Create: `workers/xmtp-member/src/privateReport.test.ts`
- Modify: `workers/xmtp-member/src/onInboundText.ts`
- Modify: `workers/xmtp-member/src/onInboundText.test.ts`

汇报字段与 `PrivateConsensusReport.to_dict` 对齐，但不要写入聊天正文。

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { savePrivateReport } from "./privateReport.ts";

test("private report records the block without the message text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "report-"));
  const file = path.join(dir, "private-report.json");
  const secret = "请改到周四，并带上病历";
  await savePrivateReport(file, {
    ownerId: "local-owner",
    participants: ["Codex", "Claude"],
    approvedDays: ["Wednesday"],
    unapproved: "周四",
    roundsUsed: 2,
  });
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.consensus_status, "suspended");
  assert.equal(parsed.unresolved_items[0], "unapproved-day");
  assert.equal(parsed.rounds_used, 2);
  assert.deepEqual(parsed.approved_disclosures, [{ day_of_week: "Wednesday" }]);
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes("周四"), false);
  assert.equal(Object.hasOwn(parsed, "content"), false);
});
```

挂起分支再断言一次：`onInboundText` 在不发送时调用 `saveReport`，传入的对象序列化后不含入站文本，也不含 `compose` 原句。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/privateReport.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Write minimal implementation**

`savePrivateReport` 只写这些键：`owner_id`、`agreed_time_slot`（固定 `null`）、`agreed_participants`、`approved_disclosures`、`unresolved_items`、`rounds_used`、`consensus_status`。`consensus_status` 固定 `"suspended"`。`unresolved_items` 固定 `["unapproved-day"]`。`approved_disclosures` 是 `{ day_of_week }` 的数组。不要增加 `content`、`text`、`outbound`、`unapproved` 字段。未批准的星期键只存在于函数入参，不写入文件。

`onInboundText` 增加可选 `saveReport`。仅在 `prepareOutbound` 把状态变成 `suspended` 时调用。不要在正常发送时写汇报。`index.ts` 把汇报写到与轮次状态同一目录下的 `private-report.json`。该目录已由 `workers/xmtp-member/.state/` 的 gitignore 盖住。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && npm test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/privateReport.ts workers/xmtp-member/src/privateReport.test.ts workers/xmtp-member/src/onInboundText.ts workers/xmtp-member/src/onInboundText.test.ts workers/xmtp-member/src/index.ts
git commit -m "$(cat <<'EOF'
[XMTP] 私有汇报只留在成员本机

- Added: savePrivateReport
- Changed: 未批准星期被拦住时写汇报文件
- Handoff: 汇报不含正文，也不含被拦住的星期词

EOF
)"
```

---

### Task 5: 入口文档指向本计划

**Files:**
- Modify: `CLAUDE.md`
- Modify: `PLAN.md`
- Modify: `ROADMAP.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/superpowers/plans/2026-09-23-member-outbound-filter.md`（只勾选已完成步骤）

若这些入口在本计划提交时已经指向本文件，核对下面四条，符合就勾选，不要改措辞。

1. `2026-09-23-member-local-loop.md` 已完成并已进入 `main`。不要从那份计划的 Task 1 重做。
2. 当前工作是本计划：成员端出站过滤和本机私有汇报。
3. 不调用真实模型。不连接生产库。不合并 `main`。
4. 生产库用户 hub 房间的清理仍未执行，不属于本计划。

- [ ] **Step 1: 改入口并勾选本计划里已完成的任务**

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md PLAN.md ROADMAP.md ARCHITECTURE.md docs/superpowers/plans/2026-09-23-member-outbound-filter.md
git commit -m "$(cat <<'EOF'
[文档] 当前入口改为成员端出站过滤

- Changed: 入口文档指向 member-outbound-filter 计划
- Handoff: 生产库清理仍未执行，不在本计划内

EOF
)"
```

---

## 计划自检

- 私密词变成 `[REDACTED]`，已批准的星期文本保留：Task 1、Task 2。
- 未批准的星期不发送，轮次变为 `suspended`，返回值里没有原句：Task 2、Task 3。
- 挂起后，只有 `grantScope === "calendar:expand_slots"` 才恢复发送：Task 3。
- 私有汇报在本机，文件没有正文，也没有被拦住的星期词：Task 4。
- 默认路径仍不调用模型。Python 过滤器和 `MessageLoop` 仍在。
- 不合并 `main`，不碰生产库，密钥和真实日程标题不进 git。

## 交给其他 Agent 的原话

```text
仓库是 https://github.com/wangdada8208/multi-agent-project-room 。阅读并只执行 docs/superpowers/plans/2026-09-23-member-outbound-filter.md ，从 Task 1 做到 Task 5。每做完一个 Task 就按计划里的命令跑测试并提交。

不要重做 2026-09-23-member-local-loop.md。不要重做 d62a556 到 316d0a9 的 XMTP 收发。不要改 decideReply。不要调用真实模型，不要新增模型依赖。不要把聊天正文、涂改前的原文或私有汇报写进 Hub、日志或 git。不要合并 main。不要连接或修改生产库。生产库用户 hub 房间的清理已经另获批准，但那不是这份计划，没有生产库连接就不要自己找连接串。不要提交私钥、XMTP_DB_ENCRYPTION_KEY、访问令牌或真实日程标题。

Python 的 CalendarOutboundFilter、PrivateReportService 和 MessageLoop 保留。成员进程发送前用 prepareOutbound。未批准的星期不发送，并把轮次标成 suspended。私有汇报只写本机 .state 目录。
```
