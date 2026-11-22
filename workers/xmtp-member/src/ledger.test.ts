import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LEDGER_GENESIS_PREV_HASH,
  appendLedger,
  buildLedgerEntry,
  computeEntryHash,
  readLedger,
  verifyLedger,
  verifyLedgerEntries,
  type LedgerEntry,
} from "./ledger.ts";

test("ledger entry has only metadata fields", () => {
  const entry = buildLedgerEntry({
    now: new Date("2026-10-01T00:00:00Z"),
    kind: "sender_dropped",
    peer: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
    reason: "sender_not_allowed",
  });
  assert.deepEqual(Object.keys(entry).sort(), [
    "at", "kind", "payload_hash", "peer", "reason", "request_id", "scope", "sender",
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

async function tmpLedger(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-chain-"));
  return path.join(dir, "ledger.jsonl");
}

function entry(now: string, kind: Parameters<typeof buildLedgerEntry>[0]["kind"] = "request_sent", requestId = "r"): LedgerEntry {
  return buildLedgerEntry({ now: new Date(now), kind, requestId });
}

test("appended entries form a hash chain starting at GENESIS", async () => {
  const file = await tmpLedger();
  await appendLedger(file, entry("2026-10-01T00:00:00Z", "request_sent", "r1"));
  await appendLedger(file, entry("2026-10-01T00:01:00Z", "request_queued", "r2"));
  await appendLedger(file, entry("2026-10-01T00:02:00Z", "consent_approved", "r3"));
  const all = await readLedger(file);
  assert.equal(all.length, 3);
  assert.equal(all[0].seq, 1);
  assert.equal(all[0].prev_hash, LEDGER_GENESIS_PREV_HASH);
  for (let i = 1; i < all.length; i += 1) {
    assert.equal(all[i].seq, i + 1);
    assert.equal(all[i].prev_hash, all[i - 1].entry_hash);
  }
  for (const e of all) {
    assert.equal(e.entry_hash, computeEntryHash(e.prev_hash as string, e));
  }
  const result = await verifyLedger(file);
  assert.equal(result.ok, true);
  assert.equal(result.chained_entries, 3);
  assert.equal(result.legacy_unverified_entries, 0);
  assert.deepEqual(result.head, { seq: 3, entry_hash: all[2].entry_hash });
});

test("appendLedger keeps working file and dir permissions at 0700/0600", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-perm-"));
  const file = path.join(dir, "nested", "ledger.jsonl");
  await appendLedger(file, entry("2026-10-01T00:00:00Z"));
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("caller-supplied chain fields are ignored and recomputed", async () => {
  const file = await tmpLedger();
  const forged = {
    ...entry("2026-10-01T00:00:00Z"),
    seq: 99,
    prev_hash: "deadbeef",
    entry_hash: "deadbeef",
  };
  await appendLedger(file, forged);
  const [written] = await readLedger(file);
  assert.equal(written.seq, 1);
  assert.equal(written.prev_hash, LEDGER_GENESIS_PREV_HASH);
  assert.equal((await verifyLedger(file)).ok, true);
});

test("legacy pre-chain entries are classified as legacy_unverified, not tamper-proof", async () => {
  const file = await tmpLedger();
  const legacyA = JSON.stringify(entry("2026-10-01T00:00:00Z", "request_sent", "old1"));
  const legacyB = JSON.stringify(entry("2026-10-01T00:01:00Z", "request_queued", "old2"));
  await writeFile(file, legacyA + "\n" + legacyB + "\n", "utf8");
  await appendLedger(file, entry("2026-10-01T00:02:00Z", "consent_approved", "new1"));
  const all = await readLedger(file);
  assert.equal(all.length, 3);
  assert.equal(all[0].seq, undefined);
  assert.equal(all[2].seq, 1);
  assert.equal(all[2].prev_hash, LEDGER_GENESIS_PREV_HASH);
  const result = await verifyLedger(file);
  assert.equal(result.ok, true);
  assert.equal(result.legacy_unverified_entries, 2);
  assert.equal(result.chained_entries, 1);
});

test("modifying a chained entry breaks entry_hash verification", async () => {
  const file = await tmpLedger();
  for (let i = 0; i < 3; i += 1) {
    await appendLedger(file, entry(`2026-10-01T00:0${i}:00Z`, "request_sent", `r${i}`));
  }
  const all = await readLedger(file);
  const tampered = { ...all[1], reason: "forged" };
  const lines = (await readFile(file, "utf8")).split("\n");
  lines[1] = JSON.stringify(tampered);
  await writeFile(file, lines.join("\n"), "utf8");
  const result = await verifyLedger(file);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "entry_hash_mismatch" && i.line === 2));
});

test("reordering chained entries breaks prev_hash links", async () => {
  const file = await tmpLedger();
  for (let i = 0; i < 3; i += 1) {
    await appendLedger(file, entry(`2026-10-01T00:0${i}:00Z`, "request_sent", `r${i}`));
  }
  const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l.trim());
  [lines[1], lines[2]] = [lines[2], lines[1]];
  await writeFile(file, lines.join("\n") + "\n", "utf8");
  const result = await verifyLedger(file);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "prev_link_mismatch"));
});

