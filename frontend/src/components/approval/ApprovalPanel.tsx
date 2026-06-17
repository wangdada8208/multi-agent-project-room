import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { decideApproval, fetchApprovals } from "../../lib/api";

export function ApprovalPanel({ roomId }: { roomId: string }) {
  const queryClient = useQueryClient();
  const approvalsQuery = useQuery({
    queryKey: ["rooms", roomId, "approvals"],
    queryFn: () => fetchApprovals(roomId),
    refetchInterval: 15000,
  });
  const decideMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approved" | "rejected" }) =>
      decideApproval(id, decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["rooms", roomId, "approvals"] }),
  });

  const approvals = approvalsQuery.data ?? [];
  const pending = approvals.filter((approval) => approval.status === "pending");
  const handled = approvals.filter((approval) => approval.status !== "pending");

  return (
    <section className="side-card">
      <div className="side-title">审批</div>
      {[...pending, ...handled].slice(0, 6).map((approval) => (
        <div className="approval-card" key={approval.id}>
          <div className="approval-top">
            <strong>{approval.title}</strong>
            <span className={`approval-status ${approval.status}`}>{approval.status}</span>
          </div>
          <p>{approval.description || "无描述"}</p>
          {approval.metadata?.risk_summary && (
            <p className="approval-meta">{approval.metadata.risk_summary}</p>
          )}
          {approval.metadata?.task_id && (
            <small>关联任务: {approval.metadata.task_id.slice(0, 8)}</small>
          )}
          {approval.status === "pending" && (
            <div className="approval-actions">
              <button onClick={() => decideMutation.mutate({ id: approval.id, decision: "approved" })}>批准</button>
              <button className="danger" onClick={() => decideMutation.mutate({ id: approval.id, decision: "rejected" })}>拒绝</button>
            </div>
          )}
        </div>
      ))}
      {approvals.length === 0 && <p className="muted">暂无审批请求。</p>}
    </section>
  );
}
