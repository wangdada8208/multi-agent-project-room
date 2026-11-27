import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import {
  fetchHubActivity,
  fetchLocalActivity,
  mergeActivityFeeds,
  type ActivityFilterParams,
  type HubActivityFeed,
  type LocalActivityResult,
} from "../../lib/activityApi";
import { isMobileBrowser, listLocalSeats } from "../../lib/localHelper";

const SOURCE_LABEL: Record<string, string> = {
  local_ledger: "本机账本",
  activity: "Hub 活动",
  task_event: "Hub 任务",
  approval: "Hub 审批",
};

const SINCE_OPTIONS = [
  { value: "", label: "全部时间" },
  { value: "1h", label: "最近 1 小时" },
  { value: "24h", label: "最近 24 小时" },
  { value: "7d", label: "最近 7 天" },
] as const;

function resolveSinceIso(preset: string): string | undefined {
  const now = Date.now();
  if (preset === "1h") return new Date(now - 3_600_000).toISOString();
  if (preset === "24h") return new Date(now - 86_400_000).toISOString();
  if (preset === "7d") return new Date(now - 7 * 86_400_000).toISOString();
  return undefined;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts).toLocaleString();
}

function statusColor(status: string | null | undefined): string {
  if (!status) return "var(--text-2)";
  if (status === "ok" || status === "completed" || status === "approved") return "var(--ok)";
  if (status === "denied" || status === "failed" || status === "rejected" || status === "uncertain") {
    return "var(--danger)";
  }
  return "var(--warn)";
}

