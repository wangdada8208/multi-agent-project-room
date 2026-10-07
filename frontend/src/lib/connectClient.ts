export interface ConnectClientRequest {
  appId: string;
  scope: string;
  purpose: string;
  redirectUri?: string;
  constraints?: Record<string, unknown>;
}

export interface ConnectCallbackSuccess {
  ok: true;
  grant: unknown;
  signature: string;
  payload: unknown;
}

export interface ConnectCallbackError {
  ok: false;
  error: string;
}

export type ConnectCallbackResult = ConnectCallbackSuccess | ConnectCallbackError;

export function buildConnectUrl(baseUrl: string, req: ConnectClientRequest): string {
  const normBase = baseUrl.replace(/\/$/, "");
  const url = new URL(`${normBase}/connect/authorize`);
  url.searchParams.set("app_id", req.appId);
  url.searchParams.set("scope", req.scope);
  url.searchParams.set("purpose", req.purpose);
  if (req.redirectUri) {
    url.searchParams.set("redirect_uri", req.redirectUri);
  }
  if (req.constraints) {
    url.searchParams.set("constraints", JSON.stringify(req.constraints));
  }
  return url.toString();
}

export function parseConnectCallback(hashString: string): ConnectCallbackResult {
  const hash = hashString.startsWith("#") ? hashString.slice(1) : hashString;
  const params = new URLSearchParams(hash);

  const error = params.get("error");
  if (error) {
    return { ok: false, error };
  }

  const rawGrant = params.get("grant");
  const signature = params.get("signature") || "";
  const rawData = params.get("data");

  if (!rawGrant || !rawData) {
    return { ok: false, error: "missing_callback_data" };
  }

  try {
    const grant = JSON.parse(decodeURIComponent(rawGrant));
    const payload = JSON.parse(decodeURIComponent(rawData));
    return {
      ok: true,
      grant,
      signature,
      payload,
    };
  } catch {
    return { ok: false, error: "invalid_json_payload" };
  }
}
