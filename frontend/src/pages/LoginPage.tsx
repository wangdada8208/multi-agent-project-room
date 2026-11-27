import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Infinity as InfinityIcon, Link2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import {
  fetchAuthProviders,
  login,
  loginWithEmailCode,
  loginWithGoogle,
  register,
  registerWithEmail,
  sendEmailCode,
} from "../lib/api";
import heroPainting from "../assets/paintings/hero-mist-valley.webp";
import { useAuthStore } from "../stores/authStore";
import "./LoginPage.css";

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
const OTP_LENGTH = 6;

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

export function resolveSafeNext(raw: string | null): string {
  if (!raw) return "/home";
  const trimmed = raw.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/login")) {
    return trimmed;
  }
  return "/home";
}

function OtpCodeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: OTP_LENGTH }, (_, i) => value[i] ?? "");

  function focusAt(index: number) {
    const clamped = Math.max(0, Math.min(OTP_LENGTH - 1, index));
    refs.current[clamped]?.focus();
  }

  function updateAt(index: number, raw: string) {
    const cleaned = raw.replace(/\D/g, "");
    if (!cleaned) {
      const next = [...digits];
      next[index] = "";
      onChange(next.join(""));
      return;
    }
    const next = [...digits];
    let cursor = index;
    for (const ch of cleaned) {
      if (cursor >= OTP_LENGTH) break;
      next[cursor] = ch;
      cursor += 1;
    }
    onChange(next.join("").slice(0, OTP_LENGTH));
    if (cursor < OTP_LENGTH) focusAt(cursor);
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      event.preventDefault();
      const next = [...digits];
      next[index - 1] = "";
      onChange(next.join(""));
      focusAt(index - 1);
    } else if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "ArrowRight" && index < OTP_LENGTH - 1) {
      event.preventDefault();
      focusAt(index + 1);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, OTP_LENGTH);
    if (!pasted) return;
    event.preventDefault();
    onChange(pasted);
    focusAt(Math.min(pasted.length, OTP_LENGTH - 1));
  }

  return (
    <div className="wb-otp-grid" role="group" aria-label="6 位邮箱验证码">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => {
            refs.current[index] = el;
          }}
          className="wb-otp-cell"
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          maxLength={OTP_LENGTH}
          aria-label={`验证码第 ${index + 1} 位`}
          value={digit}
          disabled={disabled}
          onChange={(e) => updateAt(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={handlePaste}
        />
      ))}
    </div>
  );
}

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const initialMode = searchParams.get("mode") === "register" ? "register" : "login";
  const nextPath = resolveSafeNext(searchParams.get("next"));

  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [loginMethod, setLoginMethod] = useState<"email_code" | "password">("email_code");
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

  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [googleClientId, setGoogleClientId] = useState("");
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
        const allowGoogle = Boolean(providers.google_enabled && cid);
        setGoogleEnabled(allowGoogle);
        setGoogleClientId(allowGoogle ? cid : "");
        if (!providers.email_enabled) {
          setLoginMethod((prev) => (prev === "email_code" ? "password" : prev));
          setRegisterMethod((prev) => (prev === "email" ? "username" : prev));
        }
      })
      .catch(() => {
        if (!active) return;
        setGoogleEnabled(false);
        setGoogleClientId("");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!googleEnabled || !googleClientId) {
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
  }, [googleEnabled, googleClientId]);

  useEffect(() => {
    if (!googleReady || !googleClientId || !googleButtonRef.current || !window.google?.accounts?.id) {
      return;
    }
    const container = googleButtonRef.current;
    container.replaceChildren();
    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: (resp) => googleHandlerRef.current(resp),
    });
    window.google.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      shape: "rectangular",
      text: mode === "register" ? "signup_with" : "signin_with",
      width: 336,
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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
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

  const isSubmitDisabled = (() => {
    if (submitting) return true;
    if (mode === "register") {
      if (registerMethod === "email") {
        return !email.trim() || code.trim().length < OTP_LENGTH || !password;
      }
      return !identifier.trim() || !password;
    }
    if (loginMethod === "email_code") {
      return !email.trim() || code.trim().length < OTP_LENGTH;
    }
    return !identifier.trim() || !password;
  })();

  const showGoogleSection = googleEnabled && Boolean(googleClientId);
  const hasInviteTarget = nextPath.startsWith("/rooms/");

  return (
    <div className="wb-auth">
      <header className="wb-auth__top">
        <Link to="/" className="wb-auth__brand">
          <span className="wb-auth__mark" aria-hidden="true">
            <InfinityIcon size={16} strokeWidth={2.1} />
          </span>
          <span>Project Room</span>
        </Link>
        <Link to="/" className="ui-button ui-button--ghost ui-button--sm">
          <ArrowLeft size={14} strokeWidth={1.9} />
          <span>返回首页</span>
        </Link>
      </header>

      <main className="wb-auth__center">
        <div className="wb-auth-gallery">
          <aside className="wb-auth-art" aria-hidden="true">
            <img src={heroPainting} alt="" />
            <div className="wb-auth-art__wash" />
            <div className="wb-auth-art__copy">
              <span>Multi-Agent Project Room</span>
              <strong>带上你的 Agent，一起把事做完。</strong>
              <p>端到端加密 · 房主审批 · 代码留本地</p>
            </div>
          </aside>
        <section className="wb-auth-card" aria-label={mode === "login" ? "登录" : "注册"}>
          <h1>{mode === "login" ? "登录 Project Room" : "创建账户"}</h1>
          <p className="wb-auth-card__sub">
            {mode === "login" ? "首次登录会自动为你创建账户。" : "端到端加密 · 和你的 Agent 一起工作"}
          </p>

          {hasInviteTarget && (
            <span className="wb-auth-card__next-pill">
              <Link2 size={12} strokeWidth={2} aria-hidden="true" />
              登录后将自动回到邀请房间
            </span>
          )}

          {showGoogleSection && (
            <>
              <div className="wb-auth-google">
                {googleReady ? (
                  <div className="wb-auth-google__slot" ref={googleButtonRef} />
                ) : (
                  <button
                    type="button"
                    className="wb-auth-google__fallback"
                    disabled
                  >
                    使用 Google 继续
                  </button>
                )}
              </div>
              <div className="wb-auth-or">或使用邮箱</div>
            </>
          )}

          <form
            className={showGoogleSection ? "wb-auth-form wb-auth-form--after-or" : "wb-auth-form"}
            onSubmit={handleSubmit}
          >
            {mode === "login" && loginMethod === "email_code" && (
              <>
                <div className="wb-auth-field">
                  <label htmlFor="auth-email">邮箱</label>
                  <input
                    id="auth-email"
                    className="wb-auth-input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    autoFocus
                  />
                </div>

                <div className="wb-auth-field">
                  <div className="wb-auth-field__head">
                    <label>
                      验证码
                      {notice && <span className="wb-auth-field__meta"> · 10 分钟内有效</span>}
                    </label>
                    <button
                      type="button"
                      className="wb-auth-link-btn"
                      disabled={sendingCode || activeCooldown > 0 || !email.trim()}
                      onClick={() => void handleSendCode()}
                    >
                      {sendingCode
                        ? "发送中…"
                        : activeCooldown > 0
                          ? `重新发送（${activeCooldown} 秒）`
                          : "获取验证码"}
                    </button>
                  </div>
                  <OtpCodeInput value={code} onChange={setCode} disabled={submitting} />
                </div>
              </>
            )}

            {mode === "login" && loginMethod === "password" && (
              <>
                <div className="wb-auth-field">
                  <label htmlFor="auth-identifier">邮箱或用户名</label>
                  <input
                    id="auth-identifier"
                    className="wb-auth-input"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="输入邮箱或用户名"
                    autoComplete="username"
                    autoFocus
                  />
                </div>

                <div className="wb-auth-field">
                  <label htmlFor="auth-password">密码</label>
                  <input
                    id="auth-password"
                    className="wb-auth-input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="输入密码"
                    autoComplete="current-password"
                  />
                </div>
              </>
            )}

            {mode === "register" && registerMethod === "email" && (
              <>
                <div className="wb-auth-field">
                  <label htmlFor="auth-reg-email">邮箱</label>
                  <input
                    id="auth-reg-email"
                    className="wb-auth-input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    autoFocus
                  />
                </div>

                <div className="wb-auth-field">
                  <div className="wb-auth-field__head">
                    <label>邮箱验证码</label>
                    <button
                      type="button"
                      className="wb-auth-link-btn"
                      disabled={sendingCode || activeCooldown > 0 || !email.trim()}
                      onClick={() => void handleSendCode()}
                    >
                      {sendingCode
                        ? "发送中…"
                        : activeCooldown > 0
                          ? `重新发送（${activeCooldown} 秒）`
                          : "获取验证码"}
                    </button>
                  </div>
                  <OtpCodeInput value={code} onChange={setCode} disabled={submitting} />
                </div>

                <div className="wb-auth-field">
                  <label htmlFor="auth-display-name">显示名称（可选）</label>
                  <input
                    id="auth-display-name"
                    className="wb-auth-input"
                    value={displayName}
                    onChange={(e) => setDisplayNameInput(e.target.value)}
                    placeholder="群内展示的称呼"
                    autoComplete="name"
                  />
                </div>

                <div className="wb-auth-field">
                  <label htmlFor="auth-reg-password">设置密码</label>
                  <input
                    id="auth-reg-password"
                    className="wb-auth-input"
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
                <div className="wb-auth-field">
                  <label htmlFor="auth-username">用户名</label>
                  <input
                    id="auth-username"
                    className="wb-auth-input"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="输入用户名"
                    autoComplete="username"
                    autoFocus
                  />
                </div>

                <div className="wb-auth-field">
                  <label htmlFor="auth-user-display-name">显示名称（可选）</label>
                  <input
                    id="auth-user-display-name"
                    className="wb-auth-input"
                    value={displayName}
                    onChange={(e) => setDisplayNameInput(e.target.value)}
                    placeholder="群内展示的称呼"
                    autoComplete="name"
                  />
                </div>

                <div className="wb-auth-field">
                  <label htmlFor="auth-user-password">设置密码</label>
                  <input
                    id="auth-user-password"
                    className="wb-auth-input"
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
              <div className="wb-auth-notice" role="status">
                {notice}
              </div>
            )}

            {error && (
              <div className="wb-auth-error" role="alert">
                {error}
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="wb-auth-submit"
              loading={submitting}
              disabled={isSubmitDisabled}
            >
              {mode === "login" ? "登录" : "创建账户并继续"}
            </Button>
          </form>

          <div className="wb-auth-links">
            {mode === "login" ? (
              <button
                type="button"
                className="wb-auth-link-btn"
                onClick={() => {
                  setLoginMethod((m) => (m === "email_code" ? "password" : "email_code"));
                  setError("");
                  setNotice("");
                }}
              >
                {loginMethod === "email_code" ? "改用密码登录" : "改用邮箱验证码登录"}
              </button>
            ) : (
              <button
                type="button"
                className="wb-auth-link-btn"
                onClick={() => {
                  setRegisterMethod((m) => (m === "email" ? "username" : "email"));
                  setError("");
                  setNotice("");
                }}
              >
                {registerMethod === "email" ? "改用用户名注册" : "改用邮箱验证码注册"}
              </button>
            )}

            <button
              type="button"
              className="wb-auth-link-btn"
              onClick={() => {
                setMode((m) => (m === "login" ? "register" : "login"));
                setError("");
                setNotice("");
                setCode("");
              }}
            >
              {mode === "login" ? "注册账号" : "已有账号？去登录"}
            </button>
          </div>

          <p className="wb-auth-foot">
            收到邀请链接？登录后会自动跳回对应房间。
          </p>
        </section>
        </div>
      </main>
    </div>
  );
}
