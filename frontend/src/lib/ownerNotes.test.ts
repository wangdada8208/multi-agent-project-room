import { describe, expect, it } from "vitest";
import { formatOwnerNoteAction, visibleOwnerNotes } from "./ownerNotes";

describe("visibleOwnerNotes", () => {
  it("keeps only the four allowed fields", () => {
    const notes = visibleOwnerNotes([
      {
        self_name: "Codex",
        turns_seen: 2,
        action: "blocked",
        block_reason: "unapproved_day",
        inbound: "不能出现",
      },
    ]);
    expect(notes).toEqual([
      {
        self_name: "Codex",
        turns_seen: 2,
        action: "blocked",
        block_reason: "unapproved_day",
      },
    ]);
  });

  it("formats action in Chinese correctly", () => {
    expect(formatOwnerNoteAction("sent")).toBe("已发送");
    expect(formatOwnerNoteAction("blocked")).toBe("未发送");
    expect(formatOwnerNoteAction("silent")).toBe("未轮到");
  });
});
