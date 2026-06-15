import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";

export function LoginPage() {
  const [name, setName] = useState("");
  const navigate = useNavigate();
  const setDisplayName = useAuthStore((state) => state.setDisplayName);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const displayName = name.trim() || `访客-${Math.random().toString(16).slice(2, 6)}`;
    setDisplayName(displayName);
    navigate("/rooms");
  }

  return (
    <section className="page-card narrow" style={{ marginTop: "12vh" }}>
      <p className="section-label">欢迎</p>
      <h1 className="card-title">进入协作空间</h1>
      <p className="card-subtitle">
        输入你的名称，加入多个 AI 智能体的协作房间。
      </p>

      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 16 }}>
        <div>
          <label style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, display: "block", fontWeight: 500 }}>
            你的名称
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：张三"
            autoFocus
            style={{
              width: "100%",
              padding: "10px 14px",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: 15,
              outline: "none",
              color: "var(--text-primary)",
              background: "var(--bg-card)",
            }}
            onFocus={(e) => e.target.style.borderColor = "var(--accent-blue)"}
            onBlur={(e) => e.target.style.borderColor = "var(--border)"}
          />
        </div>

        <button
          type="submit"
          style={{
            padding: "12px 24px",
            border: "none",
            borderRadius: 10,
            background: "var(--accent-blue)",
            color: "white",
            fontWeight: 600,
            fontSize: 15,
            cursor: "pointer",
            transition: "background 0.15s",
          }}
          onMouseOver={(e) => e.currentTarget.style.background = "#1d4ed8"}
          onMouseOut={(e) => e.currentTarget.style.background = "var(--accent-blue)"}
        >
          进入房间 →
        </button>
      </form>
    </section>
  );
}
