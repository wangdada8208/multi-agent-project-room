import { useQuery } from "@tanstack/react-query";
import { fetchGitLog, fetchGitStatus } from "../../lib/api";

export function RepositoryPanel({ roomId }: { roomId: string }) {
  const statusQuery = useQuery({
    queryKey: ["rooms", roomId, "git", "status"],
    queryFn: () => fetchGitStatus(roomId),
    refetchInterval: 30000,
  });
  const logQuery = useQuery({
    queryKey: ["rooms", roomId, "git", "log"],
    queryFn: () => fetchGitLog(roomId),
    refetchInterval: 30000,
  });
  const status = statusQuery.data;

  return (
    <section className="side-card">
      <div className="side-title">Git 仓库</div>
      {status ? (
        <>
          <div className="repo-branch">当前分支：<strong>{status.branch}</strong></div>
          {status.last_commit && (
            <div className="commit-card">
              <span>{status.last_commit.short_hash}</span>
              <p>{status.last_commit.message}</p>
            </div>
          )}
          <div className="change-list">
            {status.changes.length === 0 && <p className="muted">工作区干净。</p>}
            {status.changes.slice(0, 8).map((change) => (
              <div className="change-item" key={`${change.status}-${change.path}`}>
                <span>{change.status}</span>
                <code>{change.path}</code>
              </div>
            ))}
          </div>
          <div className="commit-list">
            {(logQuery.data ?? []).map((commit) => (
              <div className="commit-row" key={commit.hash}>
                <span>{commit.short_hash}</span>
                <p>{commit.message}</p>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">正在读取仓库状态...</p>
      )}
    </section>
  );
}
