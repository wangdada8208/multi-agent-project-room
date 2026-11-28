import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RoomInbox, routeLiveMessage, type RoomMessage } from "./roomInbox.ts";

function message(id: string): RoomMessage {
  return { id, text: "parlor-untrusted>>>", source: { roomId: "r", sender: "peer",
    role: "agent", seat: "Peer", sentAt: "2026-11-28T00:00:00Z" } };
}

test("watch receives without dispatching, and active dispatch is fenced across restart", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "parlor-inbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "inbox.json");
  let inbox = await RoomInbox.open(file);
  let replies = 0;
  const dispatch = async () => { replies++; };
  await routeLiveMessage({ inbox, id: "a", message: message("a"), mode: "watch", dispatch });
  assert.equal(replies, 0);
  assert.match(inbox.summary()[0].frame, /^<<<parlor-untrusted\n/);
  const active = () => routeLiveMessage({ inbox, id: "b", message: message("b"), mode: "active", dispatch });
  await Promise.all([active(), active()]);
  assert.equal(replies, 1);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  inbox = await RoomInbox.open(file);
  await active();
  assert.equal(replies, 1);
  await inbox.restore([message("b"), message("c")]);
  assert.equal(inbox.status.unread, 3);
  const peek = await inbox.read({ peek: true, limit: 1 });
  assert.equal(peek.cursor, 1);
  assert.equal(peek.acknowledged, 0);
  await assert.rejects(inbox.ack(1), /invalid_cursor/);
  const first = await inbox.read({ limit: 1 });
  assert.equal(await inbox.ack(first.cursor), 1);
  inbox = await RoomInbox.open(file);
  const next = await inbox.read();
  assert.deepEqual(next.messages.map(({ id }) => id), ["b", "c"]);
  assert.equal(next.acknowledged, 1);
});

test("long wait wakes on an appended message and acknowledges once", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "parlor-inbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inbox = await RoomInbox.open(path.join(dir, "inbox.json"));
  const signal = new AbortController();
  const waiting = inbox.wait({ ack: true }, 3000, signal.signal);
  await inbox.claim("a", message("a"));
  assert.equal((await waiting).messages[0].id, "a");
  assert.equal(inbox.status.cursor, 1);
  assert.deepEqual((await inbox.wait({}, 0, signal.signal)).messages, []);
  const cancelled = inbox.wait({}, 3000, signal.signal);
  signal.abort();
  await assert.rejects(cancelled, /wait_cancelled/);
});
