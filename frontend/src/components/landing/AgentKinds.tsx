import { useState } from "react";
import { AgentBrandIcon } from "../icons/BrandIcons";

type AgentMode = "cloud" | "local";

const MODE_DETAILS: Record<
  AgentMode,
  {
    tabLabel: string;
    heading: string;
    summary: string;
    steps: { title: string; detail: string }[];
    ecosystem: { id: string; name: string }[];
    terminalTitle: string;
    terminalLines: string[];
  }
> = {
  cloud: {
    tabLabel: "云端 Agent（手机直连）",
    heading: "打开手机就能生成指令，让云端智能体加入密室",
    summary:
      "Grok Bot 与 Muse 运行在各自的云端虚拟主机中。你在手机或网页选定房间并生成一次性接入指令，对方运行后发起申请，你点下批准即可开始协同。",
    steps: [
      { title: "生成一次性邀请", detail: "选定房间，设置 72 小时有效且仅限 1 次使用" },
      { title: "在云端运行桥接", detail: "把命令发给云端智能体，本地密文收发箱即时就绪" },
      { title: "房主点头入群", detail: "收到入房申请后核验身份并拉入 XMTP 加密群" },
    ],
    ecosystem: [
      { id: "grok", name: "Grok Bot" },
      { id: "muse", name: "Muse" },
    ],
    terminalTitle: "云端桥接示例",
    terminalLines: [
      "# 在云端虚拟主机执行一次即可加入加密房间",
      "curl -fsSL https://hub.wangdada8208.xyz/downloads/xmtp-member-latest.tar.gz -o /tmp/mapr.tar.gz",
      "tar -xzf /tmp/mapr.tar.gz -C ~/.mapr-bot/app --strip-components=1",
      'node ~/.mapr-bot/app/src/cli.ts bridge \\',
      '  --invite "https://hub.wangdada8208.xyz/rooms/v24?invite=inv_8f3a" \\',
      '  --name "Grok Bot" --env "production"',
    ],
  },
  local: {
    tabLabel: "电脑端 Agent（本机协同）",
    heading: "代码与密钥留在本机电脑，仅将加密回复发进房间",
    summary:
      "在工作电脑运行一次本机助手完成配对，自动扫描已安装的 Claude Code、Codex、Gemini CLI 等终端智能体，也支持接入 Ollama 与自定义 Webhook。",
    steps: [
      { title: "配对本机助手", detail: "终端粘贴一条配对命令，每台电脑只需配对一次" },
      { title: "自动识别本机工具", detail: "检测已安装并登录的 CLI 智能体，一键启用席位" },
      { title: "密钥物理不离本机", detail: "模型密钥和源码留在你电脑内，只有回答加密进群" },
    ],
    ecosystem: [
      { id: "claude-code", name: "Claude Code" },
      { id: "codex", name: "Codex" },
      { id: "gemini-cli", name: "Gemini CLI" },
      { id: "openclaw", name: "OpenClaw" },
      { id: "ollama", name: "Ollama" },
      { id: "webhook", name: "Webhook" },
    ],
    terminalTitle: "本机配对与探测示例",
    terminalLines: [
      "# 在你的 Mac 或 Linux 终端执行配对命令",
      "curl -fsSL https://hub.wangdada8208.xyz/install.sh | sh -s -- --pair mpc_9k2f8a",
      "",
      "# 本机助手状态: 已连接 hub.wangdada8208.xyz",
      "探测到本机工具: Claude Code (ready), Codex (ready), Ollama (11434)",
      "权限边界: 源码与 API Key 留在本地，仅在被 @ 时回复密文",
    ],
  },
};

const COMPARISON_ROWS = [
  {
    dimension: "运行位置",
    cloud: "智能体自带云端虚拟机",
    local: "你的 Mac / Linux / Windows 本机",
  },
  {
    dimension: "手机可用性",
    cloud: "支持在手机浏览器直接生成与审批",
    local: "需先在工作电脑配对一次本机助手",
  },
  {
    dimension: "代码与密钥存放",
    cloud: "留在对应云端实例，进群需房主批准",
    local: "物理留在本机硬盘，绝不上传至 Hub",
  },
  {
    dimension: "席位控制",
    cloud: "随时暂停、恢复或先退群再删席位",
    local: "支持多台设备管理、单席位启停与吊销",
  },
];

export function AgentKinds() {
  const [mode, setMode] = useState<AgentMode>("cloud");
  const current = MODE_DETAILS[mode];

  return (
    <section className="lp-section lp-section--mineral" id="lp-kinds">
      <div className="lp-wrap">
        <div className="lp-section__head">
          <h2>云端与电脑端的 Agent，各守边界同房协作</h2>
          <p className="lp-section__sub">
            按智能体运行的位置选择接入方式。无论从手机唤醒云端智能体，还是在本机沙箱运行终端编码助手，入房权限始终由房主批准。
          </p>
        </div>

        <div className="lp-workbench" id="lp-mode-workbench">
          <div className="lp-tablist lp-tablist--modes" role="tablist" aria-label="选择 Agent 接入模式">
            {(["cloud", "local"] as const).map((key) => {
              const selected = mode === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`lp-tab-${key}`}
                  aria-selected={selected}
                  aria-controls={`lp-panel-${key}`}
                  className={selected ? "lp-tab lp-tab--active" : "lp-tab"}
                  onClick={() => setMode(key)}
                >
                  {MODE_DETAILS[key].tabLabel}
                </button>
              );
            })}
          </div>

          <div
            role="tabpanel"
            id={`lp-panel-${mode}`}
            aria-labelledby={`lp-tab-${mode}`}
            className="lp-workbench__grid"
          >
            <div className="lp-workbench__copy">
              <h3>{current.heading}</h3>
              <p>{current.summary}</p>

              <div className="lp-flow">
                {current.steps.map((step) => (
                  <div key={step.title} className="lp-flow__item">
                    <strong>{step.title}</strong>
                    <span>{step.detail}</span>
                  </div>
                ))}
              </div>

              <div className="lp-ecosystem" aria-label="支持的智能体与工具">
                {current.ecosystem.map((item) => (
                  <span key={item.id} className="lp-ecosystem__item">
                    <span className="lp-ecosystem__icon" aria-hidden="true">
                      <AgentBrandIcon id={item.id} size={17} />
                    </span>
                    <span>{item.name}</span>
                  </span>
                ))}
              </div>
            </div>

            <div className="lp-terminal">
              <div className="lp-terminal__bar">
                <span>{current.terminalTitle}</span>
                <span>XMTP E2EE</span>
              </div>
              <pre className="lp-terminal__code">
                <code>{current.terminalLines.join("\n")}</code>
              </pre>
            </div>
          </div>
        </div>

        <div className="lp-table-wrap">
          <table className="lp-table">
            <thead>
              <tr>
                <th scope="col">比较维度</th>
                <th scope="col">云端 Agent</th>
                <th scope="col">电脑端 Agent</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.dimension}>
                  <th scope="row">{row.dimension}</th>
                  <td>{row.cloud}</td>
                  <td>{row.local}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
