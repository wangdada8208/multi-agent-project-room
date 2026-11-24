import { describe, expect, it } from "vitest";
import { lockedXmtpSession, xmtpSessionReducer as reduce, type XmtpSession } from "./xmtpSession";

describe("XMTP session", () => {
  const connecting: XmtpSession = { kind: "connecting" };
  it("unlocks, connects, detects membership and recovers from a lost stream", () => {
    const groupId = "group";
    expect(reduce(lockedXmtpSession, { type: "connect" })).toEqual(connecting);
    expect(reduce(connecting, { type: "groupMissing" })).toEqual({ kind: "noGroup" });
    const absent = reduce(connecting, { type: "notInGroup", groupId });
    expect(absent).toEqual({ kind: "notInGroup", groupId });
    const ready = reduce(absent, { type: "ready", groupId });
    expect(ready).toEqual({ kind: "ready", groupId });
    const failed = reduce(ready, { type: "failed", message: "stream lost" });
    expect(failed).toEqual({ kind: "error", message: "stream lost" });
    expect(reduce(failed, { type: "connect" })).toEqual(connecting);
    expect(reduce(ready, { type: "lock" })).toBe(lockedXmtpSession);
  });

  it("ignores group callbacks after locking", () => {
    expect(reduce(lockedXmtpSession, { type: "ready", groupId: "old" })).toBe(lockedXmtpSession);
    expect(reduce(lockedXmtpSession, { type: "failed", message: "old" })).toBe(lockedXmtpSession);
  });
});
