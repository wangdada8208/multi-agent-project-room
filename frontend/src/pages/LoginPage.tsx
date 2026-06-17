import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login, register } from "../lib/api";
import { useAuthStore } from "../stores/authStore";

export function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayNameInput] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const setSession = useAuthStore((state) => state.setSession);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const payload = mode === "register"
        ? await register({
            username: username.trim(),
            password,
            display_name: displayName.trim() || username.trim(),
            user_type: "human",
          })
        : await login({ username: username.trim(), password });
      setSession(payload.user, payload.access_token);
      navigate("/rooms");
    } catch (err) {
      setError(err instanceof Error ? err.message : "认证失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="page-card narrow" style={{ marginTop: "12vh" }}>
      <p className="section-label">欢迎</p>
      <h1 className="card-title">{mode === "login" ? "登录协作空间" : "创建协作账户"}</h1>
      <p className="card-subtitle">
        使用轻量账户进入多人多 Agent 项目房间。
      </p>

      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 16 }}>
        <div>
          <label style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, display: "block", fontWeight: 500 }}>
            用户名
          </label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="例如：wangdada"
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
        {mode === "register" && (
          <div>
            <label style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, display: "block", fontWeight: 500 }}>
              显示名称
            </label>
            <input
              value={displayName}
              onChange={(e) => setDisplayNameInput(e.target.value)}
              placeholder="例如：张三"
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
            />
          </div>
        )}
        <div>
          <label style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, display: "block", fontWeight: 500 }}>
            密码
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 6 位"
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
          />
        </div>

        {error && <p style={{ color: "#dc2626", fontSize: 13, margin: 0 }}>{error}</p>}

        <button
          type="submit"
          disabled={submitting || !username.trim() || !password}
          style={{
            padding: "12px 24px",
            border: "none",
            borderRadius: 10,
            background: "var(--accent-blue)",
            color: "white",
            fontWeight: 600,
            fontSize: 15,
            cursor: submitting ? "wait" : "pointer",
            transition: "background 0.15s",
          }}
          onMouseOver={(e) => e.currentTarget.style.background = "#1d4ed8"}
          onMouseOut={(e) => e.currentTarget.style.background = "var(--accent-blue)"}
        >
          {submitting ? "处理中..." : mode === "login" ? "登录" : "注册并进入"}
        </button>
        <button
          type="button"
          className="link-button"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "没有账户？创建一个" : "已有账户？返回登录"}
        </button>
      </form>
    </section>
  );
}
