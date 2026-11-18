import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import {
  fetchAuthProviders,
  login,
  loginWithEmailCode,
  loginWithGoogle,
  register,
  registerWithEmail,
  sendEmailCode,
} from "../lib/api";
import { useAuthStore } from "../stores/authStore";

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              theme?: string;
              size?: string;
              shape?: string;
              text?: string;
              width?: number;
            },
          ) => void;
        };
      };
    };
  }
}

const GIS_SCRIPT_ID = "mapr-google-gsi-script";
const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const GIS_LOAD_TIMEOUT_MS = 8000;

let gisLoadPromise: Promise<boolean> | null = null;

function loadGoogleIdentityScript(): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.resolve(false);
  }
  if (window.google?.accounts?.id) {
    return Promise.resolve(true);
  }
  if (gisLoadPromise) {
    return gisLoadPromise;
  }
  gisLoadPromise = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (!ok) {
        gisLoadPromise = null;
      }
      resolve(ok);
    };

    const timer = window.setTimeout(() => finish(false), GIS_LOAD_TIMEOUT_MS);

    const existing = document.getElementById(GIS_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => finish(Boolean(window.google?.accounts?.id)), { once: true });
      existing.addEventListener("error", () => finish(false), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = GIS_SCRIPT_ID;
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => finish(Boolean(window.google?.accounts?.id));
    script.onerror = () => finish(false);
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

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
  const [loginMethod, setLoginMethod] = useState<"password" | "email_code">("password");
  const [registerMethod, setRegisterMethod] = useState<"email" | "username">("email");

  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [displayName, setDisplayNameInput] = useState("");
  const [password, setPassword] = useState("");

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [cooldowns, setCooldowns] = useState<{ register: number; login: number }>({
    register: 0,
    login: 0,
  });

  const [googleClientId, setGoogleClientId] = useState(
    () => (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "").trim(),
  );
  const [googleReady, setGoogleReady] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement | null>(null);

  const navigate = useNavigate();
  const setSession = useAuthStore((state) => state.setSession);

  const googleHandlerRef = useRef<(response: { credential?: string }) => void>(() => {});
  googleHandlerRef.current = async (response) => {
    const credential = response?.credential?.trim();
    if (!credential) {
      setError("未获取到 Google 登录凭证，请重试");
      return;
    }
    setError("");
    setNotice("");
    setSubmitting(true);
    try {
      const payload = await loginWithGoogle(credential);
      setSession(payload.user, payload.access_token);
      navigate(nextPath, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google 登录失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    let active = true;
    fetchAuthProviders()
      .then((providers) => {
        if (!active) return;
        const cid = (providers.google_client_id || "").trim();
        if (cid) {
          setGoogleClientId(cid);
        }
      })
      .catch(() => {
        // Ignore provider probe errors; local auth forms remain usable.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!googleClientId) {
      setGoogleReady(false);
      return;
    }
    let cancelled = false;
    loadGoogleIdentityScript().then((ok) => {
      if (cancelled) return;
      setGoogleReady(Boolean(ok && window.google?.accounts?.id));
    });
    return () => {
      cancelled = true;
    };
  }, [googleClientId]);

  useEffect(() => {
    if (!googleReady || !googleClientId || !googleButtonRef.current || !window.google?.accounts?.id) {
      return;
    }
    const container = googleButtonRef.current;
    container.innerHTML = "";
    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: (resp) => googleHandlerRef.current(resp),
    });
    window.google.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      shape: "pill",
      text: mode === "register" ? "signup_with" : "signin_with",
      width: 330,
    });
  }, [googleReady, googleClientId, mode]);

  useEffect(() => {
    if (cooldowns.register <= 0 && cooldowns.login <= 0) return;
    const timer = window.setInterval(() => {
      setCooldowns((prev) => ({
        register: prev.register > 0 ? prev.register - 1 : 0,
        login: prev.login > 0 ? prev.login - 1 : 0,
      }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldowns.register > 0, cooldowns.login > 0]);

  const activePurpose = mode === "register" ? "register" : "login";
  const activeCooldown = cooldowns[activePurpose];

  async function handleSendCode() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      setError("请先输入有效的邮箱地址");
      return;
    }
    setError("");
    setNotice("");
    setSendingCode(true);
    try {
      const res = await sendEmailCode({ email: trimmedEmail, purpose: activePurpose });
      const waitSeconds = res.cooldown_seconds > 0 ? res.cooldown_seconds : 60;
      setCooldowns((prev) => ({ ...prev, [activePurpose]: waitSeconds }));
      setNotice("验证码已发送至邮箱，10 分钟内有效");
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送验证码失败，请稍后重试");
    } finally {
      setSendingCode(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");

    if (mode === "register" && password.length < 8) {
      setError("密码长度至少需要 8 位");
      return;
    }

    setSubmitting(true);
    try {
      let payload;
      if (mode === "register") {
        if (registerMethod === "email") {
          payload = await registerWithEmail({
            email: email.trim(),
            code: code.trim(),
            password,
            display_name: displayName.trim() || undefined,
          });
        } else {
          payload = await register({
            username: identifier.trim(),
            password,
            display_name: displayName.trim() || identifier.trim(),
            user_type: "human",
          });
        }
      } else if (loginMethod === "email_code") {
        payload = await loginWithEmailCode({
          email: email.trim(),
          code: code.trim(),
        });
      } else {
        payload = await login({
          username: identifier.trim(),
          password,
        });
      }

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
    setNotice("");
    setCode("");
  }

  const isSubmitDisabled = (() => {
    if (submitting) return true;
    if (mode === "register") {
      if (registerMethod === "email") {
        return !email.trim() || code.trim().length < 6 || !password;
      }
      return !identifier.trim() || !password;
    }
    if (loginMethod === "email_code") {
      return !email.trim() || code.trim().length < 6;
    }
    return !identifier.trim() || !password;
  })();

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
          {mode === "login" && loginMethod === "password" && (
            <>
              <div className="field">
                <label htmlFor="auth-identifier">邮箱或用户名</label>
                <input
                  id="auth-identifier"
                  className="input"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="输入邮箱或用户名"
                  autoComplete="username"
                  autoFocus
                />
              </div>

              <div className="field">
                <label htmlFor="auth-password">密码</label>
                <input
                  id="auth-password"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入密码"
                  autoComplete="current-password"
                />
              </div>
            </>
          )}

          {mode === "login" && loginMethod === "email_code" && (
            <>
              <div className="field">
                <label htmlFor="auth-email">邮箱</label>
                <input
                  id="auth-email"
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                />
              </div>

              <div className="field">
                <label htmlFor="auth-email-code">邮箱验证码</label>
                <div className="auth-inline-row">
                  <input
                    id="auth-email-code"
                    className="input"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="6 位数字验证码"
                    autoComplete="one-time-code"
                  />
                  <button
                    type="button"
                    className="auth-code-btn"
                    disabled={sendingCode || activeCooldown > 0 || !email.trim()}
                    onClick={handleSendCode}
                  >
                    {sendingCode
                      ? "发送中…"
                      : activeCooldown > 0
                        ? `${activeCooldown}s 后重发`
                        : "获取验证码"}
                  </button>
                </div>
              </div>
            </>
          )}

          {mode === "register" && registerMethod === "email" && (
            <>
              <div className="field">
                <label htmlFor="auth-email">邮箱</label>
                <input
                  id="auth-email"
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus
                />
              </div>

              <div className="field">
                <label htmlFor="auth-email-code">邮箱验证码</label>
                <div className="auth-inline-row">
                  <input
                    id="auth-email-code"
                    className="input"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="6 位数字验证码"
                    autoComplete="one-time-code"
                  />
                  <button
                    type="button"
                    className="auth-code-btn"
                    disabled={sendingCode || activeCooldown > 0 || !email.trim()}
                    onClick={handleSendCode}
                  >
                    {sendingCode
                      ? "发送中…"
                      : activeCooldown > 0
                        ? `${activeCooldown}s 后重发`
                        : "获取验证码"}
                  </button>
                </div>
              </div>

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

              <div className="field">
                <label htmlFor="auth-password">设置密码</label>
                <input
                  id="auth-password"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 8 位字符"
                  autoComplete="new-password"
                />
              </div>
            </>
          )}

          {mode === "register" && registerMethod === "username" && (
            <>
              <div className="field">
                <label htmlFor="auth-username">用户名</label>
                <input
                  id="auth-username"
                  className="input"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="输入用户名"
                  autoComplete="username"
                  autoFocus
                />
              </div>

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

              <div className="field">
                <label htmlFor="auth-password">密码</label>
                <input
                  id="auth-password"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 8 位字符"
                  autoComplete="new-password"
                />
              </div>
            </>
          )}

          {notice && (
            <div className="auth-notice" role="status">
              {notice}
            </div>
          )}

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary" disabled={isSubmitDisabled}>
            {submitting ? "处理中…" : mode === "login" ? "继续" : "创建账户并继续"}
          </button>
        </form>

        <div className="auth-method-toggle">
          {mode === "login" ? (
            <button
              type="button"
              onClick={() => {
                setLoginMethod((m) => (m === "password" ? "email_code" : "password"));
                setError("");
                setNotice("");
              }}
            >
              {loginMethod === "password" ? "使用邮箱验证码免密登录" : "使用密码登录"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setRegisterMethod((m) => (m === "email" ? "username" : "email"));
                setError("");
                setNotice("");
              }}
            >
              {registerMethod === "email" ? "改用传统用户名注册" : "使用邮箱验证码注册"}
            </button>
          )}
        </div>

        {googleClientId && googleReady && (
          <div>
            <div className="auth-divider">或</div>
            <div className="auth-google-slot" ref={googleButtonRef} />
          </div>
        )}
      </div>
    </div>
  );
}
