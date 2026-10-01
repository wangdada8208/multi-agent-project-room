import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkRequest, loadPolicy, normalizePolicy } from "./policy.ts";

const PEER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const policy = normalizePolicy({
  allow: { [PEER.toUpperCase().replace("0X", "0x")]: ["calendar.free_busy"] },
  max_range_days: 7,
});
const week = { date_from: "2026-10-05", date_to: "2026-10-09" };

test("an allowed peer asking an allowed scope inside the limit passes", () => {
  assert.deepEqual(checkRequest(policy, PEER, { scope: "calendar.free_busy", constraints: week }), { ok: true });
});

test("a follow-up for attendees is out of scope", () => {
  assert.deepEqual(
    checkRequest(policy, PEER, { scope: "calendar.attendees", constraints: week }),
    { ok: false, reason: "out_of_scope" }
  );
});

test("an unknown peer is out of scope", () => {
  assert.deepEqual(
    checkRequest(policy, "0x1111111111111111111111111111111111111111", { scope: "calendar.free_busy", constraints: week }),
    { ok: false, reason: "out_of_scope" }
  );
});

test("a range longer than max_range_days or reversed is out of scope", () => {
  assert.equal(
    checkRequest(policy, PEER, { scope: "calendar.free_busy", constraints: { date_from: "2026-10-01", date_to: "2026-10-30" } }).ok,
    false
  );
  assert.equal(
    checkRequest(policy, PEER, { scope: "calendar.free_busy", constraints: { date_from: "2026-10-09", date_to: "2026-10-05" } }).ok,
    false
  );
});

test("missing policy file means nobody may ask anything", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "policy-"));
  const loaded = await loadPolicy(path.join(dir, "policy.json"));
  assert.deepEqual(loaded.allow, {});
  const file = path.join(dir, "policy2.json");
  await writeFile(file, JSON.stringify({ allow: { [PEER]: ["calendar.free_busy"] }, max_range_days: 99 }));
  const loaded2 = await loadPolicy(file);
  assert.equal(loaded2.max_range_days, 14);
  assert.deepEqual(loaded2.allow[PEER], ["calendar.free_busy"]);
});

test("task.run scope skips date constraints check", () => {
  const taskPolicy = normalizePolicy({
    allow: { [PEER]: ["task.run"] },
  });
  // 允许 task.run，不提供 constraints 也能通过
  assert.deepEqual(checkRequest(taskPolicy, PEER, { scope: "task.run" } as any), { ok: true });
  // 未允许 task.run 的调用方返回 out_of_scope
  assert.deepEqual(
    checkRequest(taskPolicy, "0x1111111111111111111111111111111111111111", { scope: "task.run" } as any),
    { ok: false, reason: "out_of_scope" }
  );
});

test("email.receipt validates query length and date span", () => {
  const emailPolicy = normalizePolicy({
    allow: { [PEER]: ["email.receipt"] },
    max_range_days: 7,
  });

  // 合法请求通过
  assert.deepEqual(
    checkRequest(emailPolicy, PEER, {
      scope: "email.receipt",
      constraints: { query: "from:12306", date_from: "2026-10-05", date_to: "2026-10-09" } as any,
    }),
    { ok: true }
  );

  // query 超过 200 字符失败
  assert.equal(
    checkRequest(emailPolicy, PEER, {
      scope: "email.receipt",
      constraints: { query: "a".repeat(201), date_from: "2026-10-05", date_to: "2026-10-09" } as any,
    }).ok,
    false
  );

  // 跨度超过 max_range_days 失败
  assert.equal(
    checkRequest(emailPolicy, PEER, {
      scope: "email.receipt",
      constraints: { query: "from:12306", date_from: "2026-10-01", date_to: "2026-10-30" } as any,
    }).ok,
    false
  );
});


