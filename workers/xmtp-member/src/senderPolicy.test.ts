import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedSender, parseAllowedSenders } from "./senderPolicy.ts";

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
