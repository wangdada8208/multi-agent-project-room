import { createHmac } from "node:crypto";
import { completeWithFetch } from "../modelComplete.ts";
import type { EngineConfig, ReplyEngine, ReplyRequest } from "./types.ts";

type HttpConfig<K extends "openai-compatible" | "webhook" | "http-model"> = Extract<EngineConfig, { kind: K }>;

const LOOPBACK_OPENAI_HTTP_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;

/**
 * 校验 OpenAI 兼容接口的基础地址：
 * 公网地址强制要求 https://（防止 API Key 明文传输），同时放行本机回环 http://（Ollama、vLLM、Muse 本地网关等）。
 */
export function isAllowedOpenAiBaseUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname || parsed.username || parsed.password) return false;
    if (parsed.protocol === "https:") return /^https:\/\//i.test(trimmed);
    if (parsed.protocol === "http:") return LOOPBACK_OPENAI_HTTP_RE.test(trimmed);
    return false;
  } catch {
    return false;
  }
}

/**
 * OpenAI 兼容接口（xAI Grok、Ollama 本机网关、以及任何兼容 /chat/completions 的 Agent）。
 * POST {baseUrl}/chat/completions，messages=[{role:"user",content:prompt}]，取 choices[0].message.content。
 * 出站地址必须是 https 或本机回环 http；错误信息里不得带上 apiKey 或响应原文。
 */
export function openAiCompatibleEngine(
  config: HttpConfig<"openai-compatible">,
  fetchImpl: typeof fetch = fetch
): ReplyEngine {
  return {
    kind: "openai-compatible",
    async reply(req: ReplyRequest): Promise<string> {
      const base = config.baseUrl.trim().replace(/\/+$/, "");
      if (!isAllowedOpenAiBaseUrl(base)) {
        throw new Error("openai-compatible baseUrl must be https or loopback http");
      }
      const url = `${base}/chat/completions`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: req.prompt }],
        }),
        signal: req.signal,
      });
      if (!res.ok) {
        throw new Error(`openai-compatible request failed with status ${res.status}`);
      }
      let data: any;
      try {
        data = await res.json();
      } catch {
        throw new Error(`openai-compatible response parse failed with status ${res.status}`);
      }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(`openai-compatible response missing choices[0].message.content with status ${res.status}`);
      }
      return content;
    },
  };
}

/**
 * 通用同步问答接口。
 * POST url，头部 X-MAPR-Signature = hex(HMAC-SHA256(secret, body))，body = {"prompt": "..."}；
 * 期望 200 {"text": "..."}。
 */
export function webhookEngine(
  config: HttpConfig<"webhook">,
  fetchImpl: typeof fetch = fetch
): ReplyEngine {
  return {
    kind: "webhook",
    async reply(req: ReplyRequest): Promise<string> {
      const body = JSON.stringify({ prompt: req.prompt });
      const signature = createHmac("sha256", config.secret).update(body).digest("hex");
      const res = await fetchImpl(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MAPR-Signature": signature,
        },
        body,
        signal: req.signal,
      });
      if (!res.ok) {
        throw new Error(`webhook request failed with status ${res.status}`);
      }
      let data: any;
      try {
        data = await res.json();
      } catch {
        throw new Error(`webhook response parse failed with status ${res.status}`);
      }
      if (!data || typeof data.text !== "string") {
        throw new Error(`webhook response missing text field with status ${res.status}`);
      }
      return data.text;
    },
  };
}

/** 旧通道，直接复用 modelComplete.ts 的 completeWithFetch，并把 signal 传给 fetch。 */
export function httpModelEngine(
  config: HttpConfig<"http-model">,
  fetchImpl: typeof fetch = fetch
): ReplyEngine {
  return {
    kind: "http-model",
    async reply(req: ReplyRequest): Promise<string> {
      return completeWithFetch({
        apiKey: config.apiKey,
        url: config.url,
        prompt: req.prompt,
        fetchImpl: (input, init) => fetchImpl(input, { ...init, signal: req.signal }),
      });
    },
  };
}

export const openaiCompatibleEngine = openAiCompatibleEngine;
