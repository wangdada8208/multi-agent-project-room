import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAgents, registerAgent } from "../../lib/api";
import { useChatStore } from "../../stores/chatStore";

export function AgentPanel() {
  const queryClient = useQueryClient();
  const participants = useChatStore((state) => state.participants);
  const onlineAgents = new Set(
    participants
      .filter((participant) => participant.sender_type === "agent")
      .map((participant) => participant.sender_name.toLowerCase()),
  );
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    refetchInterval: 5000,
  });
  const registerMutation = useMutation({
    mutationFn: () =>
      registerAgent({
        name: "Codex",
        url: "local://codex",
        capabilities: ["frontend", "agent", "knowledge", "repository"],
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });

  return (
    <section className="side-card">
      <div className="panel-head">
        <div>
          <div className="side-title">Agent 面板</div>
          <div className="side-sub">在线智能体与能力</div>
        </div>
        <button className="mini-button" onClick={() => registerMutation.mutate()}>
          注册 Codex
        </button>
      </div>
      <div className="agent-list">
        {(agentsQuery.data ?? []).map((agent) => {
          const isInCurrentRoom = onlineAgents.has(agent.name.toLowerCase());
          const isRegisteredOnline = agent.status === "online";
          const statusClass = isInCurrentRoom || isRegisteredOnline ? "online" : agent.status;
          const statusText = isInCurrentRoom
            ? "当前房间在线"
            : isRegisteredOnline
              ? "Agent 通道在线"
              : agent.last_seen_at
                ? `最近注册 ${new Date(agent.last_seen_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
                : "未连接";

          return (
            <div className="agent-item" key={agent.id}>
              <span className={`agent-dot ${statusClass}`} />
              <div>
                <div className="agent-name">{agent.name}</div>
                <div className="agent-meta">{statusText}</div>
                <div className="tag-row">
                  {(agent.capabilities ?? []).slice(0, 4).map((capability) => (
                    <span className="tag" key={capability}>{capability}</span>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
        {agentsQuery.isLoading && <p className="muted">正在加载 Agent...</p>}
        {!agentsQuery.isLoading && (agentsQuery.data ?? []).length === 0 && (
          <p className="muted">暂无 Agent，先注册 Codex 或启动适配器。</p>
        )}
      </div>
    </section>
  );
}
