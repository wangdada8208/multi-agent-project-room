import { RefreshCw, Terminal } from "lucide-react";
import { useState } from "react";
import { powershellInstallCommand, type HelperHandoffAction } from "../../lib/localHelper";
import { CopyButton } from "../CopyButton";
import { HelperIntroDemo } from "../HelperIntroDemo";
import { HelperLink } from "../HelperLink";
import { Button } from "../ui/Button";
import { Segmented } from "../ui/Segmented";

export function PairingGuide({ mobile, running, secondary, pairing, error, hubOrigin, notice, action, highlighted, onGenerate }: {
  mobile: boolean;
  running?: boolean;
  secondary?: boolean;
  pairing: { code: string; install_command: string } | null;
  error: string;
  hubOrigin: string;
  notice?: string;
  action?: HelperHandoffAction;
  highlighted?: boolean;
  onGenerate: () => void;
}) {
  const [platform, setPlatform] = useState<"unix" | "windows">(() => /Windows/iu.test(navigator.userAgent) ? "windows" : "unix");
  const command = pairing && (platform === "windows" ? powershellInstallCommand(pairing.code, hubOrigin) : pairing.install_command);
  return <section className={`wb-pairing${highlighted ? " step-one-highlight" : ""}`}>
    <header>
      <div>
        <h3><Terminal size={17} />{running ? "本地助手已连接" : secondary ? "连接另一台电脑" : "第 1 步：在电脑「终端」运行配对命令"}</h3>
        <p>在电脑的终端粘贴配对命令。每台电脑只需配对一次。</p>
      </div>
      <Segmented label="切换操作系统" options={[{ value: "unix", label: "macOS / Linux" }, { value: "windows", label: "Windows" }]} value={platform} onChange={setPlatform} />
    </header>
    {notice && <p className="wb-notice">{notice}</p>}
    {command && pairing ? <>
      <div className="wb-command wb-pairing__command"><pre><code>{command}</code></pre></div>
      <div className="wb-actions">
        <CopyButton text={command} label="一键复制终端配对命令" />
        {!mobile && running && <HelperLink className="ui-button ui-button--secondary ui-button--sm" action={{ pair: pairing.code }}>完成配对</HelperLink>}
        <Button variant="ghost" size="sm" onClick={onGenerate}><RefreshCw size={13} />重新生成命令</Button>
      </div>
      <p className="wb-muted">{mobile ? "请将配对命令复制到电脑的「终端」执行。" : "正在等待本机助手连接… 终端运行成功后此页面会自动刷新。"}</p>
    </> : error ? <div className="wb-actions">
      <p role="alert" className="wb-error">{error}</p><Button size="sm" variant="secondary" onClick={onGenerate}>重试生成配对命令</Button>
    </div> : <p className="wb-muted">正在生成专属一次性配对命令…</p>}
    {!mobile && <HelperLink className="wb-pairing__link" action={action ?? (pairing ? { pair: pairing.code } : "console")}>点此直接打开本机控制台 →</HelperLink>}
    <details className="wb-pairing__demo">
      <summary>看一遍配对演示</summary>
      <HelperIntroDemo />
    </details>
  </section>;
}
