import type { ResultEnvelope, TaskEnvelope } from "./envelope.ts";
import { teamConfigPromptBlock } from "./rulesEngine.ts";
import { trustFrame, type MessageSource } from "./trustFrame.ts";

export function buildTaskPrompt(task: TaskEnvelope, options?: {
  teamConfigMarkdown?: string; source?: MessageSource; verifiedOwner?: string;
}): string {
  const criteria = task.acceptance.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const teamBlock = teamConfigPromptBlock(options?.teamConfigMarkdown);
  return [
    `你是一个执行者智能体。请针对以下任务目标给出高质量答复。`,
    ...(teamBlock ? [teamBlock] : []),
    `当前轮次：第 ${task.round} 轮`,
    trustFrame(`任务目标：${task.goal}\n验收标准：\n${criteria}`,
      options?.source ?? { sender: "", role: "unknown", roomId: "", sentAt: "" }, options?.verifiedOwner),
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
