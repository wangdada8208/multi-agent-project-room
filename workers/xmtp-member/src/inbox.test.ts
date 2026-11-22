import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendInboxOnce, readInbox, type InboxEntry } from "./inbox.ts";

test("the same grant is stored only once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inbox-"));
  const file = path.join(dir, "inbox.json");
  const entry = {
    received_at: "2026-10-01T08:00:00.000Z",
    from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    request_id: "req-1",
    grant_id: "g-1",
    payload: { scope: "calendar.free_busy" as const, date_from: "2026-10-05", date_to: "2026-10-09", busy: [] },
  };
  assert.equal(await appendInboxOnce(file, entry), true);
  assert.equal(await appendInboxOnce(file, entry), false);
  assert.equal((await readInbox(file)).length, 1);
});

test("concurrent distinct grants are all retained", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inbox-concurrent-"));
  const file = path.join(dir, "inbox.json");
  const entries: InboxEntry[] = Array.from({ length: 40 }, (_, i) => ({
    received_at: "2026-10-01T08:00:00.000Z",
    from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    request_id: `req-${i}`,
    grant_id: `g-${i}`,
    payload: { scope: "calendar.free_busy", date_from: "2026-10-05", date_to: "2026-10-09", busy: [] },
  }));

  const stored = await Promise.all(entries.map((entry) => appendInboxOnce(file, entry)));
  assert.deepEqual(stored, entries.map(() => true));
  const all = await readInbox(file);
  assert.equal(all.length, entries.length);
  assert.deepEqual(new Set(all.map((entry) => entry.grant_id)), new Set(entries.map((entry) => entry.grant_id)));
});
