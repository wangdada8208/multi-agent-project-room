import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { AccountStore } from "./accounts.ts";
import { approveConsent, type ConsentActionDeps } from "./consentActions.ts";
import { ConsentQueue } from "./consentQueue.ts";
import { hashPayload } from "./grant.ts";
import type { InboxEntry } from "./inbox.ts";
import type { LedgerEntry } from "./ledger.ts";
import { normalizePolicy } from "./policy.ts";
import {
  checkTriggerCreation,
  renderTriggerParams,
  TriggerEngine,
  TriggerStore,
  validateAndCheckTrigger,
  validateTriggerConfig,
  type TriggerConfig,
} from "./triggers.ts";
import type { Connector } from "./connectors/types.ts";

const A_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SELF = privateKeyToAccount(A_KEY).address.toLowerCase();
const NOW = new Date("2026-11-20T12:00:00Z");

const BASE_CONFIG: TriggerConfig = {
  id: "invoice-watch",
  enabled: true,
  account_id: "work-mail",
  query: "label:invoice",
  action: "gmail.send",
  action_params_template: {
    to: ["owner@x.com"],
    subject: "新事件 {{external_event_id}}",
    body: "触发器 {{trigger_id}} 命中",
  },
  max_per_hour: 5,
  poll_interval_ms: 60_000,
};

