import assert from "node:assert/strict";
import test from "node:test";
import { missingMembers } from "./groupMembers.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

test("only addresses not already in the group are returned, once each", () => {
  assert.deepEqual(missingMembers([A], [A.toUpperCase().replace("0X", "0x"), B, B]), [B]);
  assert.deepEqual(missingMembers([A, B], [A, B]), []);
  assert.deepEqual(missingMembers([], []), []);
});
