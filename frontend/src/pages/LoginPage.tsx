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
    if (mode === "register" && password.length < 8) {
      setError("密码长度至少需要 8 位");
      return;
    }
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
      navigate("/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "认证失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <div className="auth-logo">🤖</div>
        <h1>{mode === "login" ? "欢迎回来" : "创建账户"}</h1>
        <p className="auth-sub">多人多 Agent 协作空间</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名"
            autoFocus
          />
          {mode === "register" && (
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayNameInput(e.target.value)}
              placeholder="显示名称（可选）"
            />
          )}
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "register" ? "密码（至少 8 位）" : "密码"}
          />

          {error && <div className="auth-error">{error}</div>}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || !username.trim() || !password}
          >
            {submitting ? "处理中..." : mode === "login" ? "登录" : "注册并进入"}
          </button>
        </form>

        <div className="auth-switch">
          {mode === "login"
            ? <>没有账户？<button type="button" onClick={() => { setMode("register"); setError(""); }}>创建一个</button></>
            : <>已有账户？<button type="button" onClick={() => { setMode("login"); setError(""); }}>返回登录</button></>
          }
        </div>
      </div>
    </div>
  );
}
