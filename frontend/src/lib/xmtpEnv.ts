export type XmtpEnv = "dev" | "production" | "local";

export function xmtpEnvFromVite(raw: string | undefined): XmtpEnv {
  const value = (raw || "").trim();
  if (value === "production" || value === "local") return value;
  return "dev";
}
