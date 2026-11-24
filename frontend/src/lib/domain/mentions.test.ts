import { describe, expect, it } from "vitest";
import { filterMentionCandidates, mentionCandidatesFrom, parseMentionQuery } from "./mentions";
import type { HubSeatView } from "../localHelper";

const seat: HubSeatView = {
  seat_id: "1", room_id: "room", agent_user_id: "agent", owner_user_id: "owner", agent_display_name: "Codex",
  kind: "codex", xmtp_address: "", group_status: "added",
};

describe("mentions", () => {
  it("parses a mention at the caret without matching an email or earlier input", () => {
    expect(parseMentionQuery("请 @Codex 继续", 6)).toEqual({ query: "Cod", start: 2, end: 6 });
    expect(parseMentionQuery("@")).toEqual({ query: "", start: 0, end: 1 });
    expect(parseMentionQuery("me@example")).toBeNull();
    expect(parseMentionQuery("@Codex ")).toBeNull();
  });

  it("retains paused names as disabled even when presence is stale and ignores removed seats", () => {
    const candidates = mentionCandidatesFrom([
      { ...seat, paused_at: "2026-11-25" },
      { ...seat, seat_id: "2", agent_display_name: "Muse", kind: "cloud-agent", source: "invite" },
      { ...seat, seat_id: "3", agent_display_name: "Gone", group_status: "removed" },
    ], [
      { sender_id: "agent", sender_name: "Codex", sender_type: "agent", joined_at: "", last_seen_at: "" },
      { sender_id: "human", sender_name: "王达", sender_type: "human", joined_at: "", last_seen_at: "" },
    ]);
    expect(candidates.map(({ name, actor, disabled }) => [name, actor, disabled])).toEqual([
      ["全体", "shortcut", false], ["Codex", "local", true], ["Muse", "cloud", false], ["王达", "human", false],
    ]);
    expect(filterMentionCandidates(candidates, "CoD")).toEqual([{ id: "1", name: "Codex", actor: "local", disabled: true }]);
  });
});
