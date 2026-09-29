import assert from "node:assert/strict";
import test from "node:test";
import {
  allowOwnerNotesOrigin,
  createOwnerNotesServer,
  handleOwnerNotes,
  ownerNotesBindAddress,
} from "./ownerNotesHttp.ts";

test("returns saved notes for loopback and nothing else", async () => {
  const response = await handleOwnerNotes({
    host: "127.0.0.1",
    notes: [
      { self_name: "Codex", turns_seen: 2, action: "blocked", block_reason: "unapproved_day" },
    ],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.notes, [
    { self_name: "Codex", turns_seen: 2, action: "blocked", block_reason: "unapproved_day" },
  ]);
});

test("refuses a non-loopback host", async () => {
  const response = await handleOwnerNotes({
    host: "10.0.0.8",
    notes: [
      { self_name: "Codex", turns_seen: 1, action: "sent", block_reason: null },
    ],
  });
  assert.equal(response.status, 403);
  assert.deepEqual(response.body.notes, []);
});

test("bind address is loopback only", () => {
  assert.equal(ownerNotesBindAddress(), "127.0.0.1");
});

test("does not allow a public origin", () => {
  assert.equal(allowOwnerNotesOrigin("https://evil.example"), null);
  assert.equal(allowOwnerNotesOrigin("http://127.0.0.1:5173"), "http://127.0.0.1:5173");
});

test("GET /owner-notes serves notes via http on loopback", async () => {
  const server = createOwnerNotesServer(() => [
    { self_name: "Codex", turns_seen: 3, action: "sent", block_reason: null },
  ]);

  await new Promise<void>((resolve) => {
    server.listen(0, ownerNotesBindAddress(), () => resolve());
  });

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const port = address.port;

    const res = await fetch(`http://127.0.0.1:${port}/owner-notes`, {
      headers: { Origin: "http://127.0.0.1:5173" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    const body = await res.json();
    assert.deepEqual(body, {
      notes: [
        { self_name: "Codex", turns_seen: 3, action: "sent", block_reason: null },
      ],
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
