import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalStringify,
  MAX_PARAM_DEPTH,
  MAX_PARAM_KEYS,
  normalizeScope,
  paramsShapeOk,
} from "./canonical.ts";
import { hashPayload } from "./grant.ts";

test("canonicalStringify sorts keys recursively and drops undefined", () => {
  assert.equal(
    canonicalStringify({ b: 2, a: { d: 4, c: 3 }, e: undefined }),
    '{"a":{"c":3,"d":4},"b":2}'
  );
  assert.equal(canonicalStringify([{ y: 1, x: 2 }]), '[{"x":2,"y":1}]');
  // 不同键序 ⇒ 同一哈希——签名/参数绑定跨实现可复现
  assert.equal(
    hashPayload({ to: "a@b.c", subject: "s", body: "x" }),
    hashPayload({ body: "x", subject: "s", to: "a@b.c" })
  );
  // 内容不同 ⇒ 哈希不同
  assert.notEqual(hashPayload({ to: "a@b.c" }), hashPayload({ to: "x@b.c" }));
});

test("normalizeScope trims and lowercases", () => {
  assert.equal(normalizeScope("  GMAIL.Send  "), "gmail.send");
  assert.equal(normalizeScope("PAYMENT.send"), "payment.send");
});

test("paramsShapeOk bounds depth, total keys and array length", () => {
  assert.equal(paramsShapeOk({ a: { b: { c: 1 } }, list: [1, 2, { x: 3 }] }), true);
  // 超过深度上限
  let deep: Record<string, unknown> = { v: 1 };
  for (let i = 0; i <= MAX_PARAM_DEPTH; i++) deep = { n: deep };
  assert.equal(paramsShapeOk(deep), false);
  // 超过总键数
  const wide: Record<string, unknown> = {};
  for (let i = 0; i <= MAX_PARAM_KEYS; i++) wide[`k${i}`] = i;
  assert.equal(paramsShapeOk(wide), false);
  // 嵌套对象的键也计入同一预算
  const nested: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) {
    const inner: Record<string, unknown> = {};
    for (let j = 0; j < 20; j++) inner[`k${j}`] = j;
    nested[`o${i}`] = inner;
  }
  assert.equal(paramsShapeOk(nested), false);
  // 超长数组
  assert.equal(paramsShapeOk({ list: new Array(201).fill(0) }), false);
});
