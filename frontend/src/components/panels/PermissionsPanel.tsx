import type { usePendingRequests } from "../../hooks/room/usePendingRequests";
import type { RoomPermissionMember as RoomMember, useRoomData } from "../../hooks/room/useRoomData";
import { ApiError } from "../../lib/apiError";
import { useState, useEffect, useCallback } from "react";
import { KeyRound, Link2, Shield, UserPlus, X } from "lucide-react";
import {
  apiFetch,
  sanitizeScopes,
  updateRoomSettings,
  type HouseRuleDecision,
  type HouseRules,
  type RoomSettings,
} from "../../lib/api";
import {
  approveRedemption,
  bindMyXmtpAddress,
  createRoomInvite,
  denyRedemption,
  issueSignatureNonce,
  listRoomInvites,
  listRoomRedemptions,
  revokeRoomInvite,
  type RedemptionView,
  type RoomInviteView,
} from "../../lib/localHelper";
import {
  addAddressToXmtpGroup,
  removeAddressFromXmtpGroup,
  type XmtpClientLike,
} from "../../lib/seatGroupSync";
import { hasUnlockedXmtpKey, signXmtpMessage } from "../../lib/xmtpLocalIdentity";
import { isEthAddress } from "../../lib/xmtpGroup";
import type { Room } from "../../types/chat";
import { CopyButton } from "../CopyButton";
import { useAuthStore } from "../../stores/authStore";

const ROLE_LABELS: Record<string, string> = {
  owner: "管理员",
  member: "成员",
  viewer: "观察者",
};

/** 已知的授权范围建议（worker 规则引擎注册的 scope；只是建议元数据，不授予任何实际权限）。 */
const KNOWN_SCOPE_OPTIONS = ["gmail.send", "calendar.free_busy", "email.receipt", "task.run"];

const HOUSE_RULE_DECISION_LABEL: Record<HouseRuleDecision, string> = {
  ask: "每次需当场批准",
  cannot: "建议一律禁止",
};

/** 成员的加密地址移除计划（纯函数，可测）。 */
export function planMemberRemoval(
  member: Pick<RoomMember, "xmtp_address">,
  isEncrypted: boolean,
): "direct" | "must-leave-group" | "needs-confirm" {
  if (!isEncrypted) return "direct";
  if (member.xmtp_address && isEthAddress(member.xmtp_address)) return "must-leave-group";
  return "needs-confirm";
}

interface RuleScopeDraft {
  scope: string;
  decision: HouseRuleDecision;
}

function houseRulesFromDraft(scopes: RuleScopeDraft[], notes: string): HouseRules {
  const scopeMap: Record<string, HouseRuleDecision> = {};
  for (const row of scopes) {
    const key = row.scope.trim().toLowerCase();
    if (key) scopeMap[key] = row.decision;
  }
  const noteList = notes
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);
  return { scopes: scopeMap, notes: noteList };
}

function draftFromHouseRules(rules: HouseRules | undefined | null): {
  scopes: RuleScopeDraft[];
  notes: string;
} {
  return {
    scopes: Object.entries(rules?.scopes ?? {}).map(([scope, decision]) => ({
      scope,
      decision: decision === "cannot" ? "cannot" : "ask",
    })),
    notes: (rules?.notes ?? []).join("\n"),
  };
}

export interface PermissionsPanelProps {
  roomId: string;
  section?: "members" | "invite" | "rules";
  isEncrypted?: boolean;
  isOwner?: boolean;
  xmtpClient?: XmtpClientLike | null;
  xmtpGroupId?: string | null;
  /** 当前用户已解锁的本机加密地址（RoomPage 传入；用于「绑定我的加密地址」）。 */
  myXmtpAddress?: string | null;
  /** 房间对象；settings_json 仅在模板建房回包或本次会话 PATCH 后可得。 */
  room?: Room | null;
  onPermissionsChanged?: () => void;
  pendingRequests?: ReturnType<typeof usePendingRequests>;
  permissionsQuery?: ReturnType<typeof useRoomData>["permissionsQuery"];
}

