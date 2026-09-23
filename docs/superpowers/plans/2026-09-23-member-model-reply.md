# 成员端真实回复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 成员进程在决定该回复时调用模型，发出去的正文先经过出站过滤。没轮到时不调用模型。正文、密钥和轮次文件都不进 Hub。

**Architecture:** `ingest` 继续只决定回不回，并仍给出占位句。`onInboundText` 在占位句非空时改走 `composeReply`。模型由调用方注入。出站过滤在 `sendText` 之前执行，未批准的星期或私密词被拦住时不发送。没有模型配置时仍发送原来的占位句。

**Tech Stack:** 现有 `workers/xmtp-member`、Node 22、`node --experimental-strip-types --test`。不新增 Python 依赖。不把模型 SDK 装进 FastAPI。

**现状：**

- 分支 `cursor/member-local-loop-0591` 已完成 `docs/superpowers/plans/2026-09-23-member-local-loop.md`。`main` 仍是 `9d2fb5b`。
- `workers/xmtp-member/src/localLoop.ts` 的 `ingest` 在该回复时返回 `收到，本轮由 <selfName> 处理。`
- `workers/xmtp-member/src/onInboundText.ts` 直接把这句交给 `sendText`。
- `backend/app/collab/calendar_negotiation.py` 的 `CalendarOutboundFilter` 仍在 Python 里。本计划只把「私密词打码」和「未批准星期不发出」移到成员进程。不移植 `PrivateReportService`，也不移植双向共识。

**不要做：**

- 不重做本地轮次、XMTP 收发、历史明文房间删除。
- 不改 `decideReply` 的三条规则。
- 不把入站正文、模型回复、轮次状态、API 密钥写入 Hub、日志、异常文本或 git。
- 不合并 `main`，不连接、不修改生产库。
- 不在本计划里做主人私有审计报告。

从本计划 Task 1 开始。

---

### Task 1: 该回复时才调用注入的模型

**Files:**
- Create: `workers/xmtp-member/src/composeReply.ts`
- Create: `workers/xmtp-member/src/composeReply.test.ts`
- Modify: `workers/xmtp-member/src/onInboundText.ts`
- Modify: `workers/xmtp-member/src/onInboundText.test.ts`

- [x] **Step 1: Write the failing test**

`workers/xmtp-member/src/composeReply.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { composeReply } from "./composeReply.ts";

test("silent turn does not call the model", async () => {
  let calls = 0;
  const outbound = await composeReply({
    shouldReply: false,
    selfName: "Codex",
    inbound: "继续讨论",
    complete: async () => {
      calls += 1;
      return "模型回复";
    },
  });
  assert.equal(outbound, null);
  assert.equal(calls, 0);
});

test("reply turn uses the model text", async () => {
  const outbound = await composeReply({
    shouldReply: true,
    selfName: "Codex",
    inbound: "@Codex 看一下接口",
    complete: async (prompt) => {
      assert.equal(prompt.includes("@Codex 看一下接口"), true);
      assert.equal(prompt.includes("Codex"), true);
      return "接口可以保持现有路径。";
    },
  });
  assert.equal(outbound, "接口可以保持现有路径。");
});

test("empty model text falls back to the placeholder", async () => {
  const outbound = await composeReply({
    shouldReply: true,
    selfName: "Codex",
    inbound: "@Codex 在吗",
    complete: async () => "   ",
  });
  assert.equal(outbound, "收到，本轮由 Codex 处理。");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/composeReply.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: Write minimal implementation**

```ts
export async function composeReply(input: {
  shouldReply: boolean;
  selfName: string;
  inbound: string;
  complete?: (prompt: string) => Promise<string>;
}): Promise<string | null> {
  if (!input.shouldReply) return null;
  const fallback = `收到，本轮由 ${input.selfName} 处理。`;
  if (!input.complete) return fallback;
  const prompt = [
    `你是 ${input.selfName}。`,
    "只根据下面这句话回复。不要声称已经访问 Hub 或数据库。",
    input.inbound,
  ].join("\n");
  const text = (await input.complete(prompt)).trim();
  return text.length > 0 ? text : fallback;
}
```

把 `onInboundText` 改成：`ingest` 的 `outbound === null` 时不调用 `composeReply`。否则 `shouldReply: true`，把 `composeReply` 的返回值交给 `sendText`。`onInboundText` 增加可选参数 `complete`。现有测试不传 `complete`，因此发出去的仍是占位句，这两个测试必须继续通过。

- [x] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/composeReply.test.ts src/onInboundText.test.ts src/localLoop.test.ts`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/composeReply.ts workers/xmtp-member/src/composeReply.test.ts workers/xmtp-member/src/onInboundText.ts workers/xmtp-member/src/onInboundText.test.ts
git commit -m "$(cat <<'EOF'
[XMTP] 该回复时才调用注入的模型

