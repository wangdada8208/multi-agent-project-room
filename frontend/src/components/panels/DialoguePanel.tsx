import { useState } from "react";
import type { MessageLoopState } from "../../types/chat";

interface DialoguePanelProps {
  roomId: string;
  onlineAgents: string[];
}

export function DialoguePanel({ roomId, onlineAgents }: DialoguePanelProps) {
  const [topic, setTopic] = useState("");
  const [initiator, setInitiator] = useState(onlineAgents[0] || "Claude");
  const [participant, setParticipant] = useState(onlineAgents[1] || "Codex");
  const [maxTurns, setMaxTurns] = useState(6);
  const [loop, setLoop] = useState<MessageLoopState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function startDialogue() {
    if (!topic.trim()) return;
    setLoading(true);
    setError("");
    try {
      const token = localStorage.getItem("mapr-token") ?? "";
      const res = await fetch("/a2a/dialogue-rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "dialogues/create",
          params: {
            room_id: roomId,
            initiator_agent: initiator,
            participants: [participant],
            max_turns: maxTurns,
            duration_seconds: 120,
          },
          id: Date.now(),
        }),
      });
      const data = await res.json();
      if (data.result) {
        setLoop({
          loop_id: data.result.dialogue_id,
          room_id: roomId,
          topic,
          status: data.result.status,
          current_round: 0,
          max_turns: data.result.max_turns,
          turns: [],
        });
      } else {
        setError(data.error?.message ?? "创建失败");
      }
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  }

  async function endDialogue() {
    if (!loop) return;
    setLoading(true);
    try {
      const token = localStorage.getItem("mapr-token") ?? "";
      await fetch("/a2a/dialogue-rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "dialogues/end",
          params: { dialogue_id: loop.loop_id },
          id: Date.now(),
        }),
      });
      setLoop((prev) => prev ? { ...prev, status: "canceled" } : null);
    } finally {
      setLoading(false);
    }
  }

  const isActive = loop && (loop.status === "active" || loop.status === "pending");

  return (
    <div className="panel-section">
      {!loop && (
        <>
          <div className="panel-field">
            <label>对话主题</label>
            <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="例如：设计登录页面方案" />
          </div>
          <div className="panel-field-row">
            <div className="panel-field">
              <label>发起方</label>
              <select value={initiator} onChange={(e) => setInitiator(e.target.value)}>
                {onlineAgents.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div className="panel-field">
              <label>参与方</label>
              <select value={participant} onChange={(e) => setParticipant(e.target.value)}>
                {onlineAgents.filter((a) => a !== initiator).map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          </div>
          <div className="panel-field">
            <label>最大轮数: {maxTurns}</label>
            <input type="range" min={2} max={20} value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} />
          </div>
          <button type="button" className="btn-primary" onClick={startDialogue} disabled={loading || !topic.trim()}>
            {loading ? "创建中..." : "▶ 启动对话循环"}
          </button>
        </>
      )}

      {loop && (
        <>
          <div className={`dialogue-status dialogue-status--${loop.status}`}>
            {isActive ? "🟢 进行中" : "⚫ 已结束"}
            {" · "}
            第 {loop.current_round}/{loop.max_turns} 轮
          </div>
          <p className="panel-topic">{loop.topic}</p>

          {loop.turns.map((turn, i) => (
            <div key={i} className="dialogue-turn">
              <strong>{turn.agent_name}</strong>
              <span>{turn.signals_consensus ? " ✅共识" : ""}</span>
              {turn.conflicts.length > 0 && <span> ⚠️{turn.conflicts.length}个冲突</span>}
            </div>
          ))}

          {isActive && (
            <button type="button" className="btn-danger" onClick={endDialogue} disabled={loading}>
              ⏹ 停止
            </button>
          )}
        </>
      )}

      {error && <p className="panel-error">{error}</p>}
    </div>
  );
}
