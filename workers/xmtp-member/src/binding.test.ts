import assert from "node:assert/strict";
import test from "node:test";
import { bindGroupToHub } from "./index.ts";

test("binding sends only the group ID as room metadata", async (t) => {
  const fetcher = t.mock.method(globalThis, "fetch", async () => Response.json({}));

  await bindGroupToHub("https://hub.example/", "r1", "fixture-token", "group-dev-4");

  assert.equal(fetcher.mock.callCount(), 1);
  const [url, init] = fetcher.mock.calls[0].arguments;
  assert.equal(url, "https://hub.example/api/v1/rooms/r1/xmtp-binding");
  assert.equal(init?.method, "POST");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer fixture-token");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(init?.body, JSON.stringify({ xmtp_group_id: "group-dev-4" }));
});