async function setup(input?: {
  rules?: unknown;
  msgsByAccount?: Record<string, { messages?: { id: string }[]; historyId?: string }>;
  historyByAccount?: Record<string, { history: any[]; historyId: string }>;
  fetchStatus?: number;
  fetchError?: Error;
  connectors?: Connector[];
  credMode?: number;
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trig-"));
  const credDir = path.join(dir, "credentials");
  await mkdir(credDir, { recursive: true });
  const accounts = new AccountStore(path.join(dir, "accounts.json"));
  await accounts.load();
  await accounts.add({ id: "work-mail", service: "gmail", label: "工作邮箱", cred_path: "work.json" });
  await accounts.add({ id: "personal", service: "gmail", label: "私人邮箱", cred_path: "personal.json" });
  for (const [file, token] of [
    ["work.json", "tok-work"],
    ["personal.json", "tok-personal"],
  ] as const) {
    await writeFile(path.join(credDir, file), JSON.stringify({ access_token: token }));
    await chmod(path.join(credDir, file), input?.credMode ?? 0o600);
  }

  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const triggers = new TriggerStore(path.join(dir, "triggers.json"));
  const ledger: LedgerEntry[] = [];
  const inbox: InboxEntry[] = [];
  const calls: { url: string; auth?: string }[] = [];
  const executions: { action: string; params: Record<string, unknown> }[] = [];

  const fetchImpl = (async (url: any, init?: any) => {
    const u = String(url);
    const auth = init?.headers?.Authorization;
    calls.push({ url: u, auth });
    const account = auth === "Bearer tok-personal" ? "personal" : "work-mail";
    if (input?.fetchError) throw input.fetchError;
    const status = input?.fetchStatus ?? 200;
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    if (u.includes("/history?")) {
      const h = input?.historyByAccount?.[account] ?? { history: [], historyId: "H-next" };
      return { ok: true, status: 200, json: async () => h };
    }
    if (/\/messages\/[^/?]+\?format=metadata/.test(u)) {
      const id = decodeURIComponent(u.match(/\/messages\/([^/?]+)/)![1]);
      return { ok: true, status: 200, json: async () => ({ id, historyId: `hist-${id}` }) };
    }
    if (u.includes("/messages?")) {
      const m = input?.msgsByAccount?.[account] ?? { messages: [] };
      return { ok: true, status: 200, json: async () => m };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;

  const connectors =
    input?.connectors ??
    [
      {
        id: "work-send",
        scopes: ["gmail.send"],
        accountId: "work-mail",
        fetch: async () => ({}),
        execute: async (action: string, params: Record<string, unknown>) => {
          executions.push({ action, params });
          return { status: "executed" as const, external_id: "sent-1", summary: "sent" };
        },
      },
    ];

  const appendLedger = async (e: LedgerEntry) => {
    ledger.push(e);
  };
  const actionDeps: ConsentActionDeps = {
    selfAddress: SELF,
    privateKey: A_KEY,
    queue,
    connectors,
    send: async () => {
      throw new Error("trigger must never send");
    },
    appendLedger,
    now: () => NOW,
  };

  const engine = new TriggerEngine({
    store: triggers,
    accounts,
    credDir,
    selfAddress: SELF,
    policy: normalizePolicy({ allow: {}, rules: input?.rules ?? {} }),
    queue,
    appendLedger,
    approve: (id) => approveConsent(id, actionDeps),
    appendInbox: async (entry) => {
      inbox.push(entry);
      return true;
    },
    fetchImpl,
    now: () => NOW,
  });

  return { dir, credDir, accounts, queue, triggers, ledger, inbox, calls, executions, engine };
}

// ── 配置校验 ────────────────────────────────────────────────────

test("validateTriggerConfig rejects malformed configs and accepts a valid one", () => {
  assert.equal(validateTriggerConfig(null).ok, false);
  for (const [patch, want] of [
    [{ id: "bad id" }, "invalid_id"],
    [{ id: "" }, "invalid_id"],
    [{ enabled: "yes" }, "invalid_enabled"],
    [{ account_id: "../x" }, "invalid_account_id"],
    [{ query: "a\nb" }, "invalid_query"],
    [{ query: "x".repeat(201) }, "invalid_query"],
    [{ action: 42 }, "invalid_action"],
    [{ action_params_template: null }, "invalid_template"],
    [{ action_params_template: { to: "x".repeat(9000) } }, "invalid_template"],
    [{ max_per_hour: 0 }, "invalid_max_per_hour"],
    [{ max_per_hour: 1001 }, "invalid_max_per_hour"],
    [{ poll_interval_ms: 1000 }, "invalid_poll_interval"],
  ] as const) {
    const res = validateTriggerConfig({ ...BASE_CONFIG, ...patch });
    assert.equal(res.ok, false, JSON.stringify(patch));
    if (!res.ok) assert.equal(res.reason, want, JSON.stringify(patch));
  }
  const ok = validateTriggerConfig({ ...BASE_CONFIG, action: " GMAIL.SEND " });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.config.action, "gmail.send");
});

test("checkTriggerCreation: hard-deny scopes, unknown account, invalid template all rejected", async () => {
  const s = await setup();
  const accounts = s.accounts;
  // 硬禁区（payment.*）与 cannot 规则都过不了 decide
  for (const scope of ["payment.send", "data.export_all", "credentials.read"]) {
    const res = checkTriggerCreation(
      { ...BASE_CONFIG, action: scope },
      { accounts, policy: normalizePolicy({}), selfAddress: SELF }
    );
    assert.equal(res.ok, false, scope);
    assert.match((res as any).reason, /^cannot:hard_cannot/);
  }
  const noAccount = checkTriggerCreation(
    { ...BASE_CONFIG, account_id: "ghost" },
    { accounts }
  );
  assert.equal(noAccount.ok, false);
  assert.equal((noAccount as any).reason, "unknown_account");
  const badTemplate = checkTriggerCreation(
    { ...BASE_CONFIG, action_params_template: { to: ["x"], subject: "s" } },
    { accounts }
  );
  assert.equal(badTemplate.ok, false);
  assert.match((badTemplate as any).reason, /^invalid_template:/);
  const good = validateAndCheckTrigger(BASE_CONFIG, { accounts });
  assert.equal(good.ok, true);
});

test("renderTriggerParams substitutes slots and force-binds params.account", () => {
  const params = renderTriggerParams(
    {
      ...BASE_CONFIG,
      action_params_template: {
        to: ["owner@x.com"],
        subject: "{{external_event_id}}",
        body: "{{trigger_id}}/{{account_id}}",
        account: "attacker-other-account",
      },
    },
    "msg-9"
  );
  assert.equal(params.subject, "msg-9");
  assert.equal(params.body, "invoice-watch/work-mail");
  // 模板里写的别的账户被强制覆盖回触发器自己的 account_id
  assert.equal(params.account, "work-mail");
});

test("TriggerStore persists 0600 and round-trips state; corrupt file refuses to load", async () => {
  const s = await setup();
  await s.triggers.add(BASE_CONFIG);
  const st = await stat(path.join(s.dir, "triggers.json"));
  assert.equal(st.mode & 0o777, 0o600);
  const again = new TriggerStore(path.join(s.dir, "triggers.json"));
  await again.load();
  assert.equal(again.get("invoice-watch")?.account_id, "work-mail");
  await again.setEnabled("invoice-watch", false);
  assert.equal(again.get("invoice-watch")?.enabled, false);
  assert.equal(again.anyEnabled(), false);
  assert.equal(await again.add(BASE_CONFIG), "duplicate");
  await writeFile(path.join(s.dir, "triggers.json"), "{broken");
  await assert.rejects(
    new TriggerStore(path.join(s.dir, "triggers.json")).load(),
    /corrupt/
  );
});

// ── 轮询 → decide → 队列 ─────────────────────────────────────────

test("messages.list poll enqueues an ask-tier trigger candidate that stays pending", async () => {
  const s = await setup({
    msgsByAccount: { "work-mail": { messages: [{ id: "m1" }, { id: "m2" }] } },
  });
  await s.triggers.add(BASE_CONFIG);
  // 模拟首轮基线已完成——本轮直接处理候选（L6 基线行为见专项测试）
  await s.triggers.updateState("invoice-watch", { last_poll_at: NOW.toISOString() });
  const summary = await s.engine.pollDue();
  assert.equal(summary.candidates, 2);
  assert.equal(summary.enqueued, 2);
  assert.equal(summary.autoApproved, 0);
  const item = s.queue.get("trig-invoice-watch-m1")!;
  assert.equal(item.status, "pending");
  assert.equal(item.source, "trigger");
  assert.equal(item.requester, SELF);
  assert.equal(item.conversation_id, "");
  assert.equal(item.account_id, "work-mail");
  assert.deepEqual(item.params?.account, "work-mail");
  assert.equal(item.params?.subject, "新事件 m1");
  assert.equal(item.params_hash, hashPayload(item.params));
  assert.equal(item.rule_hit, "house:*=ask");
  // 历史游标从 messages.get 取回，state 已落盘
  const t = s.triggers.get("invoice-watch")!;
  assert.equal(t.last_history_id, "hist-m1");
  assert.equal(t.seen_ids.length, 2);
  assert.equal(t.consecutive_failures, 0);
  assert.equal(s.ledger.filter((e) => e.kind === "action_queued").length, 2);
});

test("L6: first poll of a new trigger seeds a baseline — pre-existing mail never fires", async () => {
  const s = await setup({
    msgsByAccount: { "work-mail": { messages: [{ id: "old-1" }, { id: "old-2" }] } },
    historyByAccount: {
      "work-mail": {
        history: [{ messagesAdded: [{ message: { id: "new-1" } }] }],
        historyId: "H-new",
      },
    },
  });
  await s.triggers.add(BASE_CONFIG);
  // 首轮：只建基线——历史邮件标已见、游标落位，不进审批队列
  const first = await s.engine.pollDue();
  assert.equal(first.polled, 1);
  assert.equal(first.candidates, 0);
  assert.equal(first.enqueued, 0);
  assert.equal(first.denied, 0);
  assert.equal(s.queue.list().length, 0);
  const st = s.triggers.get("invoice-watch")!;
  assert.ok(st.last_poll_at);
  assert.equal(st.last_history_id, "hist-old-1");
  assert.deepEqual(new Set(st.seen_ids), new Set(["work-mail:old-1", "work-mail:old-2"]));
  assert.equal(s.ledger.filter((e) => e.kind === "action_queued").length, 0);
  // 第二轮：history.list 增量——只有基线之后的新邮件进审批
  await s.triggers.updateState("invoice-watch", { next_poll_at: undefined });
  const second = await s.engine.pollDue();
  assert.equal(second.enqueued, 1);
  assert.equal(s.queue.get("trig-invoice-watch-new-1")?.status, "pending");
  // 第三轮完全重复 → 0 候选
  await s.triggers.updateState("invoice-watch", { next_poll_at: undefined });
  const third = await s.engine.pollDue();
  assert.equal(third.candidates, 0);
  assert.equal(s.queue.list().length, 1);
});

test("L6: a trigger with a seeded last_history_id cursor skips baseline and goes incremental", async () => {
  const s = await setup({
    historyByAccount: {
      "work-mail": {
        history: [{ messagesAdded: [{ message: { id: "m9" } }] }],
        historyId: "H-9",
      },
    },
  });
  await s.triggers.add(BASE_CONFIG);
  // 有游标但没轮过（如状态注入）→ 不走 messages.list 基线，直接增量处理
  await s.triggers.updateState("invoice-watch", { last_history_id: "H-1" });
  const summary = await s.engine.pollDue();
  assert.equal(summary.enqueued, 1);
  assert.ok(s.calls.some((c) => c.url.includes("/history?startHistoryId=H-1")));
  assert.equal(s.calls.some((c) => c.url.includes("/messages?")), false);
});

test("dedup: repeated polls over the same ids enqueue nothing new", async () => {
  const s = await setup({
    msgsByAccount: { "work-mail": { messages: [{ id: "m1" }] } },
    historyByAccount: {
      "work-mail": {
        history: [{ messagesAdded: [{ message: { id: "m1" } }, { message: { id: "m2" } }] }],
        historyId: "H2",
      },
    },
  });
  await s.triggers.add(BASE_CONFIG);
  await s.triggers.updateState("invoice-watch", { last_poll_at: NOW.toISOString() }); // 跳过首轮基线
  await s.engine.pollDue();
  assert.equal(s.queue.list().length, 1);
  // 第二轮：next_poll_at 尚未到 → 0 轮询；把它清空再轮 → history.list 增量
  await s.triggers.updateState("invoice-watch", { next_poll_at: undefined });
  const second = await s.engine.pollDue();
  assert.equal(second.candidates, 1); // 只有 m2 是新事件；m1 被 (account_id,id) 去重
  assert.equal(second.enqueued, 1);
  assert.equal(s.queue.list().length, 2);
  // 第三轮完全重复 → 0 候选
  await s.triggers.updateState("invoice-watch", { next_poll_at: undefined });
  const third = await s.engine.pollDue();
  assert.equal(third.candidates, 0);
  assert.equal(s.queue.list().length, 2);
});

test("rate limit caps enqueues per hour; remainder is retried in the next window", async () => {
  const s = await setup({
    msgsByAccount: {
      "work-mail": { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] },
    },
  });
  await s.triggers.add({ ...BASE_CONFIG, max_per_hour: 1 });
  await s.triggers.updateState("invoice-watch", { last_poll_at: NOW.toISOString() }); // 跳过首轮基线
  const first = await s.engine.pollDue();
  assert.equal(first.enqueued, 1);
  assert.equal(first.rateLimited, 1);
  // 限频截断时 history 游标不推进、未处理事件不标已见——下个窗口还能回来
  const st = s.triggers.get("invoice-watch")!;
  assert.equal(st.window_count, 1);
  assert.equal(st.seen_ids.length, 1);
  // 新窗口（时间前进 1h）→ 再入队 1 条，仍剩 1 条等下下个窗口
  const t2 = new Date(NOW.getTime() + 3_700_000);
  (s.engine as any).now = () => t2;
  const second = await s.engine.pollDue();
  assert.equal(second.enqueued, 1);
  assert.equal(s.queue.list().length, 2);
  const t3 = new Date(NOW.getTime() + 7_300_000);
  (s.engine as any).now = () => t3;
  const third = await s.engine.pollDue();
  assert.equal(third.enqueued, 1);
  assert.equal(s.queue.list().length, 3);
});

test("poll failure backs off exponentially and skips until next_poll_at", async () => {
  const s = await setup({ fetchError: new Error("socket hangup") });
  await s.triggers.add(BASE_CONFIG);
  const first = await s.engine.pollDue();
  assert.equal(first.failures, 1);
  let st = s.triggers.get("invoice-watch")!;
  assert.equal(st.consecutive_failures, 1);
  assert.equal(Date.parse(st.next_poll_at!), NOW.getTime() + 60_000);
  assert.ok(s.ledger.some((e) => e.kind === "send_failed" && /trigger_poll_failed/.test(e.reason ?? "")));
  // next_poll_at 未到 → 本轮直接跳过
  const second = await s.engine.pollDue();
  assert.equal(second.polled, 0);
  // 连续失败 → 退避翻倍
  await s.triggers.updateState("invoice-watch", { next_poll_at: undefined });
  await s.engine.pollDue();
  st = s.triggers.get("invoice-watch")!;
  assert.equal(st.consecutive_failures, 2);
  assert.equal(Date.parse(st.next_poll_at!), NOW.getTime() + 120_000);
});

test("history.list path: incremental ids enqueue; 404 falls back to messages.list", async () => {
  const s = await setup({
    historyByAccount: {
      "work-mail": {
        history: [{ messagesAdded: [{ message: { id: "m9" } }, { message: { id: "m10" } }] }],
        historyId: "H-10",
      },
    },
  });
  await s.triggers.add(BASE_CONFIG);
  await s.triggers.updateState("invoice-watch", { last_history_id: "H-1", seen_ids: [] });
  const summary = await s.engine.pollDue();
  assert.equal(summary.enqueued, 2);
  assert.equal(s.triggers.get("invoice-watch")!.last_history_id, "H-10");
  assert.ok(s.calls.some((c) => c.url.includes("/history?startHistoryId=H-1")));

  // 404：游标过期 → 记失败 + 清游标，下一轮退回 messages.list
  const s404 = await setup({ fetchStatus: 404 });
  await s404.triggers.add(BASE_CONFIG);
  await s404.triggers.updateState("invoice-watch", { last_history_id: "H-stale" });
  const r = await s404.engine.pollDue();
  assert.equal(r.failures, 1);
  assert.equal(s404.triggers.get("invoice-watch")!.last_history_id, undefined);
});

test("cannot decision denies the candidate at poll time and marks it seen", async () => {
  const s = await setup({
    rules: { house: { "gmail.send": "cannot" } },
    msgsByAccount: { "work-mail": { messages: [{ id: "m1" }] } },
  });
  await s.triggers.add(BASE_CONFIG);
  await s.triggers.updateState("invoice-watch", { last_poll_at: NOW.toISOString() }); // 跳过首轮基线
  const summary = await s.engine.pollDue();
  assert.equal(summary.denied, 1);
  assert.equal(s.queue.list().length, 0);
  assert.equal(s.triggers.get("invoice-watch")!.seen_ids.length, 1);
  const denied = s.ledger.find((e) => e.kind === "request_denied");
  assert.match(denied?.reason ?? "", /^trigger:house:gmail\.send=cannot/);
});

test("allow decision runs the full approve path once — no XMTP send, inbox + ledger land", async () => {
  const s = await setup({
    rules: { actors: { [SELF]: { "gmail.send": "allow" } } },
    msgsByAccount: { "work-mail": { messages: [{ id: "m1" }] } },
  });
  await s.triggers.add(BASE_CONFIG);
  await s.triggers.updateState("invoice-watch", { last_poll_at: NOW.toISOString() }); // 跳过首轮基线
  const summary = await s.engine.pollDue();
  assert.equal(summary.enqueued, 1);
  assert.equal(summary.autoApproved, 1);
  assert.equal(s.executions.length, 1);
  assert.equal(s.executions[0].params.account, "work-mail");
  const item = s.queue.get("trig-invoice-watch-m1")!;
  assert.equal(item.status, "completed");
  assert.equal(item.result_receipt, "sent-1");
  assert.equal(s.inbox.length, 1);
  const inboxPayload = s.inbox[0].payload;
  assert.ok("kind" in inboxPayload && inboxPayload.kind === "action_result");
  assert.ok("status" in inboxPayload && inboxPayload.status === "executed");
  assert.ok(s.ledger.some((e) => e.kind === "auto_approved"));
  assert.ok(s.ledger.some((e) => e.kind === "action_finished"));
});

test("invalid template at poll time denies and marks seen (does not loop)", async () => {
  const s = await setup({
    msgsByAccount: { "work-mail": { messages: [{ id: "m1" }] } },
  });
  // 直接绕过创建校验塞一个坏模板
  await s.triggers.add({
    ...BASE_CONFIG,
    action_params_template: { to: ["owner@x.com"], subject: "s" },
  });
  await s.triggers.updateState("invoice-watch", { last_poll_at: NOW.toISOString() }); // 跳过首轮基线
  const summary = await s.engine.pollDue();
  assert.equal(summary.denied, 1);
  assert.equal(s.queue.list().length, 0);
  assert.equal(s.triggers.get("invoice-watch")!.seen_ids.length, 1);
  const denied = s.ledger.find((e) => e.kind === "request_denied");
  assert.match(denied?.reason ?? "", /^trigger_invalid_template:body_empty/);
});

test("disabled trigger and future next_poll_at are skipped by pollDue", async () => {
  const s = await setup({
    msgsByAccount: { "work-mail": { messages: [{ id: "m1" }] } },
  });
  await s.triggers.add({ ...BASE_CONFIG, enabled: false });
  await s.triggers.add({ ...BASE_CONFIG, id: "t2", poll_interval_ms: 60_000 });
  await s.triggers.updateState("t2", { next_poll_at: new Date(NOW.getTime() + 999_000).toISOString() });
  const summary = await s.engine.pollDue();
  assert.equal(summary.polled, 0);
});

test("engine start/stop: only starts when an enabled trigger exists; refresh reflects toggles", async () => {
  const s = await setup();
  s.engine.start();
  assert.equal((s.engine as any).timer, null); // 无启用触发器 → 不起表
  await s.triggers.add(BASE_CONFIG);
  s.engine.refresh();
  assert.notEqual((s.engine as any).timer, null);
  await s.triggers.setEnabled("invoice-watch", false);
  s.engine.refresh();
  assert.equal((s.engine as any).timer, null);
  await s.triggers.setEnabled("invoice-watch", true);
  s.engine.refresh();
  assert.notEqual((s.engine as any).timer, null);
  s.engine.stop();
  assert.equal((s.engine as any).timer, null);
});

test("hard-forbidden action never reaches the queue even if smuggled into the store", async () => {
  const s = await setup({
    msgsByAccount: { "work-mail": { messages: [{ id: "m1" }] } },
  });
  // 手改 store 文件塞入硬禁区动作——即使绕过 POST 校验，轮询仍被 decide() 拦下。
  await s.triggers.add(BASE_CONFIG);
  const file = path.join(s.dir, "triggers.json");
  const raw = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(file, "utf8")));
  raw[0].action = "payment.send";
  raw[0].last_poll_at = NOW.toISOString(); // 跳过首轮基线，直接到 decide()
  await writeFile(file, JSON.stringify(raw));
  const store2 = new TriggerStore(file);
  await store2.load();
  const engine2 = new TriggerEngine({
    store: store2,
    accounts: s.accounts,
    credDir: s.credDir,
    selfAddress: SELF,
    policy: normalizePolicy({}),
    queue: s.queue,
    appendLedger: async (e) => {
      s.ledger.push(e);
    },
    approve: async () => ({ ok: false, reason: "never" }),
    fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: "m1" }] }) })) as any,
    now: () => NOW,
  });
  const summary = await engine2.pollDue();
  assert.equal(summary.denied, 1);
  assert.equal(s.queue.list().length, 0);
  assert.ok(s.ledger.some((e) => e.kind === "request_denied" && /hard_cannot/.test(e.reason ?? "")));
});
