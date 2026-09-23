export interface OutboundFilterInput {
  content: string;
  approvedDays?: string[];
  sensitiveKeywords?: string[];
}

export type OutboundFilterResult =
  | { blocked: true; text: null }
  | { blocked: false; text: string };

const WEEKDAYS: Record<string, string> = {
  monday: "mon",
  tuesday: "tue",
  wednesday: "wed",
  thursday: "thu",
  friday: "fri",
  saturday: "sat",
  sunday: "sun",
  "周一": "mon",
  "周二": "tue",
  "周三": "wed",
  "周四": "thu",
  "周五": "fri",
  "周六": "sat",
  "周日": "sun",
};

export function filterOutbound(input: OutboundFilterInput): OutboundFilterResult {
  const approvedSet = new Set(
    (input.approvedDays ?? []).map((d) => d.trim().toLowerCase().slice(0, 3))
  );

  const contentLower = input.content.toLowerCase();

  for (const [word, code] of Object.entries(WEEKDAYS)) {
    if (contentLower.includes(word)) {
      if (!approvedSet.has(code)) {
        return { blocked: true, text: null };
      }
    }
  }

  let filtered = input.content;
  if (input.sensitiveKeywords) {
    for (const kw of input.sensitiveKeywords) {
      if (kw && kw.length > 1) {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filtered = filtered.replace(new RegExp(escaped, "gi"), "[REDACTED]");
      }
    }
  }

  return { blocked: false, text: filtered };
}
