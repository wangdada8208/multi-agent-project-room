const PREFIX = "MAPR1 ";

const DENIAL_LABEL: Record<string, string> = {
  out_of_scope: "超出授权范围",
  owner_denied: "主人拒绝",
  expired: "超时未批准",
};

function short(address: unknown): string {
  return typeof address === "string" && address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : "?";
}

export function describeEnvelope(text: string): string | null {
  if (!text.startsWith(PREFIX)) return null;
  let raw: any;
  try {
    raw = JSON.parse(text.slice(PREFIX.length));
  } catch {
    return "【无法识别的结构化消息】";
  }
  const range = raw?.constraints ? `${raw.constraints.date_from} 到 ${raw.constraints.date_to}` : "";
  switch (raw?.kind) {
    case "request":
      return `【请求】向 ${short(raw.to)} 申请 ${raw.scope}（${range}）`;
    case "consent_pending":
      return `【等待批准】${short(raw.to)} 的请求正在等对方主人批准`;
    case "denial":
      return `【拒绝】${DENIAL_LABEL[raw.reason] ?? raw.reason}`;
    case "disclosure": {
      if (raw?.payload?.scope === "email.receipt") {
        return `【已披露收据】发给 ${short(raw.to)}：${raw.payload.subject || "客票凭证"}`;
      }
      const count = Array.isArray(raw?.payload?.busy) ? raw.payload.busy.length : 0;
      return `【已披露】发给 ${short(raw.to)}：${raw?.payload?.date_from} 到 ${raw?.payload?.date_to} 共 ${count} 个忙碌时段`;
    }
    case "task":
      return `【派单】向 ${short(raw.to)} 派发任务：${raw.goal}（第 ${raw.round} 轮）`;
    case "result":
      return `【成果】向 ${short(raw.to)} 提交第 ${raw.round} 轮成果：${raw.summary?.slice(0, 40) || ""}`;
    case "verdict":
      return `【裁决】向 ${short(raw.to)} 裁决：${raw.accepted ? "验收通过" : "质疑 - " + (raw.challenge || "")}`;
    default:
      return "【无法识别的结构化消息】";
  }
}
