import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Client } from "@xmtp/browser-sdk";
import { ArrowLeft, ArrowRight, CheckCircle2, Lock, XCircle } from "lucide-react";
import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/Button";
import { apiFetch, bindXmtpGroup } from "../lib/api";
import {
  createLocalXmtpClient,
  hasEncryptedVault,
  unlockOrCreateInboxKey,
} from "../lib/xmtpLocalIdentity";
import type { Room } from "../types/chat";
import "../components/rooms/Rooms.css";

type StepState = "idle" | "running" | "done" | "failed";

export function SetupPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();

  const roomQuery = useQuery({
    queryKey: ["setup-room", roomId],
    queryFn: async () => {
      const res = await apiFetch(`/api/v1/rooms/${encodeURIComponent(roomId ?? "")}`);
      if (!res.ok) throw new Error("房间不存在或没有访问权限。");
      return (await res.json()).room as Room;
    },
    enabled: Boolean(roomId),
    retry: false,
  });

  const room = roomQuery.data ?? null;
  const creatingVault = !hasEncryptedVault();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stages, setStages] = useState<{ label: string; state: StepState }[]>([
    { label: "解锁本机加密身份", state: "idle" },
    { label: "创建端到端加密群", state: "idle" },
    { label: "绑定加密群到房间", state: "idle" },
  ]);

  const clientRef = useRef<Client<any> | null>(null);
  useEffect(
    () => () => {
      clientRef.current?.close();
      clientRef.current = null;
    },
    [],
  );

  function setStage(idx: number, state: StepState) {
    setStages((prev) => prev.map((item, i) => (i === idx ? { ...item, state } : item)));
  }

  async function handleActivate() {
    if (!room || !password) return;
    setBusy(true);
    setError("");
    let client: Client<any> | null = null;
    try {
      setStage(0, "running");
      const key = await unlockOrCreateInboxKey(password);
      client = await createLocalXmtpClient(key);
      setStage(0, "done");

      if (!room.xmtp_group_id) {
        setStage(1, "running");
        const group = await client.conversations.createGroup([]);
        setStage(1, "done");

        setStage(2, "running");
        await bindXmtpGroup(room.id, group.id);
        setStage(2, "done");
      } else {
        setStage(1, "done");
        setStage(2, "done");
      }

      client.close();
      client = null;
      navigate(`/rooms/${encodeURIComponent(room.id)}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "启用加密对话失败，请重试。");
      setStages((prev) =>
        prev.map((item) => (item.state === "running" ? { ...item, state: "failed" } : item)),
      );
    } finally {
      client?.close();
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <div className="wb-setup-page">
        <div>
          <Link to="/home" className="ui-button ui-button--ghost ui-button--sm">
            <ArrowLeft size={14} strokeWidth={1.9} />
            <span>返回房间</span>
          </Link>
        </div>

        {roomQuery.isLoading && (
          <div className="wb-rooms-state">
            <span className="ui-spinner" aria-hidden="true" />
            <p>正在加载房间信息…</p>
          </div>
        )}

        {roomQuery.isError && (
          <div className="wb-setup-card" role="alert">
            <h1>无法打开此房间</h1>
            <p>房间不存在或你没有访问权限。</p>
            <div className="wb-setup-actions">
              <Link to="/home" className="ui-button ui-button--primary ui-button--md">
                回到房间
              </Link>
            </div>
          </div>
        )}

        {room && (
          <section className="wb-setup-card">
            <h1>
              <Lock size={20} strokeWidth={1.9} aria-hidden="true" />
              <span>{room.xmtp_group_id ? "加密对话已启用" : "启用端到端加密对话"}</span>
            </h1>
            <p>
              房间「{room.name}」
              {room.xmtp_group_id
                ? "已经完成加密群绑定，可以直接进入房间。"
                : creatingVault
                  ? "尚未启用加密群。请设置至少 10 位的本机加密口令，系统会在当前浏览器本地创建加密群并绑定。"
                  : "尚未启用加密群。输入本机加密口令即可自动创建并绑定，完成后直接进入房间。"}
            </p>

            {room.xmtp_group_id ? (
              <div className="wb-setup-actions">
                <Button
                  variant="primary"
                  onClick={() => navigate(`/rooms/${encodeURIComponent(room.id)}`)}
                >
                  <span>进入房间</span>
                  <ArrowRight size={15} strokeWidth={2} />
                </Button>
              </div>
            ) : (
              <>
                <div className="wb-create-drawer__field">
                  <label className="wb-create-drawer__label" htmlFor="wb-setup-passphrase">
                    本机加密口令
                  </label>
                  <input
                    id="wb-setup-passphrase"
                    className="wb-create-drawer__input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void handleActivate()}
                    placeholder={creatingVault ? "至少 10 位，仅保存在当前浏览器" : "输入本机加密口令"}
                    autoComplete={creatingVault ? "new-password" : "current-password"}
                    minLength={creatingVault ? 10 : undefined}
                    autoFocus
                  />
                  <span className="wb-preview-box__help">
                    口令与私钥仅保存在当前设备浏览器中，服务器无法读取。
                  </span>
                </div>

                {stages.some((s) => s.state !== "idle") && (
                  <div className="wb-setup-steps">
                    {stages.map((stage) => (
                      <div
                        key={stage.label}
                        className={`wb-setup-step ${
                          stage.state === "done"
                            ? "wb-setup-step--done"
                            : stage.state === "failed"
                              ? "wb-setup-step--failed"
                              : ""
                        }`}
                      >
                        {stage.state === "running" && <span className="ui-spinner" aria-hidden="true" />}
                        {stage.state === "done" && <CheckCircle2 size={15} strokeWidth={2} />}
                        {stage.state === "failed" && <XCircle size={15} strokeWidth={2} />}
                        <span>{stage.label}</span>
                      </div>
                    ))}
                  </div>
                )}

                {error && (
                  <div className="wb-create-drawer__error" role="alert">
                    {error}
                  </div>
                )}

                <div className="wb-setup-actions">
                  <Button
                    variant="primary"
                    loading={busy}
                    disabled={!password || (creatingVault && password.length < 10)}
                    onClick={() => void handleActivate()}
                  >
                    <span>立即启用并进入房间</span>
                    <ArrowRight size={15} strokeWidth={2} />
                  </Button>
                  <Link
                    to={`/rooms/${encodeURIComponent(room.id)}`}
                    className="ui-button ui-button--ghost ui-button--md"
                  >
                    直接进入房间
                  </Link>
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </AppShell>
  );
}
