import { KNOWN_SCOPES } from "./envelope.ts";

export interface ConnectRequest {
  app_id: string;
  scope: string;
  purpose: string;
  redirect_uri?: string;
  constraints?: any;
}

export type ParseConnectResult =
  | { ok: true; request: ConnectRequest }
  | { ok: false; reason: "missing_app_id" | "unknown_scope" | "missing_purpose" | "invalid_url" };

export function validConnectRedirect(raw: unknown): boolean {
  if (raw === undefined || raw === "") return true;
  if (typeof raw !== "string" || raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    return !url.username && !url.password && !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" &&
       ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}

export function buildConnectAuthorizeUrl(baseUrl: string, req: ConnectRequest): string {
  const normBase = baseUrl.replace(/\/$/, "");
  const url = new URL(`${normBase}/connect/authorize`);
  url.searchParams.set("app_id", req.app_id);
  url.searchParams.set("scope", req.scope);
  url.searchParams.set("purpose", req.purpose);
  if (req.redirect_uri) {
    url.searchParams.set("redirect_uri", req.redirect_uri);
  }
  if (req.constraints) {
    url.searchParams.set("constraints", JSON.stringify(req.constraints));
  }
  return url.toString();
}

export function parseConnectRequestFromUrl(rawUrl: string): ParseConnectResult {
  try {
    const url = new URL(rawUrl);
    const appId = url.searchParams.get("app_id")?.trim();
    if (!appId) return { ok: false, reason: "missing_app_id" };

    const scope = url.searchParams.get("scope")?.trim() || "";
    if (!(KNOWN_SCOPES as readonly string[]).includes(scope) || scope === "task.run") {
      return { ok: false, reason: "unknown_scope" };
    }

    const purpose = url.searchParams.get("purpose")?.trim();
    if (!purpose) return { ok: false, reason: "missing_purpose" };

    const redirectUri = url.searchParams.get("redirect_uri")?.trim() || undefined;
    if (!validConnectRedirect(redirectUri)) return { ok:false, reason:"invalid_url" };
    let constraints: any = undefined;
    const rawConstraints = url.searchParams.get("constraints");
    if (rawConstraints) {
      try {
        constraints = JSON.parse(rawConstraints);
      } catch {
        // Ignore JSON error and leave undefined
      }
    }

    return {
      ok: true,
      request: {
        app_id: appId,
        scope,
        purpose,
        redirect_uri: redirectUri,
        constraints,
      },
    };
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
}
