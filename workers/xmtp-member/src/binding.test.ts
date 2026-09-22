import assert from "node:assert/strict";
import test from "node:test";
import { buildBindingPayload } from "./binding.ts";

test("binding payload has no message body", () => {
  const payload = buildBindingPayload({
    xmtpGroupId: "group-dev-4",
  });
  assert.deepEqual(payload, { xmtp_group_id: "group-dev-4" });
  assert.equal("content" in payload, false);
});
