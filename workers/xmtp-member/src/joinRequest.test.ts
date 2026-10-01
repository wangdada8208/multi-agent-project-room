import assert from "node:assert/strict";
import test from "node:test";
import { applyJoinApproval, buildJoinRequest } from "./joinRequest.ts";
import { normalizePolicy, type Policy } from "./policy.ts";

const CANDIDATE = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

test("buildJoinRequest creates valid join request and lowercases address", () => {
  const req = buildJoinRequest(CANDIDATE.toUpperCase().replace("0X", "0x"), ["task.run", "calendar.free_busy"]);
  assert.equal(req.ok, true);
  if (!req.ok) return;
  assert.equal(req.request.candidate, CANDIDATE);
  assert.deepEqual(req.request.proposed_scopes, ["task.run", "calendar.free_busy"]);
});

test("buildJoinRequest rejects invalid candidate address", () => {
  const req = buildJoinRequest("invalid-address", ["task.run"]);
  assert.equal(req.ok, false);
});

test("applyJoinApproval adds only approved scopes and does not mutate existing policy", () => {
  const basePolicy: Policy = normalizePolicy({
    allow: {
      "0x70997970c51812dc3a010c7d01b50e0d17dc79c8": ["calendar.free_busy"],
    },
    max_range_days: 14,
  });

  // 候选人请求了 task.run 和 calendar.free_busy，主人在审批时只勾选了 task.run
  const candidateProposed = ["task.run", "calendar.free_busy"];
  const ownerApproved = ["task.run"];

  const updatedPolicy = applyJoinApproval(basePolicy, CANDIDATE, ownerApproved);

  // 原 policy 未被修改
  assert.equal(basePolicy.allow[CANDIDATE], undefined);

  // 仅加入批准的范围，不包含候选人自己提议但被主人删去的 calendar.free_busy
  assert.deepEqual(updatedPolicy.allow[CANDIDATE], ["task.run"]);
  assert.equal(updatedPolicy.allow[CANDIDATE].includes("calendar.free_busy"), false);

  // 既有成员权限保持不变
  assert.deepEqual(updatedPolicy.allow["0x70997970c51812dc3a010c7d01b50e0d17dc79c8"], ["calendar.free_busy"]);
});
