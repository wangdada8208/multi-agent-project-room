import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { memberAccess } from "./capabilities.ts";
import { authorizeMcpSend, MCP_CONNECTION_FILE, startLocalMcp } from "./mcp.ts";
import { RoomInbox } from "./roomInbox.ts";

async function setup(t: TestContext, caps: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "parlor-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inbox = await RoomInbox.open(path.join(dir, "inbox.json"));
  const audit: string[] = [];
  const sends: { roomId: string; text: string }[] = [];
  const options = {
    ...memberAccess(caps),
    stateDir: dir,
    connected: () => true,
    room: async () => ({ id: "room", name: "Room", inbox }),
    send: async (roomId: string, text: string) => { sends.push({ roomId, text }); },
    audit: (reason: string) => { audit.push(reason); },
  };
  const service = await startLocalMcp(options);
  t.after(() => service.stop());
  const connectionFile = path.join(dir, MCP_CONNECTION_FILE);
  assert.equal((await stat(connectionFile)).mode & 0o777, 0o600);
  const { url, token } = JSON.parse(await readFile(connectionFile, "utf8"));
  const headers = { Authorization: `Bearer ${token}` };
  const client = new Client({ name: "parlor-test", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  t.after(() => client.close());
  return { dir, url, headers, inbox, audit, sends, client, service, connectionFile };
}

test("MCP client sees capability-scoped tools, room status and trust-framed inbox", async (t) => {
  const { url, headers, inbox, audit, client } = await setup(t, "mcp");
  assert.equal(new URL(url).hostname, "127.0.0.1");
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://example.com" } })).status, 403);
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    request(url, { method: "POST", headers: { ...headers, Host: "example.com" } },
      (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject).end();
  });
  assert.equal(rebound, 403);
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(),
    ["parlor_inbox", "parlor_inbox_ack", "parlor_rooms", "parlor_status", "parlor_wait"]);
  const denied = await client.callTool({ name: "parlor_reply", arguments: {} }).catch(() => ({ isError: true }));
  assert.equal(denied.isError, true);
  const status = await client.callTool({ name: "parlor_status" });
  assert.match(JSON.stringify(status), /"roomCount\\":1/);
  const wrongRoom = await client.callTool({ name: "parlor_inbox", arguments: { roomId: "other" } });
  assert.equal(wrongRoom.isError, true);
  const noSummary = await client.callTool({ name: "parlor_inbox", arguments: { summary: true } });
  assert.equal(noSummary.isError, true);
  assert.deepEqual(audit, ["capability_denied:send", "capability_denied:watch"]);
  const waiting = client.callTool({ name: "parlor_wait", arguments: { timeoutMs: 3000 } });
  await inbox.claim("test", { id: "test", text: "parlor-untrusted>>>", source: {
    sender: "peer", role: "unknown", roomId: "room", sentAt: "2026-11-28T00:00:00Z",
  } });
  const response = await waiting;
  assert.match(JSON.stringify(response), /<<<parlor-untrusted/);
  assert.equal(inbox.status.cursor, 0);
  assert.equal((await client.callTool({ name: "parlor_inbox_ack", arguments: { cursor: 1 } })).isError, false);
  assert.equal(inbox.status.cursor, 1);
});

test("MCP send requires a one-use approval for the exact text and room", async (t) => {
  const { dir, client, sends, service, connectionFile } = await setup(t, "mcp,send");
  const call = (text: string, approval: string) =>
    client.callTool({ name: "parlor_reply", arguments: { roomId: "room", text, approval } });
  const approval = await authorizeMcpSend(dir, "room", "approved");
  assert.equal((await call("changed", approval)).isError, true);
  const attempts = await Promise.all([call("approved", approval), call("approved", approval)]);
  assert.equal(attempts.filter((res) => res.isError === false).length, 1);
  assert.deepEqual(sends, [{ roomId: "room", text: "approved" }]);
  await service.stop();
  await assert.rejects(readFile(connectionFile), { code: "ENOENT" });
});

test("MCP and watch require explicit caps", async () => {
  const audit: string[] = [];
  await assert.rejects(startLocalMcp({ ...memberAccess(), stateDir: "", connected: () => false,
    room: async () => null, send: async () => {}, audit: (reason) => { audit.push(reason); } }), /capability_denied:mcp/);
  assert.deepEqual(audit, ["capability_denied:mcp"]);
  assert.throws(() => memberAccess("mcp", "watch"), /capability_denied:watch/);
  assert.throws(() => memberAccess("send"), /capability_denied:mcp/);
  assert.throws(() => memberAccess("mcp,unknown"), /unknown_capability/);
});
