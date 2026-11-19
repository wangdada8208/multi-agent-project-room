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
  // 末尾点（"localhost."）是合法 FQDN 写法，部分浏览器与 mDNS 环境会带上它。
  const h = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (h === "localhost" || h === "::1") return true;
  // 整个 127.0.0.0/8 都是回环；浏览器实际只用 127.0.0.1，但放行整段不影响
  // DNS 重绑定防护（拦的是非 127/8 主机名）。
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
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
