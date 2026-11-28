import { useState, type FormEvent } from "react";
import { Eye, EyeOff, KeyRound, Lock } from "lucide-react";
import {
  hasEncryptedVault,
  LEGACY_STORAGE_KEY,
  rememberUnlockedXmtpKey,
  resetLocalXmtpIdentity,
  unlockOrCreateInboxKey,
  xmtpIdentityErrorMessage,
} from "../lib/xmtpLocalIdentity";
import { ConfirmInline } from "./ui/ConfirmInline";

export function XmtpUnlock({ onUnlock }: { onUnlock: (key: string) => void }) {
  const [vaultExists, setVaultExists] = useState(() => hasEncryptedVault());
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keepUnlocked, setKeepUnlocked] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const creating = !vaultExists;
  const migrating = creating && Boolean(localStorage.getItem(LEGACY_STORAGE_KEY));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating && password.length < 10) {
      setError("新口令至少需要 10 个字符");
      return;
    }
    if (creating && password !== confirmation) {
      setError("两次输入的口令不一致，请重新输入");
      return;
    }
    setPending(true);
    setError("");
    try {
      const key = await unlockOrCreateInboxKey(password);
      rememberUnlockedXmtpKey(key, keepUnlocked);
      setPassword("");
      setConfirmation("");
      onUnlock(key);
    } catch (err) {
      setError(xmtpIdentityErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  function handleReset() {
    resetLocalXmtpIdentity();
    setVaultExists(false);
    setConfirmingReset(false);
    setPassword("");
    setConfirmation("");
    setError("");
  }

  const passwordType = showPassword ? "text" : "password";

  return (
    <div className="card unlock-card">
      <h3>
        {creating ? (
          <KeyRound size={18} strokeWidth={1.9} />
        ) : (
          <Lock size={18} strokeWidth={1.9} />
        )}
        <span>{creating ? "给你的私密房间上把锁" : "打开这把房间锁"}</span>
      </h3>
      <p className="unlock-desc">
        {migrating
          ? "现有房间锁会安全迁移，你仍能打开原来的房间。口令只留在当前浏览器，平台看不到你的聊天内容。"
          : creating
            ? "这把锁保护房间里的私密聊天。口令只留在当前浏览器，平台看不到，也不能替你找回。"
            : "输入口令后，这台浏览器才能读懂房间里的加密聊天。口令只留在当前浏览器，平台看不到你的聊天内容。"}
      </p>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="unlock-field">
          <label htmlFor="xmtp-unlock-password">{creating ? "设置口令" : "加密口令"}</label>
          <div className="unlock-password-row">
            <input
              id="xmtp-unlock-password"
              className="input"
              type={passwordType}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={creating ? "至少 10 位" : "输入加密口令"}
              aria-label={creating ? "设置口令" : "加密口令"}
              autoComplete={creating ? "new-password" : "current-password"}
              minLength={creating ? 10 : undefined}
              required
              disabled={pending}
            />
            <button
              type="button"
              className="unlock-eye"
              aria-label={showPassword ? "隐藏口令" : "显示口令"}
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? <EyeOff size={16} strokeWidth={1.9} /> : <Eye size={16} strokeWidth={1.9} />}
            </button>
          </div>
        </div>

        {creating && (
          <div className="unlock-field">
            <label htmlFor="xmtp-unlock-confirm">确认口令</label>
            <input
              id="xmtp-unlock-confirm"
              className="input"
              type={passwordType}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder="再输入一次"
              aria-label="确认口令"
              autoComplete="new-password"
              minLength={10}
              required
              disabled={pending}
            />
          </div>
        )}

        <label className="unlock-keep">
          <input
            type="checkbox"
            checked={keepUnlocked}
            onChange={(event) => setKeepUnlocked(event.target.checked)}
            disabled={pending}
          />
          <span>本次浏览器会话保持打开（关闭浏览器后自动上锁）</span>
        </label>
        <p className="unlock-help">只在当前浏览器有效；退出登录或手动上锁会立即清除。</p>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}

        {!creating && !confirmingReset && (
          <button type="button" className="unlock-reset-link" onClick={() => setConfirmingReset(true)}>
            忘记口令？重设这把房间锁
          </button>
        )}
        {!creating && confirmingReset && (
          <div className="unlock-reset-panel">
            <ConfirmInline confirmLabel="确认重设" onCancel={() => setConfirmingReset(false)} onConfirm={handleReset}>
              <strong>重设这把房间锁？</strong>
              <p>以前的加密聊天将无法再打开，你需要重新加入房间；账号登录不受影响。</p>
            </ConfirmInline>
          </div>
        )}

        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? (creating ? "正在保存…" : "正在解锁…") : creating ? "保存并进入" : "解锁"}
        </button>
      </form>
    </div>
  );
}
