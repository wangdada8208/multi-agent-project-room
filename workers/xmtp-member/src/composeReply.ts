export async function composeReply(input: {
  shouldReply: boolean;
  selfName: string;
  inbound: string;
  complete?: (prompt: string) => Promise<string>;
}): Promise<string | null> {
  if (!input.shouldReply) return null;
  const fallback = `收到，本轮由 ${input.selfName} 处理。`;
  if (!input.complete) return fallback;
  const prompt = [
    `你是 ${input.selfName}。`,
    "只根据下面这句话回复。不要声称已经访问 Hub 或数据库。",
    input.inbound,
  ].join("\n");
  const text = (await input.complete(prompt)).trim();
  return text.length > 0 ? text : fallback;
}
