import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { ConsentQueue } from "./consentQueue.ts";
import { createOwnerConsoleServer } from "./ownerConsole.ts";

async function start() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "console-"));
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  const calls: string[] = [];
  const server = createOwnerConsoleServer({
    selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    queue,
    readLedger: async () => [],
    readInbox: async () => [],
    readOwnerNotes: async () => [{ self_name: "Codex", turns_seen: 1, action: "sent", block_reason: null }],
    approve: async (id) => {
      calls.push(`approve:${id}`);
      return { ok: true };
    },
    deny: async (id) => {
      calls.push(`deny:${id}`);
      return { ok: true };
    },
    sendRequest: async (body) => {
      calls.push(`request:${body.to}`);
      return { ok: true, request_id: "r" };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, calls, base: `http://127.0.0.1:${port}` };
}

test("serves the console page and state on loopback", async () => {
  const { server, base } = await start();
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal((await page.text()).includes("主人控制台"), true);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.self, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    assert.deepEqual(state.consents, []);
  } finally {
    server.close();
  }
});

test("approve without the owner header is refused", async () => {
  const { server, base, calls } = await start();
  try {
    const res = await fetch(`${base}/api/consents/req-1/approve`, { method: "POST" });
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []);
  } finally {
    server.close();
  }
});

test("approve, deny and request go through with the owner header", async () => {
  const { server, base, calls } = await start();
  try {
    const h = { "X-MAPR-Owner": "1", "Content-Type": "application/json" };
    assert.equal((await fetch(`${base}/api/consents/req-1/approve`, { method: "POST", headers: h })).status, 200);
    assert.equal((await fetch(`${base}/api/consents/req-2/deny`, { method: "POST", headers: h })).status, 200);
    const r = await fetch(`${base}/api/requests`, { method: "POST", headers: h, body: JSON.stringify({ to: "0xabc" }) });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ["approve:req-1", "deny:req-2", "request:0xabc"]);
  } finally {
    server.close();
  }
});

test("a cross-site origin is refused even with the header", async () => {
  const { server, base, calls } = await start();
  try {
    const res = await fetch(`${base}/api/consents/req-1/approve`, {
      method: "POST",
      headers: { "X-MAPR-Owner": "1", Origin: "https://evil.example" },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(calls, []);
  } finally {
    server.close();
  }
});

test("the old /owner-notes route still works", async () => {
  const { server, base } = await start();
  try {
    const body = await (await fetch(`${base}/owner-notes`)).json();
    assert.equal(body.notes.length, 1);
  } finally {
    server.close();
  }
});
