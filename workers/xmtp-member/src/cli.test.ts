import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { runCli } from "./cli.ts";

test("mapr identity create writes .env and prints address JSON without leaking private keys", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCli(["identity", "create", "--dir", dir], {
    stdout: (msg) => stdout.push(msg),
    stderr: (msg) => stderr.push(msg),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.length, 0);

  const outStr = stdout.join("").trim();
  const parsed = JSON.parse(outStr);
  assert.ok(parsed.address);
  assert.match(parsed.address, /^0x[0-9a-f]{40}$/);

  // 严格断言：输出中不能泄露 64 位十六进制私钥
  assert.doesNotMatch(outStr, /[0-9a-fA-F]{64}/);

  const envContent = await readFile(path.join(dir, ".env"), "utf8");
  assert.match(envContent, /XMTP_WALLET_KEY=0x[0-9a-fA-F]{64}/);
  assert.match(envContent, /XMTP_DB_ENCRYPTION_KEY=0x[0-9a-fA-F]{64}/);
  assert.match(envContent, /XMTP_ENV=dev/);
});

test("mapr request calls local server with X-MAPR-Owner header and outputs JSON", async () => {
  let receivedHeader = "";
  let receivedBody: any = null;

  const server = http.createServer(async (req, res) => {
    receivedHeader = String(req.headers["x-mapr-owner"]);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receivedBody = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, request_id: "req-mock-123" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = String((server.address() as AddressInfo).port);

  const stdout: string[] = [];
  try {
    const exitCode = await runCli(
      [
        "request",
        "--to",
        "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        "--scope",
        "calendar.free_busy",
        "--from",
        "2026-10-05",
        "--to-date",
        "2026-10-09",
        "--purpose",
        "协调下周例会",
        "--port",
        port,
      ],
      { stdout: (msg) => stdout.push(msg), stderr: () => {} }
    );

    assert.equal(exitCode, 0);
    assert.equal(receivedHeader, "1");
    assert.equal(receivedBody.to, "0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    assert.equal(receivedBody.date_from, "2026-10-05");
    assert.equal(receivedBody.date_to, "2026-10-09");

    const outJson = JSON.parse(stdout.join("").trim());
    assert.deepEqual(outJson, { ok: true, request_id: "req-mock-123" });
  } finally {
    server.close();
  }
});

test("mapr consents calls local server and extracts consents array", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        self: "0x...",
        consents: [{ request_id: "req-1", status: "pending" }],
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = String((server.address() as AddressInfo).port);

  const stdout: string[] = [];
  try {
    const exitCode = await runCli(["consents", "--port", port], {
      stdout: (msg) => stdout.push(msg),
      stderr: () => {},
    });

    assert.equal(exitCode, 0);
    const outJson = JSON.parse(stdout.join("").trim());
    assert.deepEqual(outJson, [{ request_id: "req-1", status: "pending" }]);
  } finally {
    server.close();
  }
});

test("mapr approve and deny call respective console endpoints", async () => {
  const actionsCalled: string[] = [];

  const server = http.createServer((req, res) => {
    actionsCalled.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = String((server.address() as AddressInfo).port);

  try {
    const stdout1: string[] = [];
    const exit1 = await runCli(["approve", "req-101", "--port", port], {
      stdout: (msg) => stdout1.push(msg),
      stderr: () => {},
    });
    assert.equal(exit1, 0);
    assert.deepEqual(JSON.parse(stdout1.join("").trim()), { ok: true });

    const stdout2: string[] = [];
    const exit2 = await runCli(["deny", "req-102", "--port", port], {
      stdout: (msg) => stdout2.push(msg),
      stderr: () => {},
    });
    assert.equal(exit2, 0);
    assert.deepEqual(JSON.parse(stdout2.join("").trim()), { ok: true });

    assert.deepEqual(actionsCalled, [
      "POST /api/consents/req-101/approve",
      "POST /api/consents/req-102/deny",
    ]);
  } finally {
    server.close();
  }
});

test("mapr task dispatches task to local console", async () => {
  let receivedBody: any = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receivedBody = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, request_id: "t-99" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = String((server.address() as AddressInfo).port);

  try {
    const stdout: string[] = [];
    const exit = await runCli(
      [
        "task",
        "--to",
        "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        "--goal",
        "调查路线",
        "--acceptance",
        "必须写明公里数,需有备选路线",
        "--port",
        port,
      ],
      { stdout: (msg) => stdout.push(msg), stderr: () => {} }
    );
    assert.equal(exit, 0);
    assert.deepEqual(receivedBody, {
      to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      goal: "调查路线",
      acceptance: ["必须写明公里数", "需有备选路线"],
    });
    assert.deepEqual(JSON.parse(stdout.join("").trim()), { ok: true, request_id: "t-99" });
  } finally {
    server.close();
  }
});

