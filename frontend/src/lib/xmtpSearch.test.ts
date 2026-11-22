import { describe, expect, it } from "vitest";
import {
  extractXmtpMessageText,
  XmtpSearchIndex,
  XMTP_SEARCH_MAX_ENTRIES,
} from "./xmtpSearch";

function entry(id: string, content: string, sender = "inbox-a", createdAt = "2026-11-20T10:00:00.000Z") {
  return { id, content, senderInboxId: sender, createdAt };
}

describe("XmtpSearchIndex", () => {
  it("finds case-insensitive substring matches in chronological order", () => {
    const index = new XmtpSearchIndex();
    index.ingest([
      entry("m2", "Hello MAPR World", "a", "2026-11-20T10:02:00Z"),
      entry("m1", "nothing here", "a", "2026-11-20T10:01:00Z"),
      entry("m3", "MAPR again", "a", "2026-11-20T09:59:00Z"),
    ]);
    const results = index.search("mapr");
    expect(results.map((r) => r.id)).toEqual(["m3", "m2"]);
  });

  it("filters by sender inbox id", () => {
    const index = new XmtpSearchIndex();
    index.ingest([
      entry("a1", "same keyword", "inbox-alice", "2026-11-20T10:00:00Z"),
      entry("b1", "same keyword", "inbox-bob", "2026-11-20T10:01:00Z"),
    ]);
    const results = index.search("keyword", { senderInboxId: "inbox-bob" });
    expect(results.map((r) => r.id)).toEqual(["b1"]);
  });

  it("deduplicates by message id on repeated ingest", () => {
    const index = new XmtpSearchIndex();
    index.upsert(entry("m1", "first"));
    index.upsert(entry("m1", "first"));
    index.ingest([entry("m1", "first"), entry("m2", "second")]);
    expect(index.size).toBe(2);
  });

  it("evicts the oldest entries once the bound is exceeded", () => {
    const index = new XmtpSearchIndex({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      index.upsert(entry(`m${i}`, `msg ${i}`, "a", `2026-11-20T10:0${i}:00Z`));
    }
    expect(index.size).toBe(3);
    const results = index.search("msg");
    expect(results.map((r) => r.id)).toEqual(["m2", "m3", "m4"]);
  });

  it("drops entries older than the age bound", () => {
    let now = Date.parse("2026-11-20T12:00:00Z");
    const index = new XmtpSearchIndex({ maxAgeMs: 60_000, now: () => now });
    index.upsert(entry("old", "old msg", "a", "2026-11-20T11:00:00Z"));
    index.upsert(entry("new", "new msg", "a", "2026-11-20T11:59:30Z"));
    expect(index.size).toBe(1);
    expect(index.search("msg").map((r) => r.id)).toEqual(["new"]);
  });

  it("skips empty or malformed entries", () => {
    const index = new XmtpSearchIndex();
    index.ingest([
      entry("", "x"),
      entry("m1", ""),
      { id: "m2", content: "ok", senderInboxId: "", createdAt: "2026-11-20T10:00:00Z" },
    ]);
    expect(index.size).toBe(0);
  });

  it("returns empty for blank queries and respects limit", () => {
    const index = new XmtpSearchIndex();
    index.ingest([entry("m1", "hello"), entry("m2", "hello again")]);
    expect(index.search("   ")).toEqual([]);
    expect(index.search("hello", { limit: 1 }).map((r) => r.id)).toEqual(["m1"]);
  });

  it("caps memory at the documented bound", () => {
    expect(XMTP_SEARCH_MAX_ENTRIES).toBe(2000);
    const index = new XmtpSearchIndex();
    for (let i = 0; i < XMTP_SEARCH_MAX_ENTRIES + 50; i++) {
      index.upsert(entry(`m${i}`, `n${i}`, "a", new Date(1_700_000_000_000 + i).toISOString()));
    }
    expect(index.size).toBeLessThanOrEqual(XMTP_SEARCH_MAX_ENTRIES);
  });
});

describe("extractXmtpMessageText", () => {
  it("passes through plain text content", () => {
    expect(extractXmtpMessageText({ content: "hello" })).toEqual({ text: "hello" });
  });

  it("extracts inner text and reference id from a text reply", () => {
    const message = {
      content: { referenceId: "ref-9", content: "reply body" },
    };
    expect(extractXmtpMessageText(message)).toEqual({ text: "reply body", replyToId: "ref-9" });
  });

  it("falls back gracefully for replies wrapping non-text content", () => {
    const message = {
      content: { referenceId: "ref-1", content: { kind: "attachment" } },
      fallback: "sent an attachment",
    };
    expect(extractXmtpMessageText(message)).toEqual({ text: "sent an attachment", replyToId: "ref-1" });
  });

  it("returns null for non-text non-reply content types", () => {
    expect(extractXmtpMessageText({ content: { action: "added" } })).toBeNull();
    expect(extractXmtpMessageText({ content: undefined })).toBeNull();
    expect(extractXmtpMessageText({ content: null })).toBeNull();
  });
});
