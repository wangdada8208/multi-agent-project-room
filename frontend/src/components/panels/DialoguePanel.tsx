import { useEffect, useRef, useState } from "react";
import { Activity, CheckCircle2, CircleOff, Play, SkipForward, Square } from "lucide-react";
import { apiFetch } from "../../lib/api";
import type { MessageLoopState } from "../../types/chat";

interface DialoguePanelProps {
  roomId: string;
  onlineAgents: string[];
}

async function dialogueRpc(method: string, params: Record<string, unknown>) {
  const res = await apiFetch("/a2a/dialogue-rpc", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id: Date.now(),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (data.error) throw new Error(data.error.message ?? "调用失败");
  return data.result;
}

export function DialoguePanel({ roomId, onlineAgents }: DialoguePanelProps) {
  const [topic, setTopic] = useState("");
  const [initiator, setInitiator] = useState(onlineAgents[0] ?? "");
  const [participant, setParticipant] = useState(onlineAgents[1] ?? "");
  const [maxTurns, setMaxTurns] = useState(6);
  const [loop, setLoop] = useState<MessageLoopState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [injectText, setInjectText] = useState("");
  const pollRef = useRef<number | null>(null);

  const allParticipants = 2; // initiator + participant

  const stopPolling = () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => stopPolling, []);

  useEffect(() => {
    if (!onlineAgents.includes(initiator)) setInitiator(onlineAgents[0] ?? "");
    if (!onlineAgents.includes(participant)) {
      setParticipant(onlineAgents.find((a) => a !== initiator) ?? "");
    }
  }, [onlineAgents, initiator, participant]);

  async function startDialogue() {
    if (!topic.trim()) return;
    setLoading(true);
    setError("");
    try {
      const result = await dialogueRpc("dialogues/run", {
        room_id: roomId,
        initiator_agent: initiator,
        participants: [participant],
        topic: topic.trim(),
        max_turns: maxTurns,
      });
      const dialogueId = result.dialogue_id;
      setLoop({
        loop_id: dialogueId,
        room_id: roomId,
        topic: topic.trim(),
        status: "active",
        current_round: 0,
        max_turns: result.max_turns,
        turns: [],
      });
      stopPolling();
      pollRef.current = window.setInterval(async () => {
        try {
          const status = await dialogueRpc("dialogues/status", { dialogue_id: dialogueId });
          if (status) {
            setLoop((prev) => prev ? {
              ...prev,
              status: status.status,
              current_round: Math.floor((status.turns?.length ?? 0) / allParticipants),
              turns: (status.turns ?? []).map((t: Record<string, unknown>, index: number) => ({
                agent_name: t.agent as string,
                content: t.content as string,
                turn_number: index + 1,
                signals_consensus: t.consensus as boolean,
                conflicts: [],
                timestamp: new Date().toISOString(),
              })),
            } : null);
            if (status.status !== "active") stopPolling();
          }
        } catch { /* 瞬时轮询失败，下一拍重试 */ }
      }, 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动失败");
    } finally {
      setLoading(false);
    }
  }

  async function endDialogue() {
    if (!loop) return;
    setLoading(true);
    setError("");
    try {
      await dialogueRpc("dialogues/end", { dialogue_id: loop.loop_id });
      setLoop((prev) => prev ? { ...prev, status: "canceled" } : null);
      stopPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "结束失败");
    } finally {
      setLoading(false);
    }
  }

  async function injectHumanMessage() {
    if (!loop || !injectText.trim()) return;
    setLoading(true);
    setError("");
    try {
      await dialogueRpc("dialogues/inject", {
        dialogue_id: loop.loop_id,
        content: injectText.trim(),
        sender_type: "human",
      });
      setInjectText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "注入失败");
    } finally {
      setLoading(false);
    }
  }

  async function skipTurn() {
    if (!loop) return;
    setLoading(true);
    setError("");
    try {
      await dialogueRpc("dialogues/skip", { dialogue_id: loop.loop_id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "跳过失败");
    } finally {
      setLoading(false);
    }
  }

  const isActive = loop?.status === "active";

  return (
    <div className="panel-section">
      {!loop && (
        <>
          <div className="field">
            <label>对话主题</label>
            <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="例如：设计登录页面方案" />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>发起方</label>
              <select className="input" value={initiator} onChange={(e) => setInitiator(e.target.value)}>
                {onlineAgents.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>参与方</label>
              <select className="input" value={participant} onChange={(e) => setParticipant(e.target.value)}>
                {onlineAgents.filter((a) => a !== initiator).map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label>最大轮数: {maxTurns}</label>
            <input type="range" min={2} max={20} value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} />
          </div>
          <button type="button" className="btn btn-primary" onClick={startDialogue} disabled={loading || !topic.trim() || onlineAgents.length < 2}>
            <Play size={14} strokeWidth={2} />
            <span>{loading ? "启动中..." : "自动运行对话"}</span>
          </button>
          {onlineAgents.length < 2 && (
            <p className="panel-hint">至少需要 2 个 Agent 在线才能启动对话。</p>
          )}
        </>
      )}

      {loop && (
        <>
          <div
            className={`dialogue-status dialogue-status--${loop.status === "active" ? "active" : loop.status === "consensus" ? "consensus" : ""}`}
            style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
          >
            {isActive ? (
              <>
                <Activity size={14} strokeWidth={2} />
                <span>自动运行中</span>
              </>
            ) : loop.status === "consensus" ? (
              <>
                <CheckCircle2 size={14} strokeWidth={2} />
                <span>已达成共识</span>
              </>
            ) : (
              <>
                <CircleOff size={14} strokeWidth={2} />
                <span>已结束</span>
              </>
            )}
            <span>· 第 ~{loop.current_round}/{loop.max_turns} 轮</span>
          </div>
          <p style={{ fontSize: 13, fontWeight: 600 }}>{loop.topic}</p>
          <p className="panel-hint">Agent 回复会实时出现在聊天区。</p>

          {isActive && (
            <>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={skipTurn} disabled={loading}>
                  <SkipForward size={13} strokeWidth={2} />
                  <span>跳过当前轮</span>
                </button>
                <button type="button" className="btn btn-danger btn-sm" onClick={endDialogue} disabled={loading}>
                  <Square size={12} strokeWidth={2} />
                  <span>停止对话</span>
                </button>
              </div>
              <div className="field">
                <label>注入人类消息</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    className="input"
                    value={injectText}
                    onChange={(e) => setInjectText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && injectHumanMessage()}
                    placeholder="输入你的意见或引导方向..."
                  />
                  <button type="button" className="btn btn-primary btn-sm" onClick={injectHumanMessage} disabled={!injectText.trim() || loading}>
                    注入
                  </button>
                </div>
              </div>
            </>
          )}
          {!isActive && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLoop(null)}>
              开始新对话
            </button>
          )}
        </>
      )}

      {error && <p className="panel-error">{error}</p>}
    </div>
  );
}
