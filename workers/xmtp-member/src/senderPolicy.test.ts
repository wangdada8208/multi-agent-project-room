import assert from "node:assert/strict";
import test from "node:test";
import {
  GroupMemberCache,
  isAllowedSender,
  isSenderAuthorized,
  parseAllowedSenders,
  type SenderAuthorizationDeps,
} from "./senderPolicy.ts";

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

function fakeRevocations(initial: string[] = []) {
  const keys = new Set(initial);
  return {
    keys,
    has: (address: string, conversationId: string) => keys.has(`${conversationId}:${address}`),
    remove: async (address: string, conversationId: string) => {
      keys.delete(`${conversationId}:${address}`);
    },
  };
}

function authDeps(overrides: Partial<SenderAuthorizationDeps> = {}): SenderAuthorizationDeps {
  return {
    allowedSenders: [A],
    allowGroupMembers: false,
    groupMembers: new GroupMemberCache(),
    revoked: fakeRevocations(),
    ...overrides,
  };
}

test("DM authorization never queries group members and ignores a group revocation", async () => {
  const conversation = fakeGroup([A], { id: "dm-1" });
  const revoked = fakeRevocations([`group-1:${A}`]);
  assert.equal(await isSenderAuthorized(
    { sender: A, isGroup: false, conversation },
    authDeps({ revoked })
  ), true);
  assert.equal(conversation.calls.n, 0);
});

test("an explicitly allowed group sender must still be a current member", async () => {
  const conversation = fakeGroup([B]);
  assert.equal(await isSenderAuthorized(
    { sender: A, isGroup: true, conversation },
    authDeps()
  ), false);
  assert.equal(conversation.calls.n, 1);
});

test("group member lookup failure fails closed even for an explicit whitelist entry", async () => {
  const conversation = fakeGroup([A], { fail: () => true });
  assert.equal(await isSenderAuthorized(
    { sender: A, isGroup: true, conversation },
    authDeps()
  ), false);
});

test("allowGroupMembers admits a current member without an explicit whitelist entry", async () => {
  const conversation = fakeGroup([A]);
  assert.equal(await isSenderAuthorized(
    { sender: A, isGroup: true, conversation },
    authDeps({ allowedSenders: [], allowGroupMembers: true })
  ), true);
});

test("an unauthorized group sender is rejected without a member lookup", async () => {
  const conversation = fakeGroup([A]);
  assert.equal(await isSenderAuthorized(
    { sender: B, isGroup: true, conversation },
    authDeps()
  ), false);
  assert.equal(conversation.calls.n, 0);
});

test("rejoining a group force-refreshes membership and clears only that group's revocation", async () => {
  const groupMembers = new GroupMemberCache();
  const conversation = fakeGroup([A]);
  await groupMembers.allows(A, conversation);
  const revoked = fakeRevocations([`group-1:${A}`, `other-group:${A}`]);
  assert.equal(await isSenderAuthorized(
    { sender: A, isGroup: true, conversation },
    authDeps({ groupMembers, revoked })
  ), true);
  assert.equal(conversation.calls.n, 2, "a revoked sender cannot be restored from a stale cache");
  assert.deepEqual([...revoked.keys], [`other-group:${A}`]);
});

test("an absent sender stays revoked and a failed revocation update fails closed", async () => {
  const revoked = fakeRevocations([`group-1:${A}`]);
  assert.equal(await isSenderAuthorized(
    { sender: A, isGroup: true, conversation: fakeGroup([B]) },
    authDeps({ revoked })
  ), false);
  assert.deepEqual([...revoked.keys], [`group-1:${A}`]);

  assert.equal(await isSenderAuthorized(
    { sender: A, isGroup: true, conversation: fakeGroup([A]) },
    authDeps({
      revoked: {
        has: () => true,
        remove: async () => {
          throw new Error("disk failed");
        },
      },
    })
  ), false);
});

test("malformed group member rows deny authorization instead of trusting a partial list", async () => {
  const conversation = {
    id: "group-1",
    members: async () => [
      { accountIdentifiers: [{ identifier: A }] },
      { accountIdentifiers: [] },
    ],
  };
  assert.equal(await isSenderAuthorized(
    { sender: A, isGroup: true, conversation },
    authDeps()
  ), false);
});

test("in-flight cache invalidation denies stale authorization and preserves revocation", async () => {
  const groupMembers = new GroupMemberCache(60_000);
  const revoked = fakeRevocations([`group-1:${A}`]);
  let releaseMembers!: () => void;
  const membersReady = new Promise<void>((resolve) => {
    releaseMembers = resolve;
  });
  let started!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let callCount = 0;
  const conversation = {
    id: "group-1",
    members: async () => {
      callCount += 1;
      if (callCount === 1) {
        started();
        await membersReady;
        return [{ accountIdentifiers: [{ identifier: A }] }];
      }
      return [{ accountIdentifiers: [{ identifier: B }] }];
    },
  };

  const pendingAuth = isSenderAuthorized(
    { sender: A, isGroup: true, conversation },
    authDeps({ groupMembers, revoked })
  );
  await lookupStarted;
  groupMembers.invalidate("group-1");
  releaseMembers();

  assert.equal(await pendingAuth, false);
  assert.equal(revoked.has(A, "group-1"), true);
  assert.equal(await groupMembers.allows(A, conversation), false);
});

test("non-boolean isGroup values such as undefined fail closed even for allowed senders", async () => {
  const conversation = fakeGroup([A]);
  assert.equal(await isSenderAuthorized(
    { sender: A, isGroup: undefined, conversation },
    authDeps()
  ), false);
  assert.equal(conversation.calls.n, 0);
});