export function PermissionsPanel({
  roomId,
  section,
  isEncrypted = true,
  isOwner,
  xmtpClient,
  xmtpGroupId,
  myXmtpAddress,
  room,
  onPermissionsChanged,
  pendingRequests,
  permissionsQuery,
}: PermissionsPanelProps) {
  const currentUser = useAuthStore((s) => s.user);
  const [standaloneMembers, setMembers] = useState<RoomMember[]>([]);
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "viewer">("member");
  const [busy, setLoading] = useState(!permissionsQuery);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // 成员移除：S2 不变量（先移出加密群、再删 Hub 行）相关状态
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // 绑定本人加密地址（EIP-191 nonce 签名）
  const [bindingAddress, setBindingAddress] = useState(false);
  const [bindFeedback, setBindFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 加密群邀请：可复用表单 + 邀请列表
  const [invMaxUses, setInvMaxUses] = useState(1);
  const [invRequiresApproval, setInvRequiresApproval] = useState(Boolean(section));
  const [invScopeChecks, setInvScopeChecks] = useState<string[]>([]);
  const [invCustomScope, setInvCustomScope] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [creatingLink, setCreatingLink] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [invites, setInvites] = useState<RoomInviteView[]>([]);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);

  // 房主待审批核销队列
  const [standaloneRedemptions, setRedemptions] = useState<RedemptionView[]>([]);
  const [redemptionBusyId, setRedemptionBusyId] = useState<string | null>(null);
  const [redemptionError, setRedemptionError] = useState("");

  // 按 0x 地址直接拉人状态
  const [directAddress, setDirectAddress] = useState("");
  const [addingDirect, setAddingDirect] = useState(false);
  const [directFeedback, setDirectFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 房间规则建议（house_rules 元数据，只是建议；本机规则与主人决定才是权威）
  const [savedSettings, setSavedSettings] = useState<Record<string, unknown> | null>(
    (room?.settings_json as Record<string, unknown> | undefined) ?? null,
  );
  const [settingsVersion, setSettingsVersion] = useState<number | undefined>(room?.settings_version);
  const [hrScopes, setHrScopes] = useState<RuleScopeDraft[]>(() =>
    draftFromHouseRules((room?.settings_json as RoomSettings | undefined)?.house_rules).scopes,
  );
  const [hrNotes, setHrNotes] = useState(() =>
    draftFromHouseRules((room?.settings_json as RoomSettings | undefined)?.house_rules).notes,
  );
  const [savingRules, setSavingRules] = useState(false);
  const [rulesFeedback, setRulesFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const parentRefetch = permissionsQuery?.refetch;
  const fetchPermissions = useCallback(async () => {
    try {
      if (parentRefetch) {
        const result = await parentRefetch();
        if (result.isError) {
          setError(result.error instanceof ApiError && result.error.status === 403 ? "无权限查看成员列表" : "加载失败");
        } else {
          setError("");
        }
        return;
      }
      const res = await apiFetch(`/api/v1/rooms/${roomId}/permissions`);
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members ?? []);
        setError("");
      } else if (res.status === 403) {
        setError("无权限查看成员列表");
      }
    } catch {
      setError("加载失败");
    } finally {
      setLoading(false);
    }
  }, [roomId, parentRefetch]);

  useEffect(() => {
    if (!parentRefetch) void fetchPermissions();
  }, [fetchPermissions, parentRefetch]);

  const loading = Boolean(busy || permissionsQuery?.isPending);
  const permissionsError = permissionsQuery?.error;
  const loadError = error || (permissionsError ? permissionsError instanceof ApiError && permissionsError.status === 403
    ? "无权限查看成员列表" : "加载失败" : "");
  const members = permissionsQuery ? permissionsQuery.data?.members ?? [] : standaloneMembers;
  const redemptions = pendingRequests ? pendingRequests.requests : standaloneRedemptions;

  const effectiveIsOwner =
    isOwner ?? members.some((m) => m.user_id === currentUser?.id && m.role === "owner");

  const refreshInvites = useCallback(async () => {
    if (!effectiveIsOwner || (section && section !== "invite")) return;
    try {
      setInvites(await listRoomInvites(roomId));
    } catch {
      /* 列表读取失败不阻塞面板 */
    }
  }, [effectiveIsOwner, roomId, section]);

  const refetchPending = pendingRequests?.query.refetch;
  const refreshRedemptions = useCallback(async () => {
    if (!effectiveIsOwner) return;
    try {
      if (refetchPending) await refetchPending();
      else setRedemptions(await listRoomRedemptions(roomId, "pending"));
    } catch {
      /* 同上 */
    }
  }, [effectiveIsOwner, roomId, refetchPending]);

  useEffect(() => {
    void refreshInvites();
    if (!section && !refetchPending) void refreshRedemptions();
  }, [refreshInvites, refreshRedemptions, refetchPending, section]);

  async function handleInvite() {
    if (!inviteUsername.trim()) return;
    const targetName = inviteUsername.trim();
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/invite`, {
        method: "POST",
        body: JSON.stringify({ username: targetName, role: inviteRole }),
      });
      if (res.ok) {
        setMessage(`已添加 ${targetName} 为${ROLE_LABELS[inviteRole]}`);
        setInviteUsername("");
        void fetchPermissions();
        onPermissionsChanged?.();
      } else {
        const data = await res.json().catch(() => ({ detail: "邀请失败" }));
        setError(data.detail ?? "邀请失败");
      }
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/role`, {
        method: "PUT",
        body: JSON.stringify({ user_id: userId, role: newRole }),
      });
      if (res.ok) {
        void fetchPermissions();
        onPermissionsChanged?.();
      }
    } catch {
      /* 静默 */
    }
  }

  async function handleRemove(member: RoomMember) {
    const name = member.display_name || member.username;
    const plan = planMemberRemoval(member, isEncrypted);

    // S2 不变量：有已登记加密地址的成员，必须先出加密群、再删 Hub 行；
    // 任何一步失败都不删 Hub 行，避免留下仍能解密新消息的孤儿成员。
    if (plan === "must-leave-group") {
      if (!xmtpClient || !xmtpGroupId) {
        setRemoveError(
          `无法移除 ${name}：你的加密身份未解锁，无法先把对方移出加密群。房间权限未删除——请在聊天区解锁后重试，或等待房主客户端移出加密群。`,
        );
        return;
      }
      setRemovingId(member.user_id);
      setRemoveError("");
      try {
        await removeAddressFromXmtpGroup(xmtpClient, xmtpGroupId, member.xmtp_address as string);
      } catch {
        setRemovingId(null);
        setRemoveError(
          `无法把 ${name} 移出加密群（群管理操作通常需要房主客户端执行）。房间权限未删除——等待房主客户端移出加密群。`,
        );
        return;
      }
    } else if (plan === "needs-confirm") {
      // 未登记加密地址：无法核实对方是否在群里——先如实提示，二次确认才删权限。
      if (confirmRemoveId !== member.user_id) {
        setConfirmRemoveId(member.user_id);
        setRemoveError("");
        return;
      }
      setConfirmRemoveId(null);
    }

    setRemovingId(member.user_id);
    setRemoveError("");
    try {
      const res = await apiFetch(`/api/v1/rooms/${roomId}/members/${member.user_id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        void fetchPermissions();
        onPermissionsChanged?.();
      } else {
        const data = await res.json().catch(() => ({ detail: "移除失败" }));
        setRemoveError(typeof data.detail === "string" ? data.detail : "移除成员失败");
      }
    } catch {
      setRemoveError("网络错误，移除失败");
    } finally {
      setRemovingId(null);
    }
  }

  // ── 绑定我的加密地址（EIP-191 nonce → sign → PUT） ──
  const myMember = members.find((m) => m.user_id === currentUser?.id);
  const boundAddress = myMember?.xmtp_address ?? null;
  const unlockedAddress = myXmtpAddress ?? null;
  const addressMismatch = Boolean(
    unlockedAddress &&
      (!boundAddress || boundAddress.toLowerCase() !== unlockedAddress.toLowerCase()),
  );

  async function handleBindAddress() {
    if (!unlockedAddress || !isEthAddress(unlockedAddress)) return;
    setBindingAddress(true);
    setBindFeedback(null);
    try {
      const challenge = await issueSignatureNonce({
        action: "bind-address",
        resource: roomId,
        address: unlockedAddress,
      });
      const signature = await signXmtpMessage(challenge.message);
      await bindMyXmtpAddress(roomId, {
        xmtp_address: unlockedAddress,
        nonce: challenge.nonce,
        signature,
      });
      setBindFeedback({ kind: "ok", text: "已绑定你的加密地址" });
      void fetchPermissions();
    } catch (err) {
      setBindFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "绑定加密地址失败，请重试",
      });
    } finally {
      setBindingAddress(false);
    }
  }

  // ── 可复用邀请表单 ──
  async function handleGenerateInviteLink() {
    setCreatingLink(true);
    setLinkError("");
    setInviteLink("");
    try {
      const { kept, dropped } = sanitizeScopes([
        ...invScopeChecks,
        ...invCustomScope.split(/[\s,]+/),
      ]);
      const invite = await createRoomInvite(roomId, {
        expires_hours: 72,
        max_uses: Math.min(32, Math.max(1, Math.floor(invMaxUses) || 1)),
        requires_approval: invRequiresApproval,
        role: inviteRole === "viewer" ? "viewer" : "member",
        proposed_scopes: kept,
      });
      setInviteLink(
        `${window.location.origin}/rooms/${roomId}?invite=${encodeURIComponent(invite.token)}`,
      );
      if (dropped.length > 0) {
        setLinkError(`已忽略不支持的授权范围：${dropped.join("、")}`);
      }
      void refreshInvites();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "生成邀请链接失败");
    } finally {
      setCreatingLink(false);
    }
  }

  async function handleRevokeInvite(token: string) {
    setRevokingToken(token);
    setLinkError("");
    try {
      await revokeRoomInvite(roomId, token);
      void refreshInvites();
      void refreshRedemptions();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : "吊销邀请失败");
    } finally {
      setRevokingToken(null);
    }
  }

  async function handleDecideRedemption(redemption: RedemptionView, action: "approve" | "deny") {
    setRedemptionBusyId(redemption.id);
    setRedemptionError("");
    try {
      if (pendingRequests) {
        await pendingRequests.decide.mutateAsync({ id: redemption.id, approved: action === "approve" });
      } else {
        if (action === "approve") await approveRedemption(roomId, redemption.id, {});
        else await denyRedemption(roomId, redemption.id);
        void refreshRedemptions();
      }
      void refreshInvites();
      onPermissionsChanged?.();
    } catch (err) {
      setRedemptionError(err instanceof Error ? err.message : "操作失败，请重试");
    } finally {
      setRedemptionBusyId(null);
    }
  }

  async function handleDirectAdd() {
    if (!xmtpClient || !xmtpGroupId) {
      setDirectFeedback({ kind: "err", text: "请先在左侧聊天区解锁加密身份并完成建群后再拉人" });
      return;
    }
    setAddingDirect(true);
    setDirectFeedback(null);
    try {
      const result = await addAddressToXmtpGroup(xmtpClient, xmtpGroupId, directAddress);
      if (result === "already-member") {
        setDirectFeedback({ kind: "ok", text: "该加密地址已在当前加密群中" });
      } else {
        setDirectFeedback({ kind: "ok", text: "已成功将该协作者拉入加密群" });
        setDirectAddress("");
      }
    } catch (err) {
      setDirectFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "拉入加密群失败，请稍后重试",
      });
    } finally {
      setAddingDirect(false);
    }
  }

  // ── 房间规则建议 ──
  async function handleSaveHouseRules() {
    setSavingRules(true);
    setRulesFeedback(null);
    try {
      const base = (savedSettings ?? (room?.settings_json as Record<string, unknown> | undefined)) ?? {};
      const next: Record<string, unknown> = {
        ...base,
        house_rules: houseRulesFromDraft(hrScopes, hrNotes),
      };
      const result = await updateRoomSettings(roomId, next);
      setSavedSettings(result.settings_json);
      setSettingsVersion(result.settings_version);
      setRulesFeedback({ kind: "ok", text: `已保存规则建议（元数据版本 v${result.settings_version}）` });
    } catch (err) {
      setRulesFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "保存规则建议失败",
      });
    } finally {
      setSavingRules(false);
    }
  }

  function inviteStatusLabel(inv: RoomInviteView): string {
    if (inv.revoked_at) return "已吊销";
    const remaining = (inv.max_uses ?? 1) - (inv.use_count ?? 0);
    if (remaining <= 0) return "已用完";
    if (inv.is_expired) return "已过期";
    return `剩余 ${remaining} 次`;
  }

  return (
    <div className="panel-section" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── 可复用加密入群邀请（加密房间房主首选） ── */}
      {(!section || section === "invite") && isEncrypted && effectiveIsOwner && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "12px",
            borderRadius: 12,
            background: "var(--bg-canvas)",
            border: "1px solid var(--border-1)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Shield size={14} strokeWidth={1.9} style={{ color: "var(--info)" }} />
            <strong style={{ fontSize: 13, color: "var(--text-1)" }}>邀请成员进入加密群</strong>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>
            生成可复用的加密入群链接；受邀人登录并签名后可获得房间权限并加入加密群。
          </p>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ fontSize: 12, color: "var(--text-1)", display: "flex", alignItems: "center", gap: 4 }}>
              可用次数
              <input
                className="input"
                type="number"
                min={1}
                max={32}
                value={invMaxUses}
                onChange={(e) => setInvMaxUses(Number(e.target.value))}
                style={{ width: 64, fontSize: 12.5 }}
              />
            </label>
            <label style={{ fontSize: 12, color: "var(--text-1)", display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={invRequiresApproval}
                onChange={(e) => setInvRequiresApproval(e.target.checked)}
              />
              需房主批准
            </label>
            <label style={{ fontSize: 12, color: "var(--text-1)", display: "flex", alignItems: "center", gap: 4 }}>
              角色
              <select
                className="role-select"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
              >
                <option value="member">成员</option>
                <option value="viewer">观察者</option>
              </select>
            </label>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>
              建议授权范围（仅元数据建议，不授予实际权限；本机规则才是权威）：
            </span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {KNOWN_SCOPE_OPTIONS.map((scope) => (
                <label
                  key={scope}
                  style={{ fontSize: 12, color: "var(--text-1)", display: "flex", alignItems: "center", gap: 3 }}
                >
                  <input
                    type="checkbox"
                    checked={invScopeChecks.includes(scope)}
                    onChange={(e) =>
                      setInvScopeChecks((prev) =>
                        e.target.checked ? [...prev, scope] : prev.filter((s) => s !== scope),
                      )
                    }
                  />
                  <code style={{ fontSize: 11 }}>{scope}</code>
                </label>
              ))}
            </div>
            <input
              className="input"
              value={invCustomScope}
              onChange={(e) => setInvCustomScope(e.target.value)}
              placeholder="自定义范围（空格或逗号分隔；支付/凭据类范围会被自动忽略）"
              style={{ fontSize: 12, fontFamily: "var(--mono)" }}
            />
          </div>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleGenerateInviteLink()}
            disabled={creatingLink}
            style={{ width: "100%", justifyContent: "center" }}
          >
            <Link2 size={14} strokeWidth={2} />
            <span>{creatingLink ? "正在生成…" : "生成加密入群邀请链接"}</span>
          </button>

          {linkError && <p className="panel-error">{linkError}</p>}

          {inviteLink && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "9px 10px",
                borderRadius: 9,
                background: "var(--bg-surface)",
                border: "1px solid var(--border-1)",
              }}
            >
              <code
                style={{
                  fontSize: 11.5,
                  color: "var(--text-1)",
                  wordBreak: "break-all",
                  lineHeight: 1.45,
                }}
              >
                {inviteLink}
              </code>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <CopyButton text={inviteLink} label="复制邀请链接" />
              </div>
            </div>
          )}

          {invites.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-1)" }}>已有邀请</span>
              {invites.map((inv) => {
                const canRevoke =
                  !inv.revoked_at && !inv.is_expired && (inv.use_count ?? 0) < (inv.max_uses ?? 1);
                return (
                  <div
                    key={inv.token}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 11.5,
                      color: "var(--text-2)",
                      padding: "4px 0",
                    }}
                  >
                    <code style={{ fontFamily: "var(--mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {inv.token.slice(0, 10)}…
                    </code>
                    <span>{inviteStatusLabel(inv)}</span>
                    {inv.requires_approval && <span>· 需批准</span>}
                    {inv.role === "viewer" && <span>· 观察者</span>}
                    {canRevoke && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={revokingToken === inv.token}
                        onClick={() => void handleRevokeInvite(inv.token)}
                        style={{ fontSize: 11, padding: "2px 8px" }}
                      >
                        {revokingToken === inv.token ? "吊销中…" : "吊销"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div
            style={{
              paddingTop: 10,
              borderTop: "1px solid var(--border-1)",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <label
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--text-1)",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <KeyRound size={13} strokeWidth={1.8} style={{ color: "var(--text-2)" }} />
              <span>按加密地址直接拉人入群</span>
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="input"
                value={directAddress}
                onChange={(e) => setDirectAddress(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && directAddress.trim() && void handleDirectAdd()}
                placeholder="0x 开头的 42 位加密地址"
                style={{ fontSize: 12.5, fontFamily: "var(--mono)" }}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={addingDirect || !directAddress.trim() || !xmtpClient || !xmtpGroupId}
                onClick={() => void handleDirectAdd()}
              >
                {addingDirect ? "拉群中…" : "拉入加密群"}
              </button>
            </div>
            {!xmtpClient && (
              <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>
                请先在聊天区解锁你的本机加密身份以启用直接拉群。
              </span>
            )}
            {directFeedback && (
              <p className={directFeedback.kind === "ok" ? "ok-text" : "panel-error"} style={{ fontSize: 12 }}>
                {directFeedback.text}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── 房主待审批的入群申请 ── */}
      {!section && effectiveIsOwner && redemptions.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "12px",
            borderRadius: 12,
            background: "var(--warn-bg)",
            border: "1px solid var(--border-1)",
          }}
        >
          <strong style={{ fontSize: 13, color: "var(--text-1)" }}>
            待审批的入群申请 ({redemptions.length})
          </strong>
          {redemptions.map((red) => (
            <div
              key={red.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--text-1)",
                flexWrap: "wrap",
              }}
            >
              <span
                className="trust-badge"
                style={{ marginLeft: 0, border: "1px solid var(--border-2)" }}
              >
                {red.kind === "agent" ? "云端 Agent" : "真人"}
              </span>
              <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                {red.kind === "agent" && "displayName" in red && typeof red.displayName === "string"
                  ? red.displayName : `${(red.redeemer_address ?? red.redeemer_user_id ?? "?").slice(0, 14)}…`}
              </code>
              <span style={{ color: "var(--text-2)", fontSize: 11 }}>
                {red.created_at ? new Date(red.created_at).toLocaleString() : ""}
              </span>
              <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={redemptionBusyId === red.id}
                  onClick={() => void handleDecideRedemption(red, "approve")}
                  style={{ fontSize: 11, padding: "2px 10px" }}
                >
                  批准
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={redemptionBusyId === red.id}
                  onClick={() => void handleDecideRedemption(red, "deny")}
                  style={{ fontSize: 11, padding: "2px 10px" }}
                >
                  拒绝
                </button>
              </div>
            </div>
          ))}
          {redemptionError && <p className="panel-error">{redemptionError}</p>}
        </div>
      )}

      {/* ── 按用户名管理房间角色 ── */}
      {(!section || section === "members") && <>
      {(!section || effectiveIsOwner) && <div className="field">
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--text-1)" }}>
          <UserPlus size={14} strokeWidth={1.8} />
          <span>按用户名添加房间成员权限</span>
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="input"
            value={inviteUsername}
            onChange={(e) => setInviteUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleInvite()}
            placeholder="输入对方用户名…"
          />
          <select
            className="role-select"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
          >
            <option value="member">成员</option>
            <option value="viewer">观察者</option>
          </select>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleInvite()}
            disabled={!inviteUsername.trim() || loading}
          >
            添加
          </button>
        </div>
      </div>}

      {loadError && <p className="panel-error">{loadError}</p>}
      {message && <p className="ok-text">{message}</p>}
      {removeError && <p className="panel-error">{removeError}</p>}

      {loading && members.length === 0 && <p className="panel-empty">加载中…</p>}
      {!loading && members.length === 0 && !loadError && <p className="panel-empty">暂无成员</p>}

      {/* ── 我的加密地址绑定 ── */}
      {isEncrypted && myMember && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--text-2)",
            padding: "8px 10px",
            borderRadius: 9,
            background: "var(--bg-canvas)",
            border: "1px solid var(--border-1)",
            flexWrap: "wrap",
          }}
        >
          {boundAddress ? (
            <span>
              已绑定加密地址 <code style={{ fontFamily: "var(--mono)" }}>{boundAddress.slice(0, 10)}…</code>
            </span>
          ) : (
            <span>你的成员行尚未绑定加密地址</span>
          )}
          {addressMismatch && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={bindingAddress || !hasUnlockedXmtpKey()}
              onClick={() => void handleBindAddress()}
              style={{ fontSize: 11.5, padding: "2px 10px" }}
              title={hasUnlockedXmtpKey() ? "用本机身份签名后绑定" : "请先在聊天区解锁加密身份"}
            >
              {bindingAddress ? "签名绑定中…" : `绑定我的地址 ${unlockedAddress?.slice(0, 8)}…`}
            </button>
          )}
          {bindFeedback && (
            <span className={bindFeedback.kind === "ok" ? "ok-text" : "panel-error"} style={{ fontSize: 11.5 }}>
              {bindFeedback.text}
            </span>
          )}
        </div>
      )}

      <div>
        {members.map((m) => (
          <div key={m.user_id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div className="permission-row">
              <span
                className={`msg__avatar ${m.user_type === "agent" ? "msg__avatar--agent" : ""}`}
                style={{ width: 28, height: 28, fontSize: 12 }}
              >
                {(m.display_name || m.username || m.user_id).charAt(0).toUpperCase()}
              </span>
              <div className="permission-row__info">
                <strong>{m.display_name || m.username || m.user_id}</strong>
                <small>
                  {m.username && `@${m.username}`}
                  {m.xmtp_address && (
                    <code style={{ fontFamily: "var(--mono)", marginLeft: 6 }}>
                      {m.xmtp_address.slice(0, 6)}…{m.xmtp_address.slice(-4)}
                    </code>
                  )}
                </small>
              </div>
              <select
                value={m.role}
                onChange={(e) => void handleRoleChange(m.user_id, e.target.value)}
                className="role-select"
                disabled={!effectiveIsOwner}
              >
                <option value="owner">{ROLE_LABELS.owner}</option>
                <option value="member">{ROLE_LABELS.member}</option>
                <option value="viewer">{ROLE_LABELS.viewer}</option>
              </select>
              {effectiveIsOwner && m.role !== "owner" && (
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 26, height: 26 }}
                  disabled={removingId === m.user_id}
                  onClick={() => void handleRemove(m)}
                  title="移除成员（先移出加密群，再删房间权限）"
                >
                  <X size={14} strokeWidth={1.9} />
                </button>
              )}
            </div>
            {confirmRemoveId === m.user_id && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11.5,
                  color: "var(--warn)",
                  padding: "6px 10px",
                  borderRadius: 8,
                  background: "var(--warn-bg)",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ flex: 1, minWidth: 200 }}>
                  该成员未登记加密地址，无法核实是否仍在加密群。若对方曾被手动拉入群，
                  请先让房主在群成员管理中移除，否则对方可能继续读取历史加密内容。
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 11, padding: "2px 8px" }}
                  onClick={() => void handleRemove(m)}
                >
                  仍要删除权限
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 11, padding: "2px 8px" }}
                  onClick={() => setConfirmRemoveId(null)}
                >
                  取消
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      </>}

      {/* ── 房间规则建议（house_rules：只是建议，本机规则才是权威） ── */}
      {(!section || section === "rules") && effectiveIsOwner && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "12px",
            borderRadius: 12,
            background: "var(--bg-canvas)",
            border: "1px solid var(--border-1)",
          }}
        >
          <strong style={{ fontSize: 13, color: "var(--text-1)" }}>
            房间规则建议
            {settingsVersion != null && (
              <span style={{ fontWeight: 400, color: "var(--text-2)" }}>（元数据版本 v{settingsVersion}）</span>
            )}
          </strong>
          <p style={{ fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.5 }}>
            这里只是发给各个 Agent 本机助手的建议；本机规则和主人的当场决定才是权威，Hub 不能放大任何人的权限。
            保存会整体覆盖当前建议。
          </p>
          {savedSettings == null && (
            <p style={{ fontSize: 11.5, color: "var(--warn)", lineHeight: 1.5 }}>
              服务器暂不提供现有建议内容的回读，这里无法预填房间已有的模板配置；
              保存后现有建议会被你填写的内容整体替换。
            </p>
          )}
          {hrScopes.map((row, idx) => (
            <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                className="input"
                value={row.scope}
                onChange={(e) =>
                  setHrScopes((prev) =>
                    prev.map((r, i) => (i === idx ? { ...r, scope: e.target.value } : r)),
                  )
                }
                placeholder="scope，如 gmail.send"
                style={{ fontSize: 12, fontFamily: "var(--mono)", flex: 1 }}
              />
              <select
                className="role-select"
                value={row.decision}
                onChange={(e) =>
                  setHrScopes((prev) =>
                    prev.map((r, i) =>
                      i === idx ? { ...r, decision: e.target.value as HouseRuleDecision } : r,
                    ),
                  )
                }
              >
                <option value="ask">{HOUSE_RULE_DECISION_LABEL.ask}</option>
                <option value="cannot">{HOUSE_RULE_DECISION_LABEL.cannot}</option>
              </select>
              <button
                type="button"
                className="icon-btn"
                style={{ width: 24, height: 24 }}
                onClick={() => setHrScopes((prev) => prev.filter((_, i) => i !== idx))}
                title="删除此条建议"
              >
                <X size={12} strokeWidth={1.9} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setHrScopes((prev) => [...prev, { scope: "", decision: "ask" }])}
            style={{ alignSelf: "flex-start", fontSize: 11.5 }}
          >
            + 添加范围建议
          </button>
          <textarea
            className="input"
            value={hrNotes}
            onChange={(e) => setHrNotes(e.target.value)}
            placeholder="备注（每行一条，纯建议文字）"
            rows={2}
            style={{ fontSize: 12 }}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={savingRules}
            onClick={() => void handleSaveHouseRules()}
            style={{ alignSelf: "flex-start" }}
          >
            {savingRules ? "保存中…" : "保存规则建议"}
          </button>
          {rulesFeedback && (
            <p className={rulesFeedback.kind === "ok" ? "ok-text" : "panel-error"} style={{ fontSize: 12 }}>
              {rulesFeedback.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
