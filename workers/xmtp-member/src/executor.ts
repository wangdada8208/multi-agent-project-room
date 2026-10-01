import type { ResultEnvelope, TaskEnvelope } from "./envelope.ts";

export function buildTaskPrompt(task: TaskEnvelope): string {
  const criteria = task.acceptance.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `你是一个执行者智能体。请针对以下任务目标给出高质量答复。`,
    `任务目标：${task.goal}`,
    `当前轮次：第 ${task.round} 轮`,
    `验收标准：`,
    criteria,
    `请提供清晰的总结与具体事实或论据支撑。输出格式可以直接为结果说明，或者形如 {"summary": "...", "evidence": ["..."]} 的 JSON。`,
  ].join("\n");
}

export function buildResult(
  task: TaskEnvelope,
  modelText: string,
  toAddress: string
): ResultEnvelope {
  let summary = modelText;
  let evidence: string[] = [];

  try {
    const parsed = JSON.parse(modelText);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.summary === "string") {
        summary = parsed.summary;
      }
      if (Array.isArray(parsed.evidence)) {
        evidence = parsed.evidence.filter((item: any): item is string => typeof item === "string");
      }
    }
  } catch {
    summary = modelText;
    evidence = [];
  }

  return {
    kind: "result",
    request_id: task.request_id,
    to: toAddress.toLowerCase(),
    round: task.round,
    summary: summary.slice(0, 2000),
    evidence: evidence.slice(0, 10).map((e) => e.slice(0, 500)),
  };
}
