export function missingMembers(present: string[], wanted: string[]): string[] {
  const have = new Set(present.map((a) => a.toLowerCase()));
  const out: string[] = [];
  for (const raw of wanted) {
    const address = raw.toLowerCase();
    if (!have.has(address) && !out.includes(address)) out.push(address);
  }
  return out;
}
