import { Blocks, Code, Lightbulb, MessageSquare, Scale } from "lucide-react";
import type { HouseRuleDecision, HouseRules, RoomTemplateInfo } from "../../lib/api";

export const TEMPLATE_LABELS: Record<string, string> = {
  code_review: "代码评审",
  brainstorm: "头脑风暴",
  debate: "技术辩论",
  dev_team: "开发团队",
};

export const SCOPE_LABELS: Record<string, string> = {
  "calendar.free_busy": "查看日程空闲",
  "email.receipt": "读取邮件回执",
  "task.run": "执行任务",
  "gmail.send": "对外发送邮件",
};

export const HOUSE_RULE_DECISION_LABEL: Record<HouseRuleDecision | string, string> = {
  ask: "需询问",
  cannot: "不允许",
};

export interface TemplateOverrideDraft {
  house_rules: HouseRules;
  team_config_markdown: string;
  default_max_rounds?: number;
}

export interface ParsedTemplateRole {
  name: string;
  summary: string;
}

export function TemplateIcon({
  templateKey,
  name = "",
  size = 15,
}: {
  templateKey?: string | null;
  name?: string;
  size?: number;
}) {
  const normalized = `${templateKey ?? ""} ${name}`.toLowerCase();
  if (normalized.includes("code_review") || normalized.includes("review") || normalized.includes("评审")) {
    return <Code size={size} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (normalized.includes("brainstorm") || normalized.includes("头脑") || normalized.includes("创意")) {
    return <Lightbulb size={size} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (normalized.includes("debate") || normalized.includes("辩论")) {
    return <Scale size={size} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (normalized.includes("dev_team") || normalized.includes("dev") || normalized.includes("开发") || normalized.includes("架构")) {
    return <Blocks size={size} strokeWidth={1.8} aria-hidden="true" />;
  }
  return <MessageSquare size={size} strokeWidth={1.8} aria-hidden="true" />;
}

export function templateDisplayName(templateKey?: string | null): string {
  if (!templateKey) return "空白房间";
  return TEMPLATE_LABELS[templateKey] ?? templateKey;
}

export function defaultRoomName(templateName?: string | null, now = new Date()): string {
  const base = templateName?.trim() || "新房间";
  return `${base} · ${now.getMonth() + 1}月${now.getDate()}日`;
}

export function draftFromTemplate(template: RoomTemplateInfo): TemplateOverrideDraft {
  return {
    house_rules: {
      scopes: { ...(template.house_rules?.scopes ?? {}) },
      notes: [...(template.house_rules?.notes ?? [])],
    },
    team_config_markdown: template.team_config_markdown ?? "",
    default_max_rounds: template.default_max_rounds ?? undefined,
  };
}

/** 解析 team_config_markdown 中的 ### 角色段落为简洁的分工列表。 */
export function parseTemplateRoles(markdown?: string | null): ParsedTemplateRole[] {
  if (!markdown?.trim()) return [];
  const lines = markdown.split(/\r?\n/);
  const roles: ParsedTemplateRole[] = [];
  let currentName: string | null = null;
  let bullets: string[] = [];

  const flush = () => {
    if (!currentName) return;
    const summary = bullets.join("；").trim();
    roles.push({ name: currentName, summary: summary || "按房间规则参与" });
    currentName = null;
    bullets = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (/^###\s+/.test(line)) {
      flush();
      currentName = line.replace(/^###\s+/, "").trim();
      continue;
    }
    if (/^##\s+/.test(line) && currentName) {
      flush();
      continue;
    }
    if (!currentName || !line) continue;
    const cleaned = line
      .replace(/^[-*]\s+/, "")
      .replace(/^\*\*([^*]+)\*\*[:：]\s*/, "")
      .trim();
    if (!cleaned || /^agent\s*[:：]/i.test(cleaned)) continue;
    bullets.push(cleaned);
  }
  flush();
  return roles;
}

export function formatRelativeTime(iso?: string | null, nowMs = Date.now()): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  const diffSec = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (diffSec < 60) return "刚刚";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "昨天";
  if (diffDays < 30) return `${diffDays} 天前`;
  const d = new Date(parsed);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
