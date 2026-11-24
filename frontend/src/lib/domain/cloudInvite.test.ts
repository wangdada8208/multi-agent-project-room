import { describe, expect, it } from "vitest";
import { cloudInviteName, cloudInviteReducer as reduce, rememberCloudInviteName, type CloudInvite } from "./cloudInvite";
import { cloudAgentConnectCommand } from "../agentPresets";

const token = "sample";
const command = { hubOrigin: "https://hub.example", inviteUrl: "https://hub.example/rooms/room?invite=sample", title: "Muse", env: "local" } as const;
const idle: CloudInvite = { kind: "idle" };
const generating = reduce(idle, { type: "generate" });
const ready = reduce(generating, { type: "generated", token, command });

describe("cloud invite", () => {
  it("generates the original command and tracks copy and pending states", () => {
    expect(generating).toEqual({ kind: "generating" });
    expect(ready).toEqual({ kind: "ready", token, command: cloudAgentConnectCommand(command) });
    const copied = reduce(ready, { type: "copied", token });
    expect(copied).toEqual({ ...ready, kind: "copied" });
    expect(reduce(copied, { type: "pending", token })).toEqual({ ...ready, kind: "pending" });
  });

  it.each(["approved", "denied", "expired"] as const)("settles in %s and ignores stale polling", (kind) => {
    const settled = reduce(reduce(ready, { type: "pending", token }), { type: kind, token });
    expect(settled).toEqual({ ...ready, kind });
    expect(reduce(settled, { type: "pending", token })).toBe(settled);
    expect(reduce(settled, { type: "reset" })).toEqual(idle);
  });

  it("handles generation failure and ignores another token", () => {
    expect(reduce(generating, { type: "generationFailed" })).toEqual(idle);
    expect(reduce(ready, { type: "pending", token: "different" })).toBe(ready);
    expect(reduce(ready, { type: "generated", token, command })).toBe(ready);
  });

  it("associates each invite with only its preset in session storage and tolerates unavailable storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    rememberCloudInviteName(token, "Muse", storage);
    expect(cloudInviteName(token, storage)).toBe("Muse");
    expect(cloudInviteName("different", storage)).toBeNull();
    const disabled = {
      getItem: () => { throw new Error("storage blocked"); },
      setItem: () => { throw new Error("storage blocked"); },
    };
    expect(() => rememberCloudInviteName(token, "Muse", disabled)).not.toThrow();
    expect(cloudInviteName(token, disabled)).toBeNull();
  });
});
