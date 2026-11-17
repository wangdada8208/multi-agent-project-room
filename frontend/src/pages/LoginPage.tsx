import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { login, register } from "../lib/api";
import { useAuthStore } from "../stores/authStore";

function resolveSafeNext(raw: string | null): string {
  if (!raw) return "/home";
  const trimmed = raw.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/login")) {
    return trimmed;
  }
  return "/home";
}

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const initialMode = searchParams.get("mode") === "register" ? "register" : "login";
  const nextPath = resolveSafeNext(searchParams.get("next"));

  const [mode, setMode] = useState<"login" | "register">(initialMode);
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
      navigate(nextPath, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "认证失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  function switchMode(target: "login" | "register") {
    setMode(target);
    setError("");
  }

  return (
    <div className="auth-page">
      <Link to="/" className="auth-back">
        <ArrowLeft size={15} strokeWidth={1.9} />
        返回首页
      </Link>

      <div className="card auth-card">
        <div className="auth-logo" aria-hidden="true">
          <ShieldCheck size={22} strokeWidth={1.8} />
        </div>
        <h1>{mode === "login" ? "登录协作空间" : "创建协作账户"}</h1>
        <p className="auth-sub">端到端加密 · 多人多 Agent 协作房间</p>

        <div className="segmented" role="tablist" aria-label="登录或注册">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={`segmented__btn ${mode === "login" ? "segmented__btn--active" : ""}`}
            onClick={() => switchMode("login")}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={`segmented__btn ${mode === "register" ? "segmented__btn--active" : ""}`}
            onClick={() => switchMode("register")}
          >
            注册账号
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="auth-username">用户名</label>
            <input
              id="auth-username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="输入用户名"
              autoComplete="username"
              autoFocus
            />
          </div>

          {mode === "register" && (
            <div className="field">
              <label htmlFor="auth-display-name">显示名称（可选）</label>
              <input
                id="auth-display-name"
                className="input"
                value={displayName}
                onChange={(e) => setDisplayNameInput(e.target.value)}
                placeholder="群内展示的称呼"
                autoComplete="name"
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="auth-password">密码</label>
            <input
              id="auth-password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "至少 8 位字符" : "输入密码"}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
            />
          </div>

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || !username.trim() || !password}
          >
            {submitting ? "处理中…" : mode === "login" ? "继续" : "创建账户并继续"}
          </button>
        </form>
      </div>
    </div>
  );
}
