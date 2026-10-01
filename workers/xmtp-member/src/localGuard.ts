export const OWNER_HEADER = "x-mapr-owner";

function hostnameOf(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 0 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(":")[0];
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function checkLocalRequest(input: {
  method: string;
  host?: string | null;
  origin?: string | null;
  ownerHeader?: string | null;
}): boolean {
  if (!input.host || !isLoopbackHostname(hostnameOf(input.host))) return false;
  if (input.origin) {
    try {
      const url = new URL(input.origin);
      if (!isLoopbackHostname(url.hostname.replace(/^\[|\]$/g, ""))) return false;
    } catch {
      return false;
    }
  }
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    if (input.ownerHeader !== "1") return false;
  }
  return true;
}
