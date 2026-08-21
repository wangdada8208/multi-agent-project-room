import type { RoomTask } from "../../types/chat";

const STATUS_MAP: Record<string, string> = {
  submitted: "已提交",
  working: "处理中",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
  input_required: "待审批",
};

const STATUS_CLASS: Record<string, string> = {
  submitted: "task-badge--submitted",
  working: "task-badge--working",
  completed: "task-badge--completed",
  failed: "task-badge--failed",
};

export function TasksPanel({ tasks }: { tasks: RoomTask[] }) {
  if (tasks.length === 0) {
    return <p className="panel-empty">暂无任务，@Agent 后会出现在这里。</p>;
  }

  return (
    <div className="panel-section">
      {tasks.map((task) => (
        <div key={task.id} className="task-card">
          <div className="task-card__top">
            <strong>{task.target_agent || task.source_agent}</strong>
            <span className={`task-badge ${STATUS_CLASS[task.status] ?? ""}`}>
              {STATUS_MAP[task.status] ?? task.status}
            </span>
          </div>
          <p className="task-card__query">{task.query}</p>
        </div>
      ))}
    </div>
  );
}
