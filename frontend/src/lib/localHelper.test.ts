import { describe, expect, it } from "vitest";
import {
  HELPER_ORIGIN,
  helperHandoffUrl,
  probeHelper,
} from "./localHelper";

const HELLO = {
  app: "mapr-helper",
  version: "0.1.0",
  paired: true,
  hub_origin: "https://hub.wangdada8208.xyz",
  owner_display_name: "主人",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("probeHelper", () => {
  it("returns running when hello answers with app=mapr-helper", async () => {
    const probe = await probeHelper(async () => jsonResponse(HELLO));
    expect(probe).toEqual({ state: "running", hello: HELLO });
  });

  it("requests the helper hello endpoint on 127.0.0.1:8790", async () => {
    let seen = "";
    await probeHelper(async (input) => {
      seen = String(input);
      return jsonResponse(HELLO);
    });
    expect(seen).toBe(`${HELPER_ORIGIN}/api/hello`);
  });

  it("returns not-running when the endpoint answers a non-200 status", async () => {
    const probe = await probeHelper(async () => jsonResponse({ detail: "nope" }, 503));
    expect(probe).toEqual({ state: "not-running" });
  });

  it("returns not-running when a different app occupies the port", async () => {
    const probe = await probeHelper(async () => jsonResponse({ app: "other", hello: true }));
    expect(probe).toEqual({ state: "not-running" });
  });

  it("returns not-running when the response is not valid JSON", async () => {
    const probe = await probeHelper(async () => new Response("<html>hi</html>", { status: 200 }));
    expect(probe).toEqual({ state: "not-running" });
  });

  it("returns not-running on generic network errors (e.g. timeout abort)", async () => {
    const probe = await probeHelper(async () => {
      throw new Error("network error");
    });
    expect(probe).toEqual({ state: "not-running" });
    const aborted = await probeHelper(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    expect(aborted).toEqual({ state: "not-running" });
  });

  it("returns blocked when fetch rejects with TypeError (browser block or refused)", async () => {
    const probe = await probeHelper(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(probe).toEqual({ state: "blocked" });
  });
});

describe("helperHandoffUrl", () => {
  it("encodes a pairing code into the local page hash", () => {
    expect(helperHandoffUrl({ pair: "mpc_abc.def" })).toBe(
      `${HELPER_ORIGIN}/#pair=mpc_abc.def`,
    );
  });

  it("encodes ticket and agent key for the join fallback", () => {
    expect(helperHandoffUrl({ ticket: "mjt_x.y", agentKey: "codex" })).toBe(
      `${HELPER_ORIGIN}/#ticket=mjt_x.y&agent=codex`,
    );
  });

  it("percent-escapes characters that would break hash parsing", () => {
    const url = helperHandoffUrl({ ticket: "a&b#c%d e", agentKey: "manual:1234" });
    expect(url).not.toContain("#c");
    const hash = new URL(url).hash.slice(1);
    const params = new URLSearchParams(hash);
    expect(params.get("ticket")).toBe("a&b#c%d e");
    expect(params.get("agent")).toBe("manual:1234");
  });

  it("round-trips pair codes containing reserved characters", () => {
    const url = helperHandoffUrl({ pair: "mpc_a+b=c&d" });
    const params = new URLSearchParams(new URL(url).hash.slice(1));
    expect(params.get("pair")).toBe("mpc_a+b=c&d");
  });
});
