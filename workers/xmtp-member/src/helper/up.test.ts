import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { parseUpArgs } from "./up.ts";

test("parseUpArgs：默认生产 Hub 与 ~/.mapr，默认打开浏览器", () => {
  const o = parseUpArgs({}, {}, "/home/u");
  assert.equal(o.hubOrigin, "https://hub.wangdada8208.xyz");
  assert.equal(o.rootDir, path.join("/home/u", ".mapr"));
  assert.equal(o.openBrowser, true);
  assert.equal(o.pairCode, undefined);
});

test("parseUpArgs：命令行优先于环境变量，hub 末尾斜线去掉", () => {
  const o = parseUpArgs(
    { hub: "http://127.0.0.1:8000/", pair: "mpc_x", dir: "/tmp/m", "no-browser": "true" },
    { MAPR_HUB_ORIGIN: "http://ignored" },
    "/home/u"
  );
  assert.equal(o.hubOrigin, "http://127.0.0.1:8000");
  assert.equal(o.pairCode, "mpc_x");
  assert.equal(o.rootDir, "/tmp/m");
  assert.equal(o.openBrowser, false);
});

test("parseUpArgs：环境变量兜底；--browser=false 也关浏览器", () => {
  const e = parseUpArgs({}, { MAPR_HUB_ORIGIN: "http://hub.dev", MAPR_DIR: "/tmp/m2" }, "/home/u");
  assert.equal(e.hubOrigin, "http://hub.dev");
  assert.equal(e.rootDir, "/tmp/m2");
  const b = parseUpArgs({ browser: "false" }, {}, "/home/u");
  assert.equal(b.openBrowser, false);
});

test("parseUpArgs：拒绝非 http(s) 的 hub 地址", () => {
  assert.throws(() => parseUpArgs({ hub: "ftp://x" }, {}, "/h"), /--hub/);
  assert.throws(() => parseUpArgs({ hub: "not-a-url" }, {}, "/h"), /--hub/);
});
