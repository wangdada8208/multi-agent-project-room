import assert from "node:assert/strict";
import test from "node:test";
import { hasActionSchema, validateActionParams } from "./actionSchemas.ts";

const VALID = {
  to: ["boss@example.com"],
  subject: "周五汇报",
  body: "本周进展：\n1. 完成 A\n2. 开始 B",
};

test("a minimal valid gmail.send params passes", () => {
  assert.deepEqual(validateActionParams("gmail.send", VALID), { ok: true });
});

test("cc/bcc/account optional fields pass when valid", () => {
  const res = validateActionParams("gmail.send", {
    ...VALID,
    cc: ["a@x.com", "b@y.co.uk"],
    bcc: [],
    account: "work-01",
  });
  assert.deepEqual(res, { ok: true });
});

test("action name is normalized before schema lookup", () => {
  assert.deepEqual(validateActionParams("  GMAIL.SEND ", VALID), { ok: true });
});

test("actions without a registered schema are refused (fail closed)", () => {
  const res = validateActionParams("calendar.read", VALID);
  assert.equal(res.ok, false);
  assert.equal(hasActionSchema("calendar.read"), false);
  assert.equal(hasActionSchema("gmail.send"), true);
});

test("unknown keys are rejected (whitelist, no pass-through)", () => {
  for (const extra of [
    { from: "me@x.com" },
    { headers: { "Bcc": "sneak@x.com" } },
    { to2: ["a@x.com"] },
  ]) {
    const res = validateActionParams("gmail.send", { ...VALID, ...extra });
    assert.equal(res.ok, false, JSON.stringify(extra));
    assert.match(res.reason, /^unknown_key/);
  }
  // __proto__ 作为自有可枚举键（如 JSON.parse 的产物）同样算 unknown key
  const polluted = Object.fromEntries([...Object.entries(VALID), ["__proto__", { admin: 1 }]]);
  const res = validateActionParams("gmail.send", polluted);
  assert.equal(res.ok, false);
  assert.match(res.reason, /^unknown_key/);
});

test("to must be a non-empty list of valid emails (1..20)", () => {
  assert.equal(validateActionParams("gmail.send", { ...VALID, to: "boss@x.com" }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, to: [] }).ok, false);
  assert.equal(
    validateActionParams("gmail.send", { ...VALID, to: Array(21).fill("a@x.com") }).ok,
    false
  );
  assert.equal(
    validateActionParams("gmail.send", { ...VALID, to: ["a@x.com", "not-an-email"] }).ok,
    false
  );
  assert.equal(validateActionParams("gmail.send", { ...VALID, to: ["a@x"] }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, to: ["a @x.com"] }).ok, false);
});

test("header injection via CR/LF is rejected in to/cc/subject", () => {
  const injected = "a@x.com\r\nBcc: evil@x.com";
  assert.equal(validateActionParams("gmail.send", { ...VALID, to: [injected] }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, cc: ["ok@x.com", "b@y.com\nX: 1"] }).ok, false);
  assert.equal(
    validateActionParams("gmail.send", { ...VALID, bcc: ["a@x.com\nBcc: evil@x.com"] }).ok,
    false
  );
  const r = validateActionParams("gmail.send", { ...VALID, subject: "hi\nBcc: evil@x.com" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "subject_control_chars");
});

test("subject bounds: 1..200 chars, no control chars", () => {
  assert.equal(validateActionParams("gmail.send", { ...VALID, subject: "" }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, subject: "x".repeat(200) }).ok, true);
  assert.equal(validateActionParams("gmail.send", { ...VALID, subject: "x".repeat(201) }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, subject: "a\tb" }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, subject: 42 }).ok, false);
});

test("body bounds: non-empty, <=32KiB UTF-8 bytes; \\n\\t allowed, other control chars rejected", () => {
  assert.equal(validateActionParams("gmail.send", { ...VALID, body: "" }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, body: "x".repeat(32 * 1024) }).ok, true);
  assert.equal(validateActionParams("gmail.send", { ...VALID, body: "x".repeat(32 * 1024 + 1) }).ok, false);
  // 多字节字符按 UTF-8 字节计：16384 个「汉」= 49152 字节 > 32KiB
  assert.equal(validateActionParams("gmail.send", { ...VALID, body: "汉".repeat(16384) }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, body: "汉".repeat(10000) }).ok, true);
  assert.equal(validateActionParams("gmail.send", { ...VALID, body: "a\x00b" }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, body: "a\x0Bb" }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, body: "line1\r\nline2\tend" }).ok, true);
});

test("account must match the safe identifier shape when present", () => {
  assert.equal(validateActionParams("gmail.send", { ...VALID, account: "work.mail_01" }).ok, true);
  assert.equal(validateActionParams("gmail.send", { ...VALID, account: "a".repeat(65) }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, account: "bad account" }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, account: "../etc/passwd" }).ok, false);
  assert.equal(validateActionParams("gmail.send", { ...VALID, account: 7 }).ok, false);
});

test("non-object params are rejected", () => {
  for (const p of [null, undefined, "x", 42, [], ["a@x.com"]]) {
    assert.equal(validateActionParams("gmail.send", p).ok, false, String(p));
  }
});
