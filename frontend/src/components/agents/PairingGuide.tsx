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
  if (!probe) return "正在第一次检查";
  if (probe.state === "running") return "已经找到电脑助手";
  if (probe.state === "blocked") return "浏览器暂时无法访问电脑助手";
  return "还没有找到电脑助手";
}

function TroubleshootingCard({ onGenerate }: { onGenerate: () => void }) {
  return (
    <section className="wb-pairing-trouble" aria-label="本地配对排查">
      <h4>等了 {PAIRING_TROUBLESHOOT_AFTER_SECONDS} 秒，还没有找到电脑助手</h4>
      <p>页面会继续自动检查。请按顺序确认这 4 件事，确认后点「立即重新检查」。</p>
      <ol>
        <li>
          <strong>命令有没有完整运行</strong>
          <span>确认整行命令已经粘贴到电脑「终端」并按回车；如果终端还在等待确认或密码，请先完成那一步。</span>
        </li>
        <li>
          <strong>电脑有没有装好运行环境</strong>
          <span>在终端输入 <code>node --version</code> 后按回车。如果没有显示 v22 或更高版本，请先安装 Node 22+（这是配对命令需要的运行环境）。</span>
        </li>
        <li>
          <strong>命令是不是在这台电脑上运行</strong>
          <span>命令必须在当前浏览器所在电脑的终端里运行，不是在另一台电脑或网页里的终端。</span>
        </li>
        <li>
          <strong>点此重新生成配对码</strong>
          <span>这条命令可能会过期，也可能已经用过。生成新命令后，请重新复制整行命令。</span>
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
        <h3><Terminal size={17} />{helperRunning ? "电脑助手已连接" : secondary ? "连接另一台电脑" : "第 1 步：在电脑「终端」运行配对命令"}</h3>
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
          <p className="wb-muted">{mobile ? "请将配对命令复制到电脑的「终端」执行。" : "正在等待电脑助手连接… 终端命令运行成功后，这个页面会自动更新。"}</p>
        )}
      </>}
      {!mobile && (
        <div className="wb-pairing-status" role="status">
          <span>已等待 {helper.waitingSeconds} 秒</span>
          <span>最近一次检查：{helper.manualRetrying ? "正在重新检查…" : probeStatusLabel(helper.probe)}</span>
          <Button type="button" variant="ghost" size="sm" disabled={helper.manualRetrying} onClick={retryDetection}>
            {helper.manualRetrying ? "正在检查…" : "立即重新检查"}
          </Button>
        </div>
      )}
      {showTroubleshooting && <TroubleshootingCard onGenerate={onGenerate} />}
    </> : error ? <div className="wb-actions">
      <p role="alert" className="wb-error">{error}</p><Button size="sm" variant="secondary" onClick={onGenerate}>重试生成配对命令</Button>
    </div> : <p className="wb-muted">正在生成专属一次性配对命令…</p>}
    {!mobile && <HelperLink className="wb-pairing__link" action={action ?? (pairing && !expired ? { pair: pairing.code } : "console")}>点此打开电脑助手 →<span hidden>点此直接打开本机控制台</span></HelperLink>}
    <details className="wb-pairing__demo">
      <summary>看一遍配对演示</summary>
      <HelperIntroDemo />
    </details>
  </section>;
}
