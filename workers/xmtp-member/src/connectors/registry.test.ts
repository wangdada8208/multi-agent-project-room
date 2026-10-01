import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalCalendarConnector } from "./localCalendar.ts";
import { findConnector } from "./registry.ts";

test("findConnector returns matching connector by scope", () => {
  const local = new LocalCalendarConnector("/tmp/calendar.json");
  const mockConnector = {
    id: "mock-receipt",
    scopes: ["email.receipt"],
    fetch: async () => ({ scope: "email.receipt" }),
  };
  const connectors = [local, mockConnector];

  assert.equal(findConnector("calendar.free_busy", connectors), local);
  assert.equal(findConnector("email.receipt", connectors), mockConnector);
  assert.equal(findConnector("unknown.scope", connectors), null);
});

test("LocalCalendarConnector fetches freeBusy and filters correctly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "conn-cal-"));
  const file = path.join(dir, "calendar.json");
  await writeFile(
    file,
    JSON.stringify([
      { start: "2026-10-06T09:00:00Z", end: "2026-10-06T10:00:00Z", title: "绝密会议" },
    ])
  );
  const connector = new LocalCalendarConnector(file);
  const result: any = await connector.fetch("calendar.free_busy", {
    date_from: "2026-10-05",
    date_to: "2026-10-09",
  });
  assert.equal(result.scope, "calendar.free_busy");
  assert.equal(result.busy.length, 1);
  assert.equal(JSON.stringify(result).includes("绝密"), false);
});

test("approveConsent returns no_connector when registry cannot find scope", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "conn-action-"));
  const { ConsentQueue } = await import("../consentQueue.ts");
  const { approveConsent } = await import("../consentActions.ts");
  const queue = new ConsentQueue(path.join(dir, "consents.json"));
  await queue.add({
    request_id: "r-999",
    requester: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    conversation_id: "c1",
    scope: "unsupported.scope",
    purpose: "测试",
    constraints: { date_from: "2026-10-05", date_to: "2026-10-09" },
    created_at: new Date().toISOString(),
  });

  const sent: any[] = [];
  const actionDeps: any = {
    selfAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    queue,
    connectors: [], // 空注册表
    send: async (conv: string, text: string) => sent.push({ conv, text }),
    appendLedger: async () => {},
    now: () => new Date(),
  };

  const res = await approveConsent("r-999", actionDeps);
  assert.deepEqual(res, { ok: false, reason: "no_connector" });
  assert.equal(sent.length, 0); // 不发任何消息
});

