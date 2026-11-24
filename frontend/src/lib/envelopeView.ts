const PREFIX = "MAPR1 ";

const DENIAL_LABEL: Record<string, string> = {
  out_of_scope: "超出授权范围",
  owner_denied: "主人拒绝",
  expired: "超时未批准",
  cannot: "规则禁止",
  busy: "对方待批队列已满，请稍后重试",
};

const ACTION_STATUS_LABEL: Record<string, string> = {
  executed: "已执行",
  failed: "执行失败",
  uncertain: "结果不明（未自动重试）",
};

function short(address: unknown): string {
  return typeof address === "string" && address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : "?";
}

function record(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" ? { ...input } : {};
}

function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function labelFor(labels: Record<string, string>, value: unknown) {
  if (typeof value !== "string") return "未知";
  return Object.hasOwn(labels, value) ? labels[value] : value;
}

export function describeEnvelope(text: string): string | null {
  if (!text.startsWith(PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(PREFIX.length));
  } catch {
    return "【无法识别的结构化消息】";
  }
  const raw = record(value);
  const payload = record(raw.payload);
  const constraints = record(raw.constraints);
  const range = raw?.constraints ? `${scalar(constraints.date_from)} 到 ${scalar(constraints.date_to)}` : "";
  switch (raw?.kind) {
    case "request":
      return `【请求】向 ${short(raw.to)} 申请 ${scalar(raw.scope)}（${range}）`;
    case "consent_pending":
      return `【等待批准】${short(raw.to)} 的请求正在等对方主人批准`;
    case "denial":
      return `【拒绝】${labelFor(DENIAL_LABEL, raw.reason)}`;
    case "disclosure": {
      if (payload.scope === "email.receipt") {
        return `【已披露收据】发给 ${short(raw.to)}：${scalar(payload.subject) || "客票凭证"}`;
      }
      const count = Array.isArray(payload.busy) ? payload.busy.length : 0;
      return `【已披露】发给 ${short(raw.to)}：${scalar(payload.date_from)} 到 ${scalar(payload.date_to)} 共 ${count} 个忙碌时段`;
    }
    case "task":
      return `【派单】向 ${short(raw.to)} 派发任务：${scalar(raw.goal)}（第 ${scalar(raw.round)} 轮）`;
    case "result":
      return `【成果】向 ${short(raw.to)} 提交第 ${scalar(raw.round)} 轮成果：${typeof raw.summary === "string" ? raw.summary.slice(0, 40) : ""}`;
    case "verdict":
      return `【裁决】向 ${short(raw.to)} 裁决：${raw.accepted === true ? "验收通过" : "质疑 - " + scalar(raw.challenge)}`;
    case "action_request":
      return `【动作请示】请 ${short(raw.to)} 执行 ${scalar(raw.action)}`;
    case "action_result":
      return `【动作回执】${labelFor(ACTION_STATUS_LABEL, raw.status)}${typeof raw.summary === "string" && raw.summary ? "：" + raw.summary : ""}`;
    case "member_revoked":
      return `【成员移出】${short(raw.address)} 已被移出加密群`;
    default:
      return "【无法识别的结构化消息】";
  }
}
