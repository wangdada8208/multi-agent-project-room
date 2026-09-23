import assert from "node:assert/strict";
import test from "node:test";
import { filterOutbound } from "./outboundFilter.ts";

test("redacts a private keyword and allows an approved day", () => {
  const result = filterOutbound({
    content: "周三 14:00 可以，地点在秘密会议室",
    approvedDays: ["wed"],
    sensitiveKeywords: ["秘密会议室"],
  });
  assert.equal(result.blocked, false);
  assert.equal(result.text.includes("秘密会议室"), false);
  assert.equal(result.text.includes("[REDACTED]"), true);
});

test("blocks an unapproved weekday", () => {
  const result = filterOutbound({
    content: "周五下午可以",
    approvedDays: ["wed"],
    sensitiveKeywords: [],
  });
  assert.equal(result.blocked, true);
  assert.equal(result.text, null);
});
