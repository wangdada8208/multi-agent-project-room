import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendLedger, buildLedgerEntry, readLedger } from "./ledger.ts";

test("ledger entry has only metadata fields", () => {
  const entry = buildLedgerEntry({
    now: new Date("2026-10-01T00:00:00Z"),
    kind: "sender_dropped",
    peer: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
    reason: "sender_not_allowed",
  });
  assert.deepEqual(Object.keys(entry).sort(), [
    "at", "kind", "payload_hash", "peer", "reason", "request_id", "scope",
  ]);
  assert.equal(entry.peer, "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  assert.equal(entry.request_id, null);
});

test("append then read round-trips and skips broken lines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-"));
  const file = path.join(dir, "ledger.jsonl");
  assert.deepEqual(await readLedger(file), []);
  const e = buildLedgerEntry({ now: new Date("2026-10-01T00:00:00Z"), kind: "request_sent", requestId: "r1" });
  await appendLedger(file, e);
  const { appendFile } = await import("node:fs/promises");
  await appendFile(file, "not json\n", "utf8");
  await appendLedger(file, e);
  const all = await readLedger(file);
  assert.equal(all.length, 2);
  assert.equal(all[0].request_id, "r1");
});
