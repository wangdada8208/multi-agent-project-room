import { describe, expect, it } from "vitest";
import { tabVisibleInRoom, type RoomTabId } from "./roomTabs";

const ALL_TABS: RoomTabId[] = [
  "members",
  "tasks",
  "dialogue",
  "files",
  "permissions",
  "approvals",
  "activity",
];

describe("tabVisibleInRoom", () => {
  it("hides the files tab in encrypted rooms", () => {
    expect(tabVisibleInRoom("files", true)).toBe(false);
  });

  it("keeps every tab in plaintext rooms", () => {
    for (const tab of ALL_TABS) {
      expect(tabVisibleInRoom(tab, false)).toBe(true);
    }
  });

  it("keeps non-file tabs in encrypted rooms", () => {
    for (const tab of ALL_TABS.filter((t) => t !== "files")) {
      expect(tabVisibleInRoom(tab, true)).toBe(true);
    }
  });
});
