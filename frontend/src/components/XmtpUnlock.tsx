import { useState } from "react";
import { KeyRound, Lock } from "lucide-react";
import { hasEncryptedVault, LEGACY_STORAGE_KEY, unlockOrCreateInboxKey } from "../lib/xmtpLocalIdentity";

export function XmtpUnlock({ onUnlock }: { onUnlock: (key: string) => void }) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const creating = !hasEncryptedVault();
  const migrating = creating && Boolean(localStorage.getItem(LEGACY_STORAGE_KEY));

  return (
    <div className="card unlock-card">
      <h3>
        {creating ? (
          <KeyRound size={18} strokeWidth={1.9} color="var(--accent)" />
        ) : (
          <Lock size={18} strokeWidth={1.9} color="var(--accent)" />
        )}
        <span>{creating ? "设置本机加密口令" : "解锁加密身份"}</span>
      </h3>
      <p className="unlock-desc">
        {migrating
          ? "现有身份会加密迁移，保留原群访问权限。解锁后将在浏览器本地生成端到端加密密钥，无需安装数字钱包插件。"
          : "解锁后将在浏览器本地生成端到端加密密钥，无需安装数字钱包插件。口令和密钥仅保存在本机浏览器，服务器不可见；忘记口令后无法找回，请妥善保存。"}
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          setError("");
          try {
            const key = await unlockOrCreateInboxKey(password);
            setPassword("");
            onUnlock(key);
          } catch (err) {
            setError(err instanceof Error ? err.message : "无法解锁身份");
          } finally {
            setPending(false);
          }
        }}
      >
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={creating ? "设置口令（至少 10 位）" : "输入加密口令"}
          autoComplete={creating ? "new-password" : "current-password"}
          minLength={creating ? 10 : undefined}
          required
          disabled={pending}
        />
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "正在解锁…" : creating ? "保存并进入" : "解锁"}
        </button>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
