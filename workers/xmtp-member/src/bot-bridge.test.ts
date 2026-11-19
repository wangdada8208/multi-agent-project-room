import assert from "node:assert/strict";
import test from "node:test";
import { formatInboundLine, parseBridgeArgs } from "./bot-bridge.ts";

test("parseBridgeArgs: 默认值与 --invite/--group 必填", () => {
  const a = parseBridgeArgs(["--invite", "tok123"], {});
  assert.equal(a.invite, "tok123");
  assert.equal(a.hub, "https://hub.wangdada8208.xyz");
  assert.equal(a.env, "production");
  assert.equal(a.name, "bot");
  const b = parseBridgeArgs(
    ["--invite", "t", "--hub", "https://h.example/", "--name", "Grokbot", "--env", "dev", "--group", "g1", "--exec", "cat"],
    { MAPR_HUB_ORIGIN: "https://ignored.example" }
  );
  assert.equal(b.hub, "https://h.example");
  assert.equal(b.group, "g1");
  assert.equal(b.exec, "cat");
});

test("parseBridgeArgs: 缺 invite 和 group 直接退出", () => {
  const oldExit = process.exit;
  let code = -1;
  process.exit = ((c: number) => { code = c; throw new Error("exit"); }) as never;
  try {
    assert.throws(() => parseBridgeArgs([], {}));
    assert.equal(code, 2);
  } finally {
    process.exit = oldExit;
  }
});

test("formatInboundLine 生成可解析的 jsonl", () => {
  const line = formatInboundLine("0xabc", "你好", "2026-11-19T00:00:00Z");
  assert.deepEqual(JSON.parse(line), { ts: "2026-11-19T00:00:00Z", sender: "0xabc", text: "你好" });
});