export function ActivityPanel({ roomId, integrityOnly = false }: { roomId: string; integrityOnly?: boolean }) {
  const [actorFilter, setActorFilter] = useState("");
  const [appFilter, setAppFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sincePreset, setSincePreset] = useState("");

  const [hubFeed, setHubFeed] = useState<HubActivityFeed | null>(null);
  const [localResults, setLocalResults] = useState<LocalActivityResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const filters: ActivityFilterParams = {
      actor: actorFilter.trim() || undefined,
      app: appFilter || undefined,
      kind: kindFilter.trim() || undefined,
      status: statusFilter || undefined,
      since: resolveSinceIso(sincePreset),
      limit: 100,
    };
    try {
      const [hub, seats] = await Promise.all([
        fetchHubActivity(roomId, filters),
        isMobileBrowser() ? Promise.resolve([]) : listLocalSeats().catch(() => []),
      ]);
      setHubFeed(hub);
      const roomPorts = Array.from(
        new Map(
          seats
            .filter((s) => s.roomId === roomId && Number.isInteger(s.consolePort))
            .map((s) => [s.consolePort, s.seatId]),
        ).entries(),
      );
      if (roomPorts.length > 0) {
        const locals = await Promise.all(
          roomPorts.map(([port, seatId]) => fetchLocalActivity(port, filters, { seatId })),
        );
        setLocalResults(locals);
      } else {
        setLocalResults([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载活动流失败");
    } finally {
      setLoading(false);
    }
  }, [actorFilter, appFilter, kindFilter, roomId, sincePreset, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const merged = useMemo(
    () => mergeActivityFeeds(hubFeed, localResults, { appFilter }),
    [appFilter, hubFeed, localResults],
  );

  const { integrity } = merged;
  const hasTamper = !integrity.ok || integrity.issues.length > 0;
  const hasLegacyOrMissing =
    integrity.legacyUnverifiedCount > 0 ||
    integrity.checkedPorts === 0 ||
    integrity.unreachablePorts > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>安全活动流（元数据 + 本机账本）</div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void load()}
          disabled={loading}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
        >
          <RefreshCw size={13} />
          刷新
        </button>
      </div>

      {/* 完整性与检查点锚定状态横幅 */}
      <div
        className="panel-card"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          fontSize: 12,
          borderColor: hasTamper
            ? "var(--danger-border)"
            : hasLegacyOrMissing
              ? "var(--warn-border)"
              : "var(--ok-border)",
          background: hasTamper
            ? "var(--danger-bg)"
            : hasLegacyOrMissing
              ? "var(--warn-bg)"
              : "var(--ok-bg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
          {hasTamper ? (
            <>
              <ShieldAlert size={14} color="var(--danger)" />
              <span style={{ color: "var(--danger)" }}>检测到本机账本完整性异常或截断</span>
            </>
          ) : hasLegacyOrMissing ? (
            <>
              <AlertTriangle size={14} color="var(--warn)" />
              <span style={{ color: "var(--warn)" }}>
                {integrity.checkedPorts === 0
                  ? "未连上本地助手，当前只展示服务器动态"
                  : "本机链完整（含历史未加链条目）"}
              </span>
            </>
          ) : (
            <>
              <ShieldCheck size={14} color="var(--ok)" />
              <span style={{ color: "var(--ok)" }}>本机哈希链校验通过</span>
            </>
          )}
        </div>
        <div style={{ color: "var(--text-2)", fontSize: 11.5 }}>
          已校验本机端：{integrity.checkedPorts}（不可达 {integrity.unreachablePorts}） · 已加链{" "}
          {integrity.chainedCount} 条 · 历史未验证 {integrity.legacyUnverifiedCount} 条 · Hub 签名检查点{" "}
          {integrity.hubCheckpoints.length} 个
        </div>
        {integrity.issues.map((issue, idx) => (
          <div key={`${issue.port}-${issue.code}-${idx}`} style={{ color: "var(--danger)", fontSize: 11.5 }}>
            端口 {issue.port} 第 {issue.line} 行：<code>{issue.code}</code>
            {issue.detail ? ` — ${issue.detail}` : ""}
          </div>
        ))}
      </div>

      {!integrityOnly && <>
      {/* 过滤栏 */}
      <div className="panel-card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <input
          type="text"
          className="input"
          placeholder="按 Actor / 地址过滤"
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          style={{ fontSize: 12, padding: "5px 8px" }}
        />
        <select
          className="input"
          aria-label="按应用过滤"
          value={appFilter}
          onChange={(e) => setAppFilter(e.target.value)}
          style={{ fontSize: 12, padding: "5px 8px" }}
        >
          <option value="">全部应用</option>
          <option value="gmail">Gmail</option>
          <option value="calendar">日历</option>
          <option value="xmtp">XMTP</option>
          <option value="hub">Hub 任务/审批</option>
        </select>
        <input
          type="text"
          className="input"
          placeholder="按类型 kind（如 action_finished）"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          style={{ fontSize: 12, padding: "5px 8px" }}
        />
        <select
          className="input"
          aria-label="按状态过滤"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ fontSize: 12, padding: "5px 8px" }}
        >
          <option value="">全部状态</option>
          <option value="pending">待审批 (pending)</option>
          <option value="ok">成功 (ok)</option>
          <option value="denied">已拒绝 (denied)</option>
          <option value="failed">失败 (failed)</option>
          <option value="expired">已过期 (expired)</option>
          <option value="uncertain">结果不明 (uncertain)</option>
        </select>
        <select
          className="input"
          aria-label="按时间范围过滤"
          value={sincePreset}
          onChange={(e) => setSincePreset(e.target.value)}
          style={{ fontSize: 12, padding: "5px 8px", gridColumn: "span 2" }}
        >
          {SINCE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="panel-error">{error}</div>}
      {loading && <div style={{ fontSize: 12, color: "var(--text-2)" }}>正在加载安全活动流…</div>}
      {!loading && !error && merged.items.length === 0 && (
        <div className="panel-empty">暂无符合条件的活动记录（仅展示元数据，不记录加密正文）</div>
      )}

      {merged.items.map((item) => (
        <div
          key={item.id}
          className="panel-card"
          style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span className="trust-badge" style={{ marginLeft: 0 }}>
              {SOURCE_LABEL[item.source] ?? item.source}
            </span>
            <code style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{item.kind}</code>
            {item.app && (
              <span className="trust-badge" style={{ marginLeft: 0 }}>
                {item.app}
              </span>
            )}
            {item.status && (
              <span style={{ marginLeft: "auto", fontWeight: 600, fontSize: 11.5, color: statusColor(item.status) }}>
                {item.status}
              </span>
            )}
          </div>
          {item.title && <div style={{ color: "var(--text-1)" }}>{item.title}</div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", color: "var(--text-2)", fontSize: 11 }}>
            {item.actor_id && <span>操作方：{item.actor_id}</span>}
            {item.scope && <span>范围：{item.scope}</span>}
            {item.reason && <span>说明：{item.reason}</span>}
            {item.subject_id && (
              <span>
                对象：<code style={{ fontFamily: "var(--mono)" }}>{item.subject_id}</code>
              </span>
            )}
            {item.created_at && <span style={{ marginLeft: "auto" }}>{formatTime(item.created_at)}</span>}
          </div>
        </div>
      ))}
      </>}
    </div>
  );
}
