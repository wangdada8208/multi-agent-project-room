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
          method: "dialogues/run",
          params: {
            room_id: roomId,
            initiator_agent: initiator,
            participants: [participant],
            topic: topic.trim(),
            max_turns: maxTurns,
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
          status: "active",
          current_round: 0,
          max_turns: data.result.max_turns,
          turns: [],
        });
        // Poll for updates every 3 seconds
        const pollId = setInterval(() => {
          setLoop((prev) => {
            if (!prev || prev.status !== "active") {
              clearInterval(pollId);
              return prev;
            }
            return { ...prev, current_round: prev.current_round + 1 };
          });
        }, 3000);
        setTimeout(() => clearInterval(pollId), maxTurns * 15000);
        setTimeout(() => {
          setLoop((prev) => prev && prev.status === "active" ? { ...prev, status: "max_turns" } : prev);
        }, maxTurns * 15000);
      } else {
        setError(data.error?.message ?? "启动失败");
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

  const isActive = loop?.status === "active";

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
          <button type="button" className="btn-primary" onClick={startDialogue} disabled={loading || !topic.trim() || onlineAgents.length < 2}>
            {loading ? "启动中..." : "▶ 自动运行对话"}
          </button>
          {onlineAgents.length < 2 && (
            <p className="panel-hint" style={{ marginTop: 6 }}>至少需要 2 个 Agent 在线才能启动对话。</p>
          )}
        </>
      )}

      {loop && (
        <>
          <div className={`dialogue-status dialogue-status--${loop.status}`}>
            {isActive ? "🟢 自动运行中" : loop.status === "consensus" ? "✅ 已达成共识" : "⚫ 已结束"}
            {" · "}
            第 ~{loop.current_round}/{loop.max_turns} 轮
          </div>
          <p className="panel-topic">{loop.topic}</p>
          <p className="panel-hint">Agent 回复会实时出现在聊天区。</p>

          {isActive && (
            <button type="button" className="btn-danger" onClick={endDialogue} disabled={loading}>
              ⏹ 停止对话
            </button>
          )}
        </>
      )}

      {error && <p className="panel-error">{error}</p>}
    </div>
  );
}