- Added: composeReply
- Changed: 没有 complete 时仍发送占位句
- Handoff: 还没有真实 HTTP 模型，也还没有出站过滤

EOF
)"
```

---

### Task 2: 发出前过滤私密词和未批准星期

**Files:**
- Create: `workers/xmtp-member/src/outboundFilter.ts`
- Create: `workers/xmtp-member/src/outboundFilter.test.ts`

对照 `backend/app/collab/calendar_negotiation.py` 的 `filter_message` 与 `detect_unapproved_proposal`。只移植这两件事。

- [x] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { filterOutbound } from "./outboundFilter.ts";

test("redacts a private keyword and allows an approved day", () => {
  const result = filterOutbound({
    content: "周三 14:00 可以，地点在秘密会议室",
    approvedDays: ["wed"],
    sensitiveKeywords: ["秘密会议室"],
  });
  assert.equal(result.blocked, false);
  assert.equal(result.text.includes("秘密会议室"), false);
  assert.equal(result.text.includes("[REDACTED]"), true);
});

test("blocks an unapproved weekday", () => {
  const result = filterOutbound({
    content: "周五下午可以",
    approvedDays: ["wed"],
    sensitiveKeywords: [],
  });
  assert.equal(result.blocked, true);
  assert.equal(result.text, null);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/outboundFilter.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: Write minimal implementation**

`approvedDays` 使用三个字母的英文星期代码，和 Python 里 `day_of_week.lower()[:3]` 的比较方式相同。正文里出现 `monday` 到 `sunday` 或 `周一` 到 `周日` 时，映射到 `mon` 至 `sun`。映射后的代码不在 `approvedDays` 里，则 `blocked: true` 且 `text: null`。否则把每个长度大于 1 的 `sensitiveKeywords` 替换成 `[REDACTED]`，大小写不敏感。

- [x] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/outboundFilter.test.ts`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/outboundFilter.ts workers/xmtp-member/src/outboundFilter.test.ts
git commit -m "$(cat <<'EOF'
[XMTP] 成员端过滤未批准星期和私密词

- Added: filterOutbound
- Handoff: 尚未接到 sendText

EOF
)"
```

---

### Task 3: 发送路径先过滤，被拦住时不发

**Files:**
- Modify: `workers/xmtp-member/src/onInboundText.ts`
- Modify: `workers/xmtp-member/src/onInboundText.test.ts`

- [x] **Step 1: Write the failing test**

在 `onInboundText.test.ts` 追加：

```ts
test("blocked outbound is not sent", async () => {
  const sent: string[] = [];
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
  });
  assert.deepEqual(sent, []);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/onInboundText.test.ts`

Expected: FAIL，周五这句仍被发送。

- [x] **Step 3: Write minimal implementation**

`composeReply` 得到文本后调用 `filterOutbound`。`blocked === true` 时不调用 `sendText`。过滤后的文本仍要保存轮次状态，状态里继续不能出现入站正文。未传 `approvedDays` 时不要把占位句误拦，占位句不含星期。

- [x] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/*.test.ts`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/onInboundText.ts workers/xmtp-member/src/onInboundText.test.ts
git commit -m "$(cat <<'EOF'
[XMTP] 未批准的出站回复不发送

- Changed: onInboundText 在 sendText 前调用 filterOutbound
- Handoff: 模型仍由测试注入

