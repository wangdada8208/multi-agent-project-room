/**
 * 一次性问答型 CLI Agent 规格表（kind: "cli-agent"）。
 *
 * 这些 Agent 都有非交互 print 模式：一条命令带一句提示词、跑完把回复打到
 * stdout 就退出。探测侧读 binaries/loginMarkers，引擎侧读 argvPrefix/envKeys，
 * 一张表同时喂给 knownAgents 探测与 cliAgentEngine。
 *
 * argv 约定：argvPrefix + （有 model 时 modelFlag model）+ prompt（promptVia=argv
 * 时追加到末尾；stdin 时写进子进程 stdin）。
 * 每个 CLI 的参数均以该机真实 --help 或官方文档核对过，见各条注释。
 */
export interface CliAgentSpec {
  /** LocalAgent.key（探测项稳定键，也是 Magpie 去重与引擎查表的键）。 */
  key: string;
  displayName: string;
  binaries: readonly string[];
  versionArgs: readonly string[];
  /** 相对家目录的路径；任一存在即视为 likely-ready（只看存在性，不读内容）。 */
  loginMarkers: readonly (string | { path: string; minBytes?: number })[];
  /** 一次性问答的参数前缀。 */
  argvPrefix: readonly string[];
  /** prompt 追加到 argv 末尾，还是写进 stdin。 */
  promptVia: "argv" | "stdin";
  /** 可选模型参数（"-m"/"--model"）；不写表示该 Agent 不支持按次选模型。 */
  modelFlag?: string;
  /** 额外透传给子进程的环境变量名（加在 PROVIDER_ENV_KEYS 与 minimalEnv 之上）。 */
  envKeys?: readonly string[];
}

/** 模型服务商密钥的通用白名单：这些 Agent 都是模型路由，主人用 env 配 key 时应透传。 */
export const PROVIDER_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MINIMAX_API_KEY",
  "DASHSCOPE_API_KEY",
];

