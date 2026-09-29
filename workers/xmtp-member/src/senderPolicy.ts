export function parseAllowedSenders(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}

export function isAllowedSender(
  sender: string | undefined | null,
  allowed: string[]
): boolean {
  if (!sender) return false;
  return allowed.includes(sender.toLowerCase());
}
