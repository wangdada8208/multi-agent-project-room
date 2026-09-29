import assert from "node:assert/strict";
import test from "node:test";
import { completeWithFetch } from "./modelComplete.ts";

test("posts the prompt and returns the text field", async () => {
  const seen: { authorization?: string; body?: string } = {};
  const text = await completeWithFetch({
    apiKey: "test-token",
    url: "https://model.example/complete",
    prompt: "只回复一句",
    fetchImpl: async (url, init) => {
      seen.authorization = (init?.headers as Record<string, string>).Authorization;
      seen.body = String(init?.body);
      assert.equal(url, "https://model.example/complete");
      return new Response(JSON.stringify({ text: "保持现有路径。" }), { status: 200 });
    },
  });
  assert.equal(text, "保持现有路径。");
  assert.equal(seen.authorization, "Bearer test-token");
  assert.equal(seen.body?.includes("test-token"), false);
});

test("throws error with status code only on non-200", async () => {
  await assert.rejects(
    async () => {
      await completeWithFetch({
        apiKey: "mock-key",
        url: "https://model.example/complete",
        prompt: "机密正文",
        fetchImpl: async () => new Response("Internal Server Error", { status: 500 }),
      });
    },
    (err: Error) => {
      assert.equal(err.message.includes("500"), true);
      assert.equal(err.message.includes("mock-key"), false);
      assert.equal(err.message.includes("机密正文"), false);
      return true;
    }
  );
});
