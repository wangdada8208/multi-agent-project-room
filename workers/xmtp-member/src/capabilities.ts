const capabilities = ["mcp", "watch", "send", "notify"] as const;
type Capability = (typeof capabilities)[number];
export type MemberAccess = {
  caps: ReadonlySet<Capability>;
  mode: "active" | "watch";
};

export function memberAccess(raw = "", mode = "active"): MemberAccess {
  const caps = new Set<Capability>();
  for (const value of raw ? raw.split(",") : []) {
    const cap = capabilities.find((candidate) => candidate === value.trim());
    if (!cap) throw new Error("unknown_capability");
    caps.add(cap);
  }
  if (mode !== "active" && mode !== "watch") throw new Error("invalid_response_mode");
  if (mode === "watch" && !caps.has("watch")) throw new Error("capability_denied:watch");
  if (caps.has("send") && !caps.has("mcp")) throw new Error("capability_denied:mcp");
  return { caps, mode };
}
