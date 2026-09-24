import assert from "node:assert/strict";
import test from "node:test";
import { fetchHubGroupId, resolveGroupPlan } from "./groupPlan.ts";

const PEER = "0x1111111111111111111111111111111111111111";

test("env group id wins over everything", () => {
  assert.deepEqual(
    resolveGroupPlan({ envGroupId: "g-env", hubGroupId: "g-hub", peerAddresses: [PEER] }),
    { action: "use", groupId: "g-env", source: "env" }
  );
});

test("hub group id is reused instead of creating a new group", () => {
  assert.deepEqual(
    resolveGroupPlan({ hubGroupId: "g-hub", peerAddresses: [PEER] }),
    { action: "use", groupId: "g-hub", source: "hub" }
  );
});

test("creates only when nothing is bound and peers are configured", () => {
  assert.deepEqual(resolveGroupPlan({ hubGroupId: null, peerAddresses: [PEER] }), { action: "create" });
  assert.deepEqual(resolveGroupPlan({ peerAddresses: [] }), { action: "none" });
});

test("fetchHubGroupId reads room.xmtp_group_id with the bearer token", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const fakeFetch = (async (url: string, init: any) => {
    seenUrl = url;
    seenAuth = init.headers.Authorization;
    return new Response(JSON.stringify({ room: { id: "r1", xmtp_group_id: "g-1" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const id = await fetchHubGroupId({
    hubBaseUrl: "http://hub.local/",
    hubRoomId: "r1",
    hubToken: "tok",
    fetchImpl: fakeFetch,
  });
  assert.equal(id, "g-1");
  assert.equal(seenUrl, "http://hub.local/api/v1/rooms/r1");
  assert.equal(seenAuth, "Bearer tok");
});

test("fetchHubGroupId returns null when the room is not bound yet", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ room: { id: "r1", xmtp_group_id: null } }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(
    await fetchHubGroupId({ hubBaseUrl: "http://hub.local", hubRoomId: "r1", hubToken: "t", fetchImpl: fakeFetch }),
    null
  );
});

test("fetchHubGroupId throws on HTTP errors without echoing the token", async () => {
  const fakeFetch = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    fetchHubGroupId({ hubBaseUrl: "http://hub.local", hubRoomId: "r1", hubToken: "secret-token", fetchImpl: fakeFetch }),
    (err: Error) => err.message.includes("403") && !err.message.includes("secret-token")
  );
});
