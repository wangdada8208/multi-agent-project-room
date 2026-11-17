import assert from "node:assert/strict";
import test from "node:test";
import { guardHelperRequest, type GuardInput, type RequestClass } from "./server.ts";

const HUB = "https://hub.wangdada8208.xyz";
const LOOP = "http://127.0.0.1:8790";
const LOOP2 = "http://localhost:3000";
const EVIL = "https://evil.example";

function guard(partial: Partial<GuardInput> & { requestClass: RequestClass }) {
  return guardHelperRequest({
    method: "POST",
    host: "127.0.0.1:8790",
    origin: undefined,
    ownerHeader: undefined,
    hubOrigin: HUB,
    ...partial,
  });
}

const ALL_CLASSES: RequestClass[] = ["page", "public-read", "owner-read", "owner-write", "ticket-write"];
const READ_LIKE: RequestClass[] = ["page", "public-read", "owner-read", "ticket-write"];

test("guard: non-loopback Host is always 403 (S4, DNS rebinding)", () => {
  for (const requestClass of ALL_CLASSES) {
    for (const host of ["evil.com", "127.0.0.1.evil.com", "10.0.0.5", "localhost.evil.com", undefined]) {
      assert.deepEqual(
        guard({ requestClass, host, ownerHeader: "1", origin: LOOP }),
        { ok: false, status: 403 },
        `${requestClass} host=${host}`
      );
    }
  }
});

test("guard: loopback Host variants pass", () => {
  for (const host of ["127.0.0.1:8790", "127.0.0.1", "localhost:8790", "LOCALHOST:8790", "[::1]:8790"]) {
    const r = guard({ requestClass: "public-read", host });
    assert.equal(r.ok, true, `host=${host}`);
  }
});

for (const requestClass of READ_LIKE) {
  test(`guard ${requestClass}: loopback/hub/absent origin pass, foreign origin 403`, () => {
    for (const origin of [undefined, LOOP, LOOP2, HUB]) {
      const r = guard({ requestClass, origin });
      assert.equal(r.ok, true, `origin=${origin}`);
      if (r.ok) assert.equal(r.corsOrigin, origin ?? null);
    }
    for (const origin of [EVIL, "null", "http://127.0.0.1.evil.com", "file:///etc/passwd"]) {
      assert.deepEqual(guard({ requestClass, origin }), { ok: false, status: 403 }, `origin=${origin}`);
    }
  });
}

test("guard owner-write: requires X-MAPR-Owner 1 + loopback-or-absent origin", () => {
  // 回环页面（同源或别的回环端口）+ owner 头 → 放行
  assert.deepEqual(
    guard({ requestClass: "owner-write", origin: LOOP, ownerHeader: "1" }),
    { ok: true, corsOrigin: LOOP }
  );
  assert.deepEqual(
    guard({ requestClass: "owner-write", origin: LOOP2, ownerHeader: "1" }),
    { ok: true, corsOrigin: LOOP2 }
  );
  // 回环页面但缺 owner 头 → 403
  assert.deepEqual(guard({ requestClass: "owner-write", origin: LOOP }), { ok: false, status: 403 });
  // 命令行工具（无 Origin）+ owner 头 → 放行
  assert.deepEqual(guard({ requestClass: "owner-write", ownerHeader: "1" }), { ok: true, corsOrigin: null });
  // owner 头值必须恰好是 "1"
  assert.deepEqual(guard({ requestClass: "owner-write", ownerHeader: "yes" }), { ok: false, status: 403 });
  // 网站来源永远不能做 owner-write——哪怕它伪造了 owner 头
  for (const origin of [HUB, EVIL]) {
    assert.deepEqual(
      guard({ requestClass: "owner-write", origin, ownerHeader: "1" }),
      { ok: false, status: 403 },
      `origin=${origin}`
    );
  }
});

test("guard ticket-write: hubOrigin 放行（网站唯一被允许的写路径）", () => {
  const r = guard({ requestClass: "ticket-write", origin: HUB });
  assert.deepEqual(r, { ok: true, corsOrigin: HUB });
});
