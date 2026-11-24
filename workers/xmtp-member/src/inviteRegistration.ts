import type { LocalAccount } from "viem/accounts";

const JOIN_REQUEST_TIMEOUT_MS = 15_000;

interface HubCallResult {
  status: number;
  body: Record<string, unknown> | null;
}

/** Hub JSON 调用，网络错误收敛为 status 0。 */
export async function joinHubCall(
  fetchImpl: typeof fetch,
  base: string,
  apiPath: string,
  request: { method: "GET"; headers: HeadersInit } | { method: "POST"; body: unknown },
  signal?: AbortSignal
): Promise<HubCallResult> {
  const timeout = AbortSignal.timeout(JOIN_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${base}${apiPath}`, {
      method: request.method,
      headers: request.method === "POST" ? { "Content-Type": "application/json" } : request.headers,
      body: request.method === "POST" ? JSON.stringify(request.body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
  } catch {
    return { status: 0, body: null };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const data = await res.json();
    if (data && typeof data === "object" && !Array.isArray(data)) parsed = Object.fromEntries(Object.entries(data));
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/** 邀请输入：完整 URL（/rooms/<id>?invite=<token> 或 /invite(s)/<token> 风格路径）或裸 token；URL 顺带给出 Hub 源站。 */
export function parseInviteInput(raw: string): { token: string; origin: string | null } {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try { url = new URL(s); } catch { throw new Error("invalid_invite_url"); }
    const token = (url.searchParams.get("invite") ?? url.searchParams.get("token") ?? "").trim();
    if (token) return { token, origin: url.origin };
    const m = url.pathname.match(/\/(invites?|join)\/([^/?#]+)/i);
    if (m?.[2]) return { token: decodeURIComponent(m[2]), origin: url.origin };
    throw new Error("invite_token_not_found");
  }
  if (!s) throw new Error("invite_required");
  return { token: s, origin: null };
}

/** 领一个服务器一次性 nonce，按后端返回的 message 原文做 EIP-191 签名。 */
export async function signedProof(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  account: LocalAccount,
  signal?: AbortSignal
): Promise<{ nonce: string; signature: string }> {
  const res = await joinHubCall(fetchImpl, base, "/api/v1/invites/nonce", {
    method: "POST",
    body: {
      action: "invite-agent-register",
      resource: token,
      address: account.address.toLowerCase(),
    },
  }, signal);
  if (res.status !== 200 && res.status !== 201) throw new Error(`nonce_failed:${res.status}`);
  const nonce = res.body?.nonce;
  const message = res.body?.message;
  if (typeof nonce !== "string" || !nonce || typeof message !== "string" || !message) {
    throw new Error("bad_nonce_response");
  }
  const signature = await account.signMessage({ message });
  return { nonce, signature };
}
