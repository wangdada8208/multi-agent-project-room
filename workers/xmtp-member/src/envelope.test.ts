import assert from "node:assert/strict";
import test from "node:test";
import { decodeEnvelope, encodeEnvelope, ENVELOPE_PREFIX, type RequestEnvelope } from "./envelope.ts";

const TO = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const request: RequestEnvelope = {
  kind: "request",
  request_id: "req-1",
  to: TO,
  scope: "calendar.free_busy",
  purpose: "约下周的会",
  constraints: { date_from: "2026-10-05", date_to: "2026-10-09" },
};

test("request round-trips through encode and decode", () => {
  const text = encodeEnvelope(request);
  assert.equal(text.startsWith(ENVELOPE_PREFIX), true);
  assert.deepEqual(decodeEnvelope(text), request);
});

test("plain chat text is not an envelope", () => {
  assert.equal(decodeEnvelope("@Codex 你好"), null);
  assert.equal(decodeEnvelope("MAPR1 not json"), null);
});

test("uppercase or malformed recipient is rejected", () => {
  const bad = encodeEnvelope({ ...request, to: TO.toUpperCase().replace("0X", "0x") });
  assert.equal(decodeEnvelope(bad), null);
});

test("bad date range is rejected", () => {
  const bad = encodeEnvelope({ ...request, constraints: { date_from: "tomorrow", date_to: "2026-10-09" } });
  assert.equal(decodeEnvelope(bad), null);
});

test("unknown kind and unknown denial reason are rejected", () => {
  assert.equal(decodeEnvelope(`${ENVELOPE_PREFIX}{"kind":"exec","request_id":"r","to":"${TO}"}`), null);
  assert.equal(
    decodeEnvelope(`${ENVELOPE_PREFIX}{"kind":"denial","request_id":"r","to":"${TO}","reason":"because"}`),
    null
  );
});

test("extra fields on a request are dropped", () => {
  const text = `${ENVELOPE_PREFIX}${JSON.stringify({ ...request, run: "rm -rf /" })}`;
  const decoded = decodeEnvelope(text) as any;
  assert.equal(decoded.run, undefined);
});
