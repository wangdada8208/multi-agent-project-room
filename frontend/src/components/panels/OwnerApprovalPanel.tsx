import { HelperLink } from "../HelperLink";
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";
import {
  decideOwnerConsent,
  fetchConsentDetail,
  fetchOwnerConsoleState,
  type OwnerConsentDetail,
  type OwnerConsentSummary,
  type OwnerDecisionAction,
} from "../../lib/ownerConsole";
import { listLocalSeats, type SeatViewLocal } from "../../lib/localHelper";

const STATUS_LABEL: Record<string, string> = {
  pending: "待批准",
  approved: "已批准",
  executing: "执行中",
  awaiting_receipt: "回执待送达",
  completed: "已完成",
  denied: "已拒绝",
  expired: "已过期",
  uncertain: "结果不明",
};

const RESULT_STATUS_LABEL: Record<string, string> = {
  executed: "已执行",
  failed: "执行失败",
  uncertain: "结果不明",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts).toLocaleString();
}

function isExpired(consent: { status: string; expires_at?: string }): boolean {
  if (consent.status !== "pending" || !consent.expires_at) return false;
  const ts = Date.parse(consent.expires_at);
  return Number.isFinite(ts) && ts <= Date.now();
}

function paramPreview(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 单条审批卡（纯渲染组件，便于测试）。 */
export function ConsentCard({
  consent,
  detail,
  expanded,
  busy,
  onToggleDetail,
  onDecide,
}: {
  consent: OwnerConsentSummary;
  detail?: OwnerConsentDetail | "loading" | { error: string };
  expanded: boolean;
  busy: boolean;
  onToggleDetail: () => void;
  onDecide: (action: OwnerDecisionAction) => void;
}) {
  const expired = isExpired(consent);
  const canDecide = consent.status === "pending" && !expired;
  const canDeny = canDecide || consent.status === "approved";
  const canResend = consent.status === "awaiting_receipt";
  const preview = detail && detail !== "loading" && !("error" in detail) ? detail.params : undefined;
  const previewError =
    detail && detail !== "loading" && "error" in detail ? detail.error : undefined;

  return (
    <div
      className="panel-card"
      style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <code style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "#1d1d1f" }}>
          {consent.scope}
        </code>
        {consent.kind === "action" && (
          <span className="trust-badge" style={{ marginLeft: 0, border: "1px solid rgba(0,0,0,0.12)" }}>
            外部动作
          </span>
        )}
        {consent.source === "trigger" && (
          <span
            className="trust-badge"
            title="由本机触发器自动发起，不是群内请示"
            style={{ marginLeft: 0, border: "1px solid rgba(0,0,0,0.12)" }}
          >
            触发器发起
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color:
              consent.status === "completed"
                ? "#1d7a3c"
                : consent.status === "denied" || expired || consent.status === "uncertain"
                  ? "#b3261e"
                  : "#8a6500",
          }}
        >
          {expired ? "已过期" : statusLabel(consent.status)}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onToggleDetail}
          style={{ marginLeft: "auto", fontSize: 11, padding: "2px 8px" }}
        >
          {expanded ? "收起" : "详情"}
        </button>
      </div>

      <div style={{ color: "#1d1d1f" }}>{consent.purpose || "（无说明）"}</div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", color: "#6e6e73", fontSize: 11.5 }}>
        <span>发起方：{consent.requester}</span>
        {consent.rule_hit && <span>命中规则：{consent.rule_hit}</span>}
        {consent.account_id && <span>账户：{consent.account_id}</span>}
        {consent.expires_at && <span>到期：{formatTime(consent.expires_at)}</span>}
      </div>

      {consent.result_status && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", color: "#6e6e73", fontSize: 11.5 }}>
          <span>执行结果：{RESULT_STATUS_LABEL[consent.result_status] ?? consent.result_status}</span>
          {consent.result_receipt && (
            <span>
              回执：<code style={{ fontFamily: "var(--mono)" }}>{consent.result_receipt}</code>
            </span>
          )}
          {(consent.resend_count ?? 0) > 0 && <span>已重发 {consent.resend_count} 次</span>}
        </div>
      )}
      {consent.result_summary && (
        <div style={{ color: "#6e6e73", fontSize: 11.5 }}>{consent.result_summary}</div>
      )}

      {expanded && (
        <div
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            background: "#f5f5f7",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 12,
          }}
        >
          {detail === "loading" && <span style={{ color: "#6e6e73" }}>读取动作详情…</span>}
          {previewError && <span className="panel-error">{previewError}</span>}
          {preview &&
            (Object.keys(preview).length === 0 ? (
              <span style={{ color: "#6e6e73" }}>该请求没有附加执行参数。</span>
            ) : (
              Object.entries(preview).map(([key, value]) => (
                <div key={key} style={{ display: "flex", gap: 6 }}>
                  <code style={{ fontFamily: "var(--mono)", color: "#6e6e73", flexShrink: 0 }}>
                    {key}:
                  </code>
                  <span style={{ wordBreak: "break-all", whiteSpace: "pre-wrap" }}>
                    {paramPreview(value)}
                  </span>
                </div>
              ))
            ))}
          {consent.params_hash && (
            <span style={{ color: "#6e6e73", fontSize: 11 }}>
              参数哈希：<code style={{ fontFamily: "var(--mono)" }}>{consent.params_hash.slice(0, 16)}…</code>
            </span>
          )}
        </div>
      )}

      {(canDecide || canDeny || canResend || consent.status === "uncertain") && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {canDecide && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => onDecide("approve")}
              style={{ fontSize: 11.5, padding: "3px 12px" }}
            >
              批准
            </button>
          )}
          {canDeny && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => onDecide("deny")}
              style={{ fontSize: 11.5, padding: "3px 12px" }}
            >
              拒绝
            </button>
          )}
          {canResend && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => onDecide("resend")}
              title="重发已签名的回执信封；不会重新执行外部动作"
              style={{ fontSize: 11.5, padding: "3px 12px" }}
            >
              重发回执
            </button>
          )}
          {consent.status === "uncertain" && (
            <span style={{ fontSize: 11.5, color: "#b3261e" }}>
              该动作结果不明，需人工对账确认——不会自动重试。
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface ConsoleSection {
  seat: SeatViewLocal;
  status: "loading" | "ok" | "unreachable";
  error?: string;
  role?: string;
  consents: OwnerConsentSummary[];
}

export interface OwnerApprovalPanelProps {
  roomId: string;
  fetchImpl?: typeof fetch;
  listSeats?: (fetchImpl: typeof fetch) => Promise<SeatViewLocal[]>;
  pollMs?: number;
}

/**
 * WP2 房主审批面板：只连各席位在本机的审批控制台（127.0.0.1:{consolePort}，
 * X-MAPR-Owner 头），动作参数不经过 Hub。
 * 浏览器若无法直接访问（控制台仅允许回环来源），面板如实提示并给出控制台地址。
 */
export function OwnerApprovalPanel({
  roomId,
  fetchImpl = fetch,
  listSeats = listLocalSeats,
  pollMs = 5000,
}: OwnerApprovalPanelProps) {
  const [helperDown, setHelperDown] = useState(false);
  const [sections, setSections] = useState<ConsoleSection[]>([]);
  const [details, setDetails] = useState<Record<string, OwnerConsentDetail | "loading" | { error: string }>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    let seats: SeatViewLocal[];
    try {
      seats = await listSeats(fetchImpl);
    } catch {
      setHelperDown(true);
      setSections([]);
      return;
    }
    setHelperDown(false);
    const roomSeats = seats.filter((s) => s.roomId === roomId && s.consolePort > 0);
    const unique = new Map<number, SeatViewLocal>();
    for (const s of roomSeats) unique.set(s.consolePort, s);

    const next: ConsoleSection[] = await Promise.all(
      [...unique.values()].map(async (seat) => {
        try {
          const state = await fetchOwnerConsoleState(seat.consolePort, fetchImpl);
          return {
            seat,
            status: "ok" as const,
            role: state.role,
            consents: state.consents ?? [],
          };
        } catch (err) {
          return {
            seat,
            status: "unreachable" as const,
            error: err instanceof Error ? err.message : "无法访问本机审批控制台",
            consents: [],
          };
        }
      }),
    );
    setSections(next);
  }, [fetchImpl, listSeats, roomId]);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  async function toggleDetail(port: number, requestId: string) {
    if (expandedId === requestId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(requestId);
    setDetails((prev) => (prev[requestId] ? prev : { ...prev, [requestId]: "loading" }));
    try {
      const detail = await fetchConsentDetail(port, requestId, fetchImpl);
      setDetails((prev) => ({ ...prev, [requestId]: detail }));
    } catch (err) {
      setDetails((prev) => ({
        ...prev,
        [requestId]: { error: err instanceof Error ? err.message : "读取动作详情失败" },
      }));
    }
  }

  async function decide(port: number, consent: OwnerConsentSummary, action: OwnerDecisionAction) {
    setBusyId(consent.request_id);
    setActionFeedback(null);
    try {
      const result = await decideOwnerConsent(port, consent.request_id, action, fetchImpl);
      if (result.ok) {
        setActionFeedback({
          kind: "ok",
          text:
            action === "approve" ? "已批准" : action === "deny" ? "已拒绝" : "已请求重发回执",
        });
        void refresh();
      } else {
        setActionFeedback({ kind: "err", text: result.reason ?? "操作未完成" });
      }
    } catch (err) {
      setActionFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "操作失败，请重试",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="panel-section" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ fontSize: 12, color: "#6e6e73", lineHeight: 1.5 }}>
        <ShieldCheck size={13} strokeWidth={1.9} style={{ verticalAlign: "-2px", marginRight: 4 }} />
        审批只在你本机助手的控制台完成；动作参数（收件人、正文等）不经过 Hub。
      </p>

      {helperDown && (
        <div className="panel-card" style={{ fontSize: 12.5, color: "#6e6e73" }}>
          本机助手未运行或不可达——有 Agent 在本机运行时，审批请求才会出现在这里。
        </div>
      )}

      {!helperDown && sections.length === 0 && (
        <div className="panel-card" style={{ fontSize: 12.5, color: "#6e6e73" }}>
          该房间在本机没有运行中的 Agent 席位，暂无本机审批请求。
        </div>
      )}

      {sections.map((section) => (
        <div
          key={section.seat.seatId}
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13, color: "#1d1d1f" }}>{section.seat.agentKey}</strong>
            <span style={{ fontSize: 11, color: "#6e6e73" }}>
              控制台 127.0.0.1:{section.seat.consolePort}
            </span>
            {section.role === "observer" && (
              <span className="trust-badge" style={{ marginLeft: 0, border: "1px solid rgba(0,0,0,0.12)" }}>
                只读席位
              </span>
            )}
          </div>

          {section.status === "unreachable" && (
            <div
              className="panel-card"
              style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: "#6e6e73" }}
            >
              <span>{section.error}。</span>
              <span>
                如需审批，请在运行该 Agent 的电脑上打开
                <HelperLink
                  action={{ approvalPort: section.seat.consolePort }}
                  rel="noreferrer"
                  style={{ color: "#0071e3", marginLeft: 4 }}
                >
                  本机审批控制台
                  <ExternalLink size={11} style={{ verticalAlign: "-1px", marginLeft: 2 }} />
                </HelperLink>
              </span>
            </div>
          )}

          {section.status === "ok" && section.consents.length === 0 && (
            <div className="panel-card" style={{ fontSize: 12.5, color: "#6e6e73" }}>
              该 Agent 当前没有待处理的审批请求。
            </div>
          )}

          {section.consents.map((consent) => (
            <ConsentCard
              key={consent.request_id}
              consent={consent}
              detail={details[consent.request_id]}
              expanded={expandedId === consent.request_id}
              busy={busyId === consent.request_id}
              onToggleDetail={() =>
                void toggleDetail(section.seat.consolePort, consent.request_id)
              }
              onDecide={(action) => void decide(section.seat.consolePort, consent, action)}
            />
          ))}
        </div>
      ))}

      {actionFeedback && (
        <p className={actionFeedback.kind === "ok" ? "ok-text" : "panel-error"} style={{ fontSize: 12 }}>
          {actionFeedback.text}
        </p>
      )}
    </div>
  );
}
