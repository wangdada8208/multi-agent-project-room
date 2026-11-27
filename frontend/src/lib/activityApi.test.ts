import { describe, expect, it, vi } from "vitest";
import {
  fetchHubActivity,
  fetchLocalActivity,
  inferAppFromScope,
  mergeActivityFeeds,
  type HubActivityFeed,
  type LocalActivityResult,
} from "./activityApi";

describe("activityApi", () => {
  it("fetchHubActivity serializes filter parameters onto /api/v1/rooms/{id}/activity", async () => {
    let seenUrl = "";
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response(
        JSON.stringify({ room_id: "room-1", items: [], checkpoints: [], count: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await fetchHubActivity(
      "room-1",
      { actor: "0xabc", app: "gmail", status: "ok", limit: 50 },
      fakeFetch as any,
    );
    expect(res.room_id).toBe("room-1");
    expect(seenUrl).toContain("/api/v1/rooms/room-1/activity?");
    expect(seenUrl).toContain("actor=0xabc");
    expect(seenUrl).toContain("app=gmail");
    expect(seenUrl).toContain("status=ok");
    expect(seenUrl).toContain("limit=50");
  });

  it("fetchLocalActivity sends X-MAPR-Owner on loopback and degrades gracefully when unreachable", async () => {
    let seenHeaders: Headers | undefined;
    const okFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          ok: true,
          total: 1,
          entries: [],
          integrity: {
            ok: true,
            total_lines: 0,
            chained_entries: 0,
            legacy_unverified_entries: 0,
            malformed_lines: 0,
            head: null,
            issues: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const ok = await fetchLocalActivity(8791, { status: "ok" }, { fetchImpl: okFetch as any, seatId: "s1" });
    expect(ok.available).toBe(true);
    expect(seenHeaders?.get("X-MAPR-Owner")).toBe("1");

    const failFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const down = await fetchLocalActivity(8791, {}, { fetchImpl: failFetch as any });
    expect(down.available).toBe(false);
    if (!down.available) {
      expect(down.error).toContain("无法连接本机成员账本");
    }
  });

  it("mergeActivityFeeds deduplicates overlapping local/hub events, surfaces tamper issues, and preserves chronological order", () => {
    const hubFeed: HubActivityFeed = {
      room_id: "room-1",
      count: 3,
      checkpoints: [
        {
          id: "cp-1",
          stream_id: "0xagent",
          signer_address: "0xagent",
          head_seq: 1,
          head_hash: "a".repeat(64),
          entry_count: 1,
          signature: "0x" + "b".repeat(130),
          checkpoint_at: "2026-11-20T10:00:00.000Z",
          created_at: "2026-11-20T10:00:05.000Z",
        },
      ],
      items: [
        {
          id: "evt:owned-event",
          source: "activity",
          actor_kind: "agent",
          actor_id: "0xagent",
          kind: "action_finished",
          status: "ok",
          subject_id: "req-1",
          stream_seq: 1,
          created_at: "2026-11-20T10:00:00.000Z",
        },
        {
          id: "evt:other-seat-event",
          source: "activity",
          actor_kind: "agent",
          actor_id: "0xother",
          kind: "action_finished",
          status: "ok",
          subject_id: "req-1",
          stream_seq: 1,
          created_at: "2026-11-20T10:00:00.000Z",
        },
        {
          id: "task-1",
          source: "task_event",
          actor_kind: "agent",
          actor_id: "agent-1",
          kind: "task_completed",
          status: "completed",
          subject_id: "t-1",
          created_at: "2026-11-20T09:50:00.000Z",
        },
      ],
    };

    const localResults: LocalActivityResult[] = [
      {
        available: true,
        port: 8791,
        seatId: "seat-1",
        data: {
          ok: true,
          total: 2,
          entries: [
            {
              at: "2026-11-20T10:00:00.000Z",
              kind: "action_finished",
              request_id: "req-1",
              peer: "0xpeer",
              scope: "gmail.send",
              reason: "executed",
              payload_hash: null,
              seq: 1,
              activity_event_id: "owned-event",
              activity_status: "ok",
            },
            {
              at: "2026-11-20T10:05:00.000Z",
              kind: "request_denied",
              request_id: "req-2",
              peer: "0xpeer",
              scope: "payment.send",
              reason: "hard_cannot:payment.send",
              payload_hash: null,
              seq: 2,
            },
          ],
          integrity: {
            ok: false,
            total_lines: 3,
            chained_entries: 2,
            legacy_unverified_entries: 1,
            malformed_lines: 0,
            head: { seq: 2, entry_hash: "c".repeat(64) },
            issues: [{ code: "anchor_truncated", line: 2, detail: "truncated" }],
          },
        },
      },
    ];

    const merged = mergeActivityFeeds(hubFeed, localResults);
    expect(merged.items.map((i) => i.subject_id)).toEqual(["req-2", "req-1", "req-1", "t-1"]);
    expect(merged.items[1].source).toBe("local_ledger");
    expect(merged.items[1].app).toBe("gmail");
    expect(merged.items[2].id).toBe("activity-evt:other-seat-event");
    expect(merged.integrity.ok).toBe(false);
    expect(merged.integrity.issues).toEqual([{ code: "anchor_truncated", line: 2, detail: "truncated", port: 8791 }]);
    expect(merged.integrity.legacyUnverifiedCount).toBe(1);
    expect(merged.integrity.hubCheckpoints).toHaveLength(1);

    const gmailOnly = mergeActivityFeeds(hubFeed, localResults, { appFilter: "gmail" });
    expect(gmailOnly.items.map((i) => i.subject_id)).toEqual(["req-1"]);
    expect(inferAppFromScope("gmail.send")).toBe("gmail");
    expect(inferAppFromScope("calendar.free_busy")).toBe("calendar");
  });
});
