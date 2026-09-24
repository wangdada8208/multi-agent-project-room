import { describe, expect, it } from "vitest";
import { xmtpEnvFromVite } from "./xmtpEnv";

describe("xmtpEnvFromVite", () => {
  it("defaults to dev", () => {
    expect(xmtpEnvFromVite(undefined)).toBe("dev");
    expect(xmtpEnvFromVite("")).toBe("dev");
    expect(xmtpEnvFromVite("prod")).toBe("dev");
  });

  it("accepts production and local", () => {
    expect(xmtpEnvFromVite("production")).toBe("production");
    expect(xmtpEnvFromVite(" local ")).toBe("local");
  });
});