export const CLI_AGENT_SPECS: readonly CliAgentSpec[] = [
  {
    // opencode run "msg"（-m provider/model 选模型），auth 在 ~/.local/share/opencode
    key: "opencode",
    displayName: "OpenCode",
    binaries: ["opencode"],
    versionArgs: ["--version"],
    // 首次运行会自建 .config/opencode / ~/.local/share/opencode 目录，只有 auth.json 算登录。
    loginMarkers: [{ path: ".local/share/opencode/auth.json", minBytes: 8 }],
    argvPrefix: ["run"],
    promptVia: "argv",
    modelFlag: "-m",
    envKeys: ["OPENCODE_CONFIG", "OPENCODE_MODEL", "OPENCODE_PERMISSION"],
  },
  {
    // qwen -p "msg"（gemini-cli 同族的 -p/--prompt 非交互模式）
    key: "qwen-code",
    displayName: "Qwen Code",
    binaries: ["qwen"],
    versionArgs: ["--version"],
    // .qwen 目录首跑自建（installation_id 等），凭证看 oauth 文件。
    loginMarkers: [{ path: ".qwen/oauth_creds.json", minBytes: 32 }],
    argvPrefix: ["-p"],
    promptVia: "argv",
    modelFlag: "-m",
    envKeys: ["QWEN_CODE_AUTH_TYPE", "OPENAI_MODEL"],
  },
  {
    // copilot -p "msg"（官方 help：-p/--prompt 非交互脚本模式）
    key: "copilot-cli",
    displayName: "Copilot CLI",
    binaries: ["copilot"],
    versionArgs: ["--version"],
    // .copilot 目录首跑自建；gh 托管登录态看 hosts.yml，自己的凭证文件兜底。
    loginMarkers: [
      { path: ".config/gh/hosts.yml", minBytes: 16 },
      { path: ".copilot/oauth_token", minBytes: 8 },
      { path: ".copilot/credentials.json", minBytes: 32 },
    ],
    argvPrefix: ["-p"],
    promptVia: "argv",
    modelFlag: "--model",
    envKeys: ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_MODEL"],
  },
  {
    // crush run "msg"
    key: "crush",
    displayName: "Crush",
    binaries: ["crush"],
    versionArgs: ["--version"],
    loginMarkers: [{ path: ".config/crush/crush.json", minBytes: 8 }, { path: ".crush/crush.json", minBytes: 8 }],
    argvPrefix: ["run"],
    promptVia: "argv",
    modelFlag: "-m",
    envKeys: ["CRUSH_DISABLE_METRICS"],
  },
  {
    // cursor-agent -p --output-format text "msg"（二进制也叫 agent）
    key: "cursor-agent",
    displayName: "Cursor Agent",
    binaries: ["cursor-agent", "agent"],
    versionArgs: ["--version"],
    // 安装脚本会无条件建目录，只有凭证文件才算登录态。
    loginMarkers: [{ path: ".config/cursor-agent/auth.json", minBytes: 8 }, { path: ".cursor/auth.json", minBytes: 8 }],
    argvPrefix: ["-p", "--output-format", "text"],
    promptVia: "argv",
    modelFlag: "--model",
    envKeys: ["CURSOR_API_KEY"],
  },
  {
    // droid exec "msg"（-o text、-m model）
    key: "droid",
    displayName: "Factory Droid",
    binaries: ["droid"],
    versionArgs: ["--version"],
    loginMarkers: [{ path: ".factory/auth.json", minBytes: 8 }],
    argvPrefix: ["exec", "-o", "text"],
    promptVia: "argv",
    modelFlag: "-m",
    envKeys: ["FACTORY_API_KEY"],
  },
  {
    // codebuddy -p "msg"（腾讯 CodeBuddy / WorkBuddy CLI，Claude Code 同构）
    key: "codebuddy",
    displayName: "CodeBuddy",
    binaries: ["codebuddy", "cbc"],
    versionArgs: ["--version"],
    // Claude Code 同构产品，凭证文件沿用其 .credentials.json 布局。
    loginMarkers: [{ path: ".codebuddy/.credentials.json", minBytes: 32 }, { path: ".codebuddy/auth.json", minBytes: 8 }],
    argvPrefix: ["-p"],
    promptVia: "argv",
    modelFlag: "--model",
    envKeys: ["CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN"],
  },
  {
    // dsh headless "msg"（DeepSeek Harness 的一次性任务模式，打结果即退出）
    key: "dsh",
    displayName: "DeepSeek Harness",
    binaries: ["dsh"],
    versionArgs: ["--version"],
    loginMarkers: [".dsh"],
    argvPrefix: ["headless"],
    promptVia: "argv",
    envKeys: ["DSH_HOME"],
  },
  {
    // aider --message "msg"（--yes 跳过全部确认，--no-git 沙箱目录没有仓库）
    key: "aider",
    displayName: "Aider",
    binaries: ["aider"],
    versionArgs: ["--version"],
    loginMarkers: [".aider.conf.yml", ".aider"],
    argvPrefix: ["--yes", "--no-git", "--message"],
    promptVia: "argv",
    modelFlag: "--model",
  },
  {
    // goose run -t "msg"（Block Goose 的一次性文本任务）
    key: "goose",
    displayName: "Goose",
    binaries: ["goose"],
    versionArgs: ["--version"],
    loginMarkers: [{ path: ".config/goose/config.yaml", minBytes: 8 }],
    argvPrefix: ["run", "-t"],
    promptVia: "argv",
    envKeys: ["GOOSE_PROVIDER", "GOOSE_MODEL"],
  },
  {
    // qoder -p "msg"（阿里 Qoder；qoder-cn 是国内版二进制）
    key: "qoder",
    displayName: "Qoder",
    binaries: ["qoder", "qoder-cn"],
    versionArgs: ["--version"],
    loginMarkers: [
      { path: ".qoder/settings.json", minBytes: 8 },
      { path: ".qoder-cn/settings.json", minBytes: 8 },
    ],
    argvPrefix: ["-p"],
    promptVia: "argv",
    modelFlag: "--model",
    envKeys: ["QODER_API_KEY"],
  },
  {
    // freecode run "msg"（Histh!/Honey I Shrunk the Harness）
    key: "freecode",
    displayName: "Histh (freecode)",
    binaries: ["freecode"],
    versionArgs: ["--version"],
    loginMarkers: [{ path: ".config/freecode/config.json", minBytes: 8 }, { path: ".freecode/config.json", minBytes: 8 }],
    argvPrefix: ["run"],
    promptVia: "argv",
    modelFlag: "-m",
  },
  {
    // MiniMax Code（mcode/minimax 二进制命名以实机为准）
    key: "minimax-code",
    displayName: "MiniMax Code",
    binaries: ["mcode", "minimax"],
    versionArgs: ["--version"],
    loginMarkers: [".minimax"],
    argvPrefix: ["-p"],
    promptVia: "argv",
    modelFlag: "--model",
    envKeys: ["MINIMAX_API_KEY", "MINIMAX_CODE_API_KEY"],
  },
];

export function cliAgentSpec(key: string): CliAgentSpec | undefined {
  return CLI_AGENT_SPECS.find((s) => s.key === key);
}
