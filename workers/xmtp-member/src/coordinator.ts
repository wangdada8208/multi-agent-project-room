import type { ResultEnvelope, TaskEnvelope } from "./envelope.ts";

export interface VerdictOutcome {
  accepted: boolean;
  challenge: string;
}

export function buildVerdictPrompt(task: TaskEnvelope, result: ResultEnvelope): string {
  const criteria = task.acceptance.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const evidenceList = result.evidence.length > 0
    ? result.evidence.map((e, i) => `  - 证据${i + 1}: ${e}`).join("\n")
    : "  无直接论据";

  return [
    `你是一个协调者智能体验收官。请根据任务目标和验收标准，严格审核执行者提交的结果。`,
    `任务目标：${task.goal}`,
    `当前轮次：第 ${task.round} 轮`,
    `验收标准：`,
    criteria,
    `执行者总结：`,
    result.summary,
    `执行者论据：`,
    evidenceList,
    `请对执行结果是否完全满足验收标准进行裁决。`,
    `如果完全满足，accepted 为 true，challenge 必须为空字符串。`,
    `如果有任何一项未满足，accepted 为 false，并在 challenge 中详细说明具体的不足与修改意见（最多500字）。`,
    `必须输出严格的 JSON 格式：{"accepted": true|false, "challenge": "..."}，不要输出其他无关文字。`,
  ].join("\n");
}

export function parseVerdict(modelText: string): VerdictOutcome | null {
  try {
    let jsonStr = modelText.trim();
    // 兼容被 ```json ... ``` 包裹的情况
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    }
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.accepted !== "boolean") return null;

    if (parsed.accepted) {
      return {
        accepted: true,
        challenge: "",
      };
    }

    if (typeof parsed.challenge !== "string" || parsed.challenge.trim().length === 0) {
      return null;
    }

    return {
      accepted: false,
      challenge: parsed.challenge.slice(0, 500),
    };
  } catch {
    return null;
  }
}

export function nextStep(
  task: TaskEnvelope,
  verdict: { accepted: boolean; challenge?: string }
): "done" | "retry" | "escalate" {
  if (verdict.accepted) {
    return "done";
  }
  if (task.round < 3) {
    return "retry";
  }
  return "escalate";
}
