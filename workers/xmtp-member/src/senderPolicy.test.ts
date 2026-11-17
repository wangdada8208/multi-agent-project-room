import assert from "node:assert/strict";
import test from "node:test";
import { GroupMemberCache, isAllowedSender, parseAllowedSenders } from "./senderPolicy.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

test("parses a comma list, lowercases it and drops malformed entries", () => {
  const list = parseAllowedSenders(` ${A.toUpperCase().replace("0X", "0x")} , not-an-address, ${B}`);
  assert.deepEqual(list, [A, B]);
});

test("empty or missing env gives an empty list", () => {
  assert.deepEqual(parseAllowedSenders(undefined), []);
  assert.deepEqual(parseAllowedSenders(""), []);
});

test("only listed senders are allowed", () => {
  assert.equal(isAllowedSender(A, [A]), true);
  assert.equal(isAllowedSender(A.toUpperCase().replace("0X", "0x"), [A]), true);
  assert.equal(isAllowedSender(B, [A]), false);
  assert.equal(isAllowedSender(undefined, [A]), false);
  assert.equal(isAllowedSender("", [A]), false);
});

function fakeGroup(members: string[], opts: { id?: string; fail?: () => boolean; calls?: { n: number } } = {}) {
  const calls = opts.calls ?? { n: 0 };
  return {
    id: opts.id ?? "group-1",
    calls,
    members: async () => {
      calls.n += 1;
      if (opts.fail?.()) throw new Error("members fetch failed");
      return members.map((identifier) => ({ accountIdentifiers: [{ identifier }] }));
    },
  };
}

test("group member cache allows members and caches the list", async () => {
  const cache = new GroupMemberCache(60_000);
  const group = fakeGroup([A]);
  assert.equal(await cache.allows(A, group), true);
  assert.equal(group.calls.n, 1);
  assert.equal(await cache.allows(A, group), true);
  assert.equal(group.calls.n, 1, "second lookup should be served from cache");
});

test("cache miss refreshes once, then denial sticks for non-members", async () => {
  const cache = new GroupMemberCache(60_000);
  const members = [A];
  const group = fakeGroup(members);
  assert.equal(await cache.allows(B, group), false);
  assert.equal(group.calls.n, 1);
  members.push(B);
  assert.equal(await cache.allows(B, group), true, "newly joined member should be found after refresh");
});

test("expired entries are refetched", async () => {
  const cache = new GroupMemberCache(0);
  const group = fakeGroup([A]);
  await cache.allows(A, group);
  await cache.allows(A, group);
  assert.equal(group.calls.n, 2, "ttl 0 forces a refetch each time");
});

test("members fetch failure denies without poisoning the cache", async () => {
  const cache = new GroupMemberCache(60_000);
  let fail = true;
  const group = fakeGroup([A], { fail: () => fail });
  assert.equal(await cache.allows(A, group), false);
  fail = false;
  assert.equal(await cache.allows(A, group), true);
});

test("non-group conversations are denied", async () => {
  const cache = new GroupMemberCache(60_000);
  assert.equal(await cache.allows(A, {}), false);
});
