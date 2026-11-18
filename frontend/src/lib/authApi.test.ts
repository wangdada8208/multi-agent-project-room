import { describe, expect, it } from "vitest";

const memoryStorage = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => memoryStorage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memoryStorage.set(key, value);
  },
  removeItem: (key: string) => {
    memoryStorage.delete(key);
  },
  clear: () => memoryStorage.clear(),
  key: (index: number) => Array.from(memoryStorage.keys())[index] ?? null,
  get length() {
    return memoryStorage.size;
  },
} as Storage;

const {
  fetchAuthProviders,
  login,
  loginWithEmailCode,
  loginWithGoogle,
  registerWithEmail,
  sendEmailCode,
} = await import("./api");

describe("email & google auth api helpers", () => {
  it("fetches auth providers and falls back cleanly on non-ok", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          email_enabled: true,
          google_enabled: true,
          google_client_id: "cid-123",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const providers = await fetchAuthProviders();
      expect(providers).toEqual({
        email_enabled: true,
        google_enabled: true,
        google_client_id: "cid-123",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = (async () => new Response("error", { status: 503 })) as typeof fetch;
    try {
      const fallback = await fetchAuthProviders();
      expect(fallback).toEqual({
        email_enabled: false,
        google_enabled: false,
        google_client_id: "",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("posts sendEmailCode, registerWithEmail, loginWithEmailCode, and loginWithGoogle to expected endpoints", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(input).endsWith("/send-code")) {
        return new Response(
          JSON.stringify({ sent: true, expires_in: 600, cooldown_seconds: 60 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          user: { id: "u1", username: "alice", display_name: "Alice", user_type: "human" },
          access_token: "tok-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const sent = await sendEmailCode({ email: "alice@example.com", purpose: "register" });
      expect(sent.sent).toBe(true);

      const reg = await registerWithEmail({
        email: "alice@example.com",
        code: "123456",
        password: "Password123",
        display_name: "Alice",
      });
      expect(reg.access_token).toBe("tok-1");

      const otpLogin = await loginWithEmailCode({
        email: "alice@example.com",
        code: "654321",
      });
      expect(otpLogin.user.id).toBe("u1");

      const gLogin = await loginWithGoogle("eyJhbGciOiJSUzI1NiJ9.payload.sig");
      expect(gLogin.user.username).toBe("alice");

      expect(calls).toEqual([
        {
          url: "/api/v1/auth/email/send-code",
          method: "POST",
          body: { email: "alice@example.com", purpose: "register" },
        },
        {
          url: "/api/v1/auth/email/register",
          method: "POST",
          body: {
            email: "alice@example.com",
            code: "123456",
            password: "Password123",
            display_name: "Alice",
          },
        },
        {
          url: "/api/v1/auth/email/login",
          method: "POST",
          body: { email: "alice@example.com", code: "654321" },
        },
        {
          url: "/api/v1/auth/google",
          method: "POST",
          body: { credential: "eyJhbGciOiJSUzI1NiJ9.payload.sig" },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses backend detail strings, pydantic validation arrays, and translated errors", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "Invalid username or password" }), {
        status: 401,
      })) as typeof fetch;
    try {
      await expect(login({ username: "a@b.com", password: "bad" })).rejects.toThrow(
        "账号或密码错误，请重试",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          detail: [{ loc: ["body", "password"], msg: "String should have at least 8 characters" }],
        }),
        { status: 422 },
      )) as typeof fetch;
    try {
      await expect(
        registerWithEmail({
          email: "a@b.com",
          code: "123456",
          password: "123",
        }),
      ).rejects.toThrow("密码长度至少需要 8 位，请重新输入");
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "该邮箱已注册，请直接登录" }), {
        status: 409,
      })) as typeof fetch;
    try {
      await expect(
        sendEmailCode({ email: "a@b.com", purpose: "register" }),
      ).rejects.toThrow("该邮箱已注册，请直接登录");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