EOF
)"
```

---

### Task 4: 用环境变量接一个 HTTP 模型，密钥不进状态文件

**Files:**
- Create: `workers/xmtp-member/src/modelComplete.ts`
- Create: `workers/xmtp-member/src/modelComplete.test.ts`
- Modify: `workers/xmtp-member/src/index.ts`

没有 `MEMBER_MODEL_API_KEY` 时，`index.ts` 不传 `complete`，行为保持占位句。有密钥时才发 HTTP。

- [x] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { completeWithFetch } from "./modelComplete.ts";

test("posts the prompt and returns the text field", async () => {
  const seen: { authorization?: string; body?: string } = {};
  const text = await completeWithFetch({
    apiKey: "sk-test",
    url: "https://model.example/complete",
    prompt: "只回复一句",
    fetchImpl: async (url, init) => {
      seen.authorization = (init?.headers as Record<string, string>).Authorization;
      seen.body = String(init?.body);
      assert.equal(url, "https://model.example/complete");
      return new Response(JSON.stringify({ text: "保持现有路径。" }), { status: 200 });
    },
  });
  assert.equal(text, "保持现有路径。");
  assert.equal(seen.authorization, "Bearer sk-test");
  assert.equal(seen.body?.includes("sk-test"), false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/modelComplete.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: Write minimal implementation**

请求体只含 `{ "prompt": prompt }`。响应只读取 JSON 的 `text` 字符串。非 200 或没有 `text` 时抛错，错误信息只含状态码，不含密钥和正文。`index.ts` 在 `process.env.MEMBER_MODEL_API_KEY` 和 `MEMBER_MODEL_URL` 都存在时，把 `completeWithFetch` 传给 `onInboundText`。`XMTP_APPROVED_DAYS` 用逗号分隔，传给 `approvedDays`。`XMTP_SENSITIVE_KEYWORDS` 用逗号分隔，传给 `sensitiveKeywords`。这两个变量都不要写入 `saveLoopState` 的文件。

在 `workers/xmtp-member/.env.example` 追加这四个变量名，值留空。

- [x] **Step 4: Run test to verify it passes**

Run: `cd workers/xmtp-member && node --experimental-strip-types --test src/*.test.ts`

Expected: PASS

- [x] **Step 5: Commit**

```bash
git add workers/xmtp-member/src/modelComplete.ts workers/xmtp-member/src/modelComplete.test.ts workers/xmtp-member/src/index.ts workers/xmtp-member/.env.example
git diff --cached | rg "sk-test|0x[0-9a-fA-F]{64}" && exit 1
git commit -m "$(cat <<'EOF'
[XMTP] 成员进程可按环境变量调用模型

- Added: completeWithFetch
- Changed: 未配置密钥时继续发送占位句
- Handoff: 密钥只留在本机环境。PrivateReportService 不在本计划

EOF
)"
```

`rg` 有匹配时提交必须中止。

---

### Task 5: 入口改指向本计划

**Files:**
- Modify: `CLAUDE.md`
- Modify: `PLAN.md`
- Modify: `ROADMAP.md`

- [x] **Step 1: 改三份入口**

写明四条事实：

1. 成员端本地轮次已经完成，不要从 `2026-09-23-member-local-loop.md` 的 Task 1 重做。
2. 当前工作是本计划：该回复时调用模型，出站过滤留在成员进程。
3. 没配置模型密钥时仍发送占位句。
4. 不合并 `main`，不清理生产库，不移植主人私有审计报告。

- [x] **Step 2: Commit**

```bash
git add CLAUDE.md PLAN.md ROADMAP.md docs/superpowers/plans/2026-09-23-member-model-reply.md
git commit -m "$(cat <<'EOF'
[文档] 当前入口改为成员端真实回复

- Changed: 入口指向 member-model-reply 计划
- Handoff: 生产库仍未清理

EOF
)"
```

---

## 计划自检

- 没轮到不调用模型：Task 1 的第一个测试。
- 未批准星期不发送：Task 3。
- 密钥不出现在请求体和轮次文件：Task 4。
- 没有密钥时占位句仍在：Task 1 对现有 `onInboundText` 测试的要求。
- 私有审计报告不在本计划。
