import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedOpenAiBaseUrl, openAiCompatibleEngine } from "./httpEngines.ts";

test("isAllowedOpenAiBaseUrl allows https and loopback http while rejecting remote http", () => {
  for (const ok of [
    "https://api.x.ai/v1",
    "https://api.openai.com/v1/",
    "http://127.0.0.1:11434/v1",
    "http://127.0.0.1:8080/v1",
    "http://localhost:11434/v1",
    "http://LOCALHOST:8000",
    "http://[::1]:11434/v1",
    "http://127.0.0.1",
  ]) {
    assert.equal(isAllowedOpenAiBaseUrl(ok), true, `expected allowed: ${ok}`);
  }

  for (const bad of [
    "",
    "   ",
    "https://",
    "http://api.x.ai/v1",
    "http://192.168.1.10:11434/v1",
    "http://10.0.0.5:8080/v1",
    "http://127.0.0.1.evil.com/v1",
    "http://localhost.evil.com/v1",
    "http://127.0.0.1:80@evil.com/v1",
    "ftp://127.0.0.1:11434/v1",
  ]) {
    assert.equal(isAllowedOpenAiBaseUrl(bad), false, `expected rejected: ${bad}`);
  }
});

test("openAiCompatibleEngine accepts loopback http for local Ollama/Muse gateways", async () => {
  for (const baseUrl of [
    "http://127.0.0.1:11434/v1",
    "http://localhost:8080/v1/",
    "http://[::1]:11434/v1",
  ]) {
    let seenUrl = "";
    const engine = openAiCompatibleEngine(
      {
        kind: "openai-compatible",
        baseUrl,
        apiKey: "ollama",
        model: "qwen2.5:14b",
        timeoutMs: 5_000,
      },
      (async (input: any) => {
        seenUrl = String(input);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "local-ok" } }] }),
          { status: 200 }
        );
      }) as typeof fetch
    );
    const reply = await engine.reply({ prompt: "ping", signal: AbortSignal.timeout(5_000) });
    assert.equal(reply, "local-ok");
    assert.ok(seenUrl.endsWith("/v1/chat/completions"));
  }
});

test("openAiCompatibleEngine rejects non-loopback http baseUrl", async () => {
  const engine = openAiCompatibleEngine({
    kind: "openai-compatible",
    baseUrl: "http://example.com/v1",
    apiKey: "secret",
    model: "m",
    timeoutMs: 5_000,
  });
  await assert.rejects(
    () => engine.reply({ prompt: "ping", signal: AbortSignal.timeout(5_000) }),
    /must be https/
  );
});
