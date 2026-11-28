import { RefreshCw, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import type { TimedPairingCode } from "../../hooks/agents/useLocalAgents";
import { useLocalHelper } from "../../hooks/useLocalHelper";
import {
  PAIRING_EXPIRED,
  pairingCountdown,
  powershellInstallCommand,
  shellInstallCommand,
  type HelperHandoffAction,
  type HelperProbe,
} from "../../lib/localHelper";
import { CopyButton } from "../CopyButton";
import { HelperIntroDemo } from "../HelperIntroDemo";
import { HelperLink } from "../HelperLink";
import { Button } from "../ui/Button";
import { Segmented } from "../ui/Segmented";

export const PAIRING_TROUBLESHOOT_AFTER_SECONDS = 75;

function probeStatusLabel(probe: HelperProbe | null): string {
  if (!probe) return "正在首次探测";
  if (probe.state === "running") return "已检测到本机助手";
  if (probe.state === "blocked") return "浏览器拦截了本机访问";
  return "未检测到本机助手";
}

function TroubleshootingCard({ onGenerate }: { onGenerate: () => void }) {
  return (
    <section className="wb-pairing-trouble" aria-label="本地配对排查">
      <h4>等待超过 {PAIRING_TROUBLESHOOT_AFTER_SECONDS} 秒，仍未检测到本机助手</h4>
      <p>后台仍会自动探测。先按顺序检查这 4 件事，完成后点「立即重新检测」。</p>
      <ol>
        <li>
          <strong>命令是否完整运行</strong>
          <span>确认整行命令已粘贴到「终端」并按回车，终端没有停在确认或密码输入。</span>
        </li>
        <li>
          <strong>是否装有 Node 22+</strong>
          <span>在终端运行 <code>node --version</code>；低于 v22 时先升级 Node。</span>
        </li>
        <li>
          <strong>是否在同一台电脑上运行</strong>
          <span>命令必须在当前浏览器所在电脑的终端执行，不是在另一台设备或云终端。</span>
        </li>
        <li>
          <strong>点此重新生成配对码</strong>
          <span>旧配对码可能已过期或已经使用。生成后请重新复制整行命令。</span>
          <Button type="button" variant="secondary" size="sm" onClick={onGenerate}>
            点此重新生成配对码
          </Button>
        </li>
      </ol>
    </section>
  );
}

export function PairingGuide({ mobile, running, secondary, pairing, error, hubOrigin, notice, action, highlighted, onGenerate }: {
  mobile: boolean;
  running?: boolean;
  secondary?: boolean;
  pairing: TimedPairingCode | null;
  error: string;
  hubOrigin: string;
  notice?: string;
  action?: HelperHandoffAction;
  highlighted?: boolean;
  onGenerate: () => void;
}) {
  const [platform, setPlatform] = useState<"unix" | "windows">(() => /Windows/iu.test(navigator.userAgent) ? "windows" : "unix");
  const fallbackWaitStartedAt = useMemo(
    () => pairing?.code ? Date.now() : undefined,
    [pairing?.code],
  );
  const helper = useLocalHelper(!mobile, {
    trackWait: true,
    waitStartedAt: pairing?.issuedAtMs ?? fallbackWaitStartedAt,
  });
  const expired = pairing?.remainingSeconds === 0;
  const install = platform === "windows" ? powershellInstallCommand : shellInstallCommand;
  const command = pairing && install(pairing.code, { webOrigin: window.location.origin, hubOrigin });
  const helperRunning = Boolean(running || helper.available);
  const showTroubleshooting = Boolean(
    pairing && !mobile && !helperRunning && helper.waitingSeconds >= PAIRING_TROUBLESHOOT_AFTER_SECONDS,
  );

  function retryDetection() {
    const retry = helper.retryNow;
    if (retry) void retry().catch(() => undefined);
  }

  return <section className={`wb-pairing${highlighted ? " step-one-highlight" : ""}`}>
    <header>
      <div>
        <h3><Terminal size={17} />{helperRunning ? "本地助手已连接" : secondary ? "连接另一台电脑" : "第 1 步：在电脑「终端」运行配对命令"}</h3>
        <p>在电脑的终端粘贴配对命令。每台电脑只需配对一次。</p>
      </div>
      <Segmented label="切换操作系统" options={[{ value: "unix", label: "macOS / Linux" }, { value: "windows", label: "Windows" }]} value={platform} onChange={setPlatform} />
    </header>
    {notice && <p className="wb-notice">{notice}</p>}
    {command && pairing ? <>
      <div className="wb-command wb-pairing__command"><pre><code>{command}</code></pre></div>
      <div className="wb-actions">
        {expired ? <Button variant="secondary" size="sm" disabled>一键复制终端配对命令</Button>
          : <CopyButton text={command} label="一键复制终端配对命令" />}
        {!expired && !mobile && helperRunning && <HelperLink className="ui-button ui-button--secondary ui-button--sm" action={{ pair: pairing.code }}>完成配对</HelperLink>}
        <Button variant={expired ? "primary" : "ghost"} size="sm" onClick={onGenerate}><RefreshCw size={13} />重新生成配对码</Button>
      </div>
      {expired ? <p className="wb-muted" role="status">{PAIRING_EXPIRED}</p> : <>
        <p className="wb-muted" role="timer">{pairingCountdown(pairing.remainingSeconds)}</p>
        {!showTroubleshooting && (
          <p className="wb-muted">{mobile ? "请将配对命令复制到电脑的「终端」执行。" : "正在等待本机助手连接… 终端运行成功后此页面会自动刷新。"}</p>
        )}
      </>}
      {!mobile && (
        <div className="wb-pairing-status" role="status">
          <span>已等待 {helper.waitingSeconds} 秒</span>
          <span>最近探测：{helper.manualRetrying ? "正在重新检测…" : probeStatusLabel(helper.probe)}</span>
          <Button type="button" variant="ghost" size="sm" disabled={helper.manualRetrying} onClick={retryDetection}>
            {helper.manualRetrying ? "正在检测…" : "立即重新检测"}
          </Button>
        </div>
      )}
      {showTroubleshooting && <TroubleshootingCard onGenerate={onGenerate} />}
    </> : error ? <div className="wb-actions">
      <p role="alert" className="wb-error">{error}</p><Button size="sm" variant="secondary" onClick={onGenerate}>重试生成配对命令</Button>
    </div> : <p className="wb-muted">正在生成专属一次性配对命令…</p>}
    {!mobile && <HelperLink className="wb-pairing__link" action={action ?? (pairing && !expired ? { pair: pairing.code } : "console")}>点此直接打开本机控制台 →</HelperLink>}
    <details className="wb-pairing__demo">
      <summary>看一遍配对演示</summary>
      <HelperIntroDemo />
    </details>
  </section>;
}
