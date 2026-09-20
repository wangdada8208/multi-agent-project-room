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
      setError("密码长度至少需要 8 位，请重新输入");
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
      navigate("/rooms");
    } catch (err) {
      setError(err instanceof Error ? err.message : "认证失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <span>◈</span>
          <h1>{mode === "login" ? "欢迎回来" : "创建账户"}</h1>
          <p>多人多 Agent 协作空间</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名"
            autoFocus
          />

          {mode === "register" && (
            <input
              value={displayName}
              onChange={(e) => setDisplayNameInput(e.target.value)}
              placeholder="显示名称（可选）"
            />
          )}

          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
          />

          {error && <div className="login-error">{error}</div>}

          <button
            type="submit"
            className="btn-primary"
            disabled={submitting || !username.trim() || !password}
          >
            {submitting ? "处理中..." : mode === "login" ? "登录" : "注册并进入"}
          </button>
        </form>

        <div className="login-switch">
          {mode === "login"
            ? <>没有账户？<button onClick={() => setMode("register")}>创建一个</button></>
            : <>已有账户？<button onClick={() => setMode("login")}>返回登录</button></>
          }
        </div>
      </div>
    </div>
  );
}