test("deleting a middle entry is reported as a sequence gap and broken link", async () => {
  const file = await tmpLedger();
  for (let i = 0; i < 3; i += 1) {
    await appendLedger(file, entry(`2026-10-01T00:0${i}:00Z`, "request_sent", `r${i}`));
  }
  const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l.trim());
  lines.splice(1, 1);
  await writeFile(file, lines.join("\n") + "\n", "utf8");
  const result = await verifyLedger(file);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "sequence_gap"));
  assert.ok(result.issues.some((i) => i.code === "prev_link_mismatch"));
});

test("truncation is invisible to self-verify but caught by an anchored checkpoint", async () => {
  const file = await tmpLedger();
  for (let i = 0; i < 4; i += 1) {
    await appendLedger(file, entry(`2026-10-01T00:0${i}:00Z`, "request_sent", `r${i}`));
  }
  const all = await readLedger(file);
  const anchor = { head_seq: 4, head_hash: all[3].entry_hash as string };
  assert.equal((await verifyLedger(file, { anchoredCheckpoint: anchor })).ok, true);
  const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l.trim());
  await writeFile(file, lines.slice(0, 2).join("\n") + "\n", "utf8");
  const truncated = await verifyLedger(file);
  assert.equal(truncated.ok, true, "self-verify cannot see truncation without an anchor");
  const anchored = await verifyLedger(file, { anchoredCheckpoint: anchor });
  assert.equal(anchored.ok, false);
  assert.ok(anchored.issues.some((i) => i.code === "anchor_truncated"));
});

test("history rewritten after an anchor is caught by anchor_hash_mismatch", async () => {
  const file = await tmpLedger();
  for (let i = 0; i < 3; i += 1) {
    await appendLedger(file, entry(`2026-10-01T00:0${i}:00Z`, "request_sent", `r${i}`));
  }
  const all = await readLedger(file);
  const anchor = { head_seq: 2, head_hash: all[1].entry_hash as string };
  // 攻击者重写了 seq>=2 的整段链（重新计算了哈希），但锚点处的哈希对不上。
  const rewritten = { ...all[1], reason: "forged" };
  const rehashed2 = { ...rewritten, entry_hash: computeEntryHash(rewritten.prev_hash as string, rewritten) };
  const third = { ...all[2], prev_hash: rehashed2.entry_hash };
  const rehashed3 = { ...third, entry_hash: computeEntryHash(third.prev_hash as string, third) };
  await writeFile(
    file,
    [JSON.stringify(all[0]), JSON.stringify(rehashed2), JSON.stringify(rehashed3)].join("\n") + "\n",
    "utf8",
  );
  const selfOnly = await verifyLedger(file);
  assert.equal(selfOnly.ok, true, "self-consistent rewritten chain passes without an anchor");
  const anchored = await verifyLedger(file, { anchoredCheckpoint: anchor });
  assert.equal(anchored.ok, false);
  assert.ok(anchored.issues.some((i) => i.code === "anchor_hash_mismatch"));
});

test("malformed and partially-chained lines are reported, not silently skipped", async () => {
  const file = await tmpLedger();
  await appendLedger(file, entry("2026-10-01T00:00:00Z", "request_sent", "r1"));
  await appendFile(file, "not json\n", "utf8");
  const partial = { ...entry("2026-10-01T00:01:00Z"), seq: 99 };
  await appendFile(file, JSON.stringify(partial) + "\n", "utf8");
  await appendLedger(file, entry("2026-10-01T00:02:00Z", "request_sent", "r2"));
  const result = await verifyLedger(file);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "malformed_line"));
  assert.ok(result.issues.some((i) => i.code === "chain_fields_incomplete"));
  assert.equal(result.malformed_lines, 1);
  assert.equal(result.chained_entries, 2);
});

test("concurrent appends to the same file never fork the chain", async () => {
  const file = await tmpLedger();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      appendLedger(file, entry(`2026-10-01T00:${String(i).padStart(2, "0")}:00Z`, "request_sent", `r${i}`)),
    ),
  );
  const all = await readLedger(file);
  assert.equal(all.length, 20);
  const seqs = all.map((e) => e.seq).sort((a, b) => (a as number) - (b as number));
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
  const result = await verifyLedger(file);
  assert.equal(result.ok, true);
});

test("verifyLedgerEntries verifies parsed arrays and verifyLedger on a missing file is empty-ok", async () => {
  const missing = path.join(await mkdtemp(path.join(os.tmpdir(), "ledger-none-")), "nope.jsonl");
  const result = await verifyLedger(missing);
  assert.equal(result.ok, true);
  assert.equal(result.total_lines, 0);
  assert.equal(result.head, null);
  const array = verifyLedgerEntries([
    { ...entry("2026-10-01T00:00:00Z"), seq: 1, prev_hash: LEDGER_GENESIS_PREV_HASH, entry_hash: "bad" },
  ]);
  assert.equal(array.ok, false);
  assert.ok(array.issues.some((i) => i.code === "entry_hash_mismatch"));
});
