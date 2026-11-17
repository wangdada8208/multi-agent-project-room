import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { EngineConfig, ReplyEngine, ReplyRequest } from "./types.ts";
import { MAX_REPLY_BYTES } from "./types.ts";

type CliConfig<K extends "claude-code" | "codex" | "gemini-cli"> = Extract<EngineConfig, { kind: K }>;

export interface CliRun {
  argv: string[];
  stdin: string;
  cwd: string;
  signal: AbortSignal;
  /** 只传白名单设置项；不得把成员进程的 XMTP_WALLET_KEY、HUB_TOKEN 等传给子进程。 */
  env: NodeJS.ProcessEnv;
  maxOutputBytes: number;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

const SIGKILL_AFTER_MS = 5_000;
const STDERR_TAIL = 300;

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function stderrTail(stderr: string): string {
  const tail = stderr.trim().slice(-STDERR_TAIL);
  return tail ? `: ${tail}` : "";
}

/**
 * 运行一次本机 Agent 命令。
 * - 用 spawn(argv[0], argv.slice(1))，不经过 shell。
 * - signal 触发时先 SIGTERM，5 秒后 SIGKILL，并以 AbortError 拒绝。
 * - stdout 超过 maxOutputBytes 时截断并标记 truncated。
 */
export async function runCli(run: CliRun): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(run.argv[0], run.argv.slice(1), {
      cwd: run.cwd,
      env: run.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_AFTER_MS);
      killTimer.unref();
    };
    const onAbort = () => kill();
    if (run.signal.aborted) {
      kill();
    } else {
      run.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const room = run.maxOutputBytes - outBytes;
      if (room > 0) outChunks.push(chunk.subarray(0, room));
      outBytes += chunk.length;
      if (outBytes > run.maxOutputBytes) truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const room = run.maxOutputBytes - errBytes;
      if (room > 0) errChunks.push(chunk.subarray(0, room));
      errBytes += chunk.length;
    });
    child.stdin.on("error", () => {
      // 子进程提前退出会触发 EPIPE，结果以 close 事件为准。
    });
    child.stdin.end(run.stdin);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      run.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      run.signal.removeEventListener("abort", onAbort);
      if (run.signal.aborted) {
        reject(abortError());
        return;
      }
      resolve({
        code,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        truncated,
      });
    });
  });
}

/**
 * 子进程设置项白名单：PATH、HOME、LANG、TERM，以及该 Agent 自己登录所需的项
 * （claude-code: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL；
 * codex: OPENAI_API_KEY、CODEX_HOME；gemini-cli: GEMINI_API_KEY）。
 */
const CHILD_ENV_KEYS: Record<"claude-code" | "codex" | "gemini-cli", readonly string[]> = {
  "claude-code": ["PATH", "HOME", "LANG", "TERM", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"],
  codex: ["PATH", "HOME", "LANG", "TERM", "OPENAI_API_KEY", "CODEX_HOME"],
  "gemini-cli": ["PATH", "HOME", "LANG", "TERM", "GEMINI_API_KEY"],
};

export function childEnv(kind: "claude-code" | "codex" | "gemini-cli", parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS[kind]) {
    const value = parent[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Claude Code 纯对话模式，提示词走 stdin：
 *   claude -p --output-format json --tools "" --strict-mcp-config
 *          --setting-sources project --no-session-persistence [--model M]
 * 工作目录是空白沙箱，因此 project 级设置为空，主人的自动触发设置不会执行。
 * 输出是单个 JSON，取 `result` 字段；`is_error` 为 true 时抛错。
 */
export function claudeArgv(config: CliConfig<"claude-code">): string[] {
  const argv = [
    config.binaryPath,
    "-p",
    "--output-format", "json",
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "project",
    "--no-session-persistence",
  ];
  if (config.model) argv.push("--model", config.model);
  return argv;
}

/**
 * Codex 非交互模式，提示词走 stdin（末尾的 "-"）：
 *   codex exec --sandbox read-only --skip-git-repo-check --ephemeral
 *              -C <sandboxDir> -o <outFile> [-m M] -
 * 回复从 outFile 读取（最后一条消息），不解析 stdout。
 * 注意：read-only 沙箱仍可读取整台机器的文件，见方案文档「安全核查 S3」。
 */
export function codexArgv(config: CliConfig<"codex">, outFile: string): string[] {
  const argv = [
    config.binaryPath,
    "exec",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "-C", config.sandboxDir,
    "-o", outFile,
  ];
  if (config.model) argv.push("-m", config.model);
  argv.push("-");
  return argv;
}

/** Gemini CLI：gemini -p <prompt>。这台 Linux 机器没有装 gemini，实现者必须先用真实命令核对参数。 */
export function geminiArgv(config: CliConfig<"gemini-cli">, prompt: string): string[] {
  const argv = [config.binaryPath, "-p", prompt];
  if (config.model) argv.push("-m", config.model);
  return argv;
}

export function claudeCodeEngine(config: CliConfig<"claude-code">): ReplyEngine {
  return {
    kind: "claude-code",
    async reply(req: ReplyRequest): Promise<string> {
      const result = await runCli({
        argv: claudeArgv(config),
        stdin: req.prompt,
        cwd: config.sandboxDir,
        signal: req.signal,
        env: childEnv("claude-code", process.env),
        maxOutputBytes: MAX_REPLY_BYTES,
      });
      let data: any = null;
      try {
        data = JSON.parse(result.stdout);
      } catch {
        // claude 的非零退出也可能不带 JSON，报错走 stderr。
      }
      const resultText = typeof data?.result === "string" ? data.result : null;
      if (result.code !== 0 || data?.is_error) {
        const detail = resultText ? `: ${resultText.slice(0, STDERR_TAIL)}` : stderrTail(result.stderr);
        throw new Error(`claude failed${result.code !== 0 ? ` (code ${result.code})` : ""}${detail}`);
      }
      if (resultText === null) {
        throw new Error("claude output missing result field");
      }
      return resultText;
    },
  };
}

export interface BwrapSpec {
  bwrapPath: string;
  binaryPath: string;
  sandboxDir: string;
  codexHome: string | null;
  homeDir: string | null;
  /** 环境相关的额外只读目录（如本机模型网关的配置目录）。 */
  extraRoDirs?: string[];
  /** 环境相关的额外可写目录（如本机模型网关的状态目录）。 */
  extraRwDirs?: string[];
}

const BWRAP_SYSTEM_DIRS = ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc"];

function isSystemDir(dir: string): boolean {
  return BWRAP_SYSTEM_DIRS.some((s) => dir === s || dir.startsWith(s + path.sep));
}

/** dir 是家目录本身、或是家目录的上级（挂了它等于挂了整个家）。 */
function coversHome(dir: string, homeDir: string | null): boolean {
  if (!homeDir) return false;
  return dir === homeDir || homeDir.startsWith(dir + path.sep);
}

const EXEC_TARGET_RE = /exec\s+['"]?(\/[^\s'"`]+)/g;

/** 包装脚本里 exec 到的绝对路径目标；只读文件头，非脚本返回空。 */
function scriptExecTargets(file: string): string[] {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(16_384);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, n).toString("utf8");
      if (!head.startsWith("#!")) return [];
      return [...head.matchAll(EXEC_TARGET_RE)].map((m) => m[1]);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

/**
 * 工具链要挂载的目录：入口文件所在目录和它的上一级；若是包装脚本，再跟上
 * exec 目标的两级目录（最多追 3 层，覆盖 script → script → binary 的链）。
 * 已挂在系统目录下的不重复挂；家目录本身及其上级永远不挂。
 * 家目录下面的具体子目录可以挂：不隔离时子进程本来就能读整个家目录，
 * 只读挂它自己的安装目录是更小的暴露。
 */
export function toolchainDirs(resolvedBinary: string, homeDir: string | null): string[] {
  const dirs = new Set<string>();
  const seen = new Set<string>();
  let frontier = [resolvedBinary];
  for (let level = 0; level < 3 && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const file of frontier) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const dir of [path.dirname(file), path.dirname(path.dirname(file))]) {
        if (dir !== "/" && !isSystemDir(dir) && !coversHome(dir, homeDir)) {
          dirs.add(dir);
        }
      }
      for (const target of scriptExecTargets(file)) {
        try {
          next.push(realpathSync(target));
        } catch { /* 目标不存在则跳过 */ }
      }
    }
    frontier = next;
  }
  return [...dirs];
}

const ARG0_SCAN_DIRS = 8;
const ARG0_SCAN_FILES = 32;

/**
 * codex 会把 apply_patch、codex-linux-sandbox 等辅助二进制以软链形式释放到
 * $CODEX_HOME/tmp/arg0/codex-arg0XXXX/ 与 $CODEX_HOME/agents/<id>/tmp/arg0/…/。
 * 软链目标指向安装包 vendor 目录；白名单模式下目标目录可能在家目录遮挡之下，
 * 需要把解析后的目标目录补挂回去。扫描有上限，悬空软链跳过。
 */
export function arg0HelperDirs(codexHome: string): string[] {
  const dirs = new Set<string>();
  const roots = [path.join(codexHome, "tmp", "arg0")];
  const agentsDir = path.join(codexHome, "agents");
  try {
    for (const agent of readdirSync(agentsDir).slice(0, ARG0_SCAN_DIRS)) {
      roots.push(path.join(agentsDir, agent, "tmp", "arg0"));
    }
  } catch { /* 没有 agents 目录 */ }
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root).slice(0, ARG0_SCAN_DIRS);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(root, entry);
      let files: string[];
      try {
        files = readdirSync(dir).slice(0, ARG0_SCAN_FILES);
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          dirs.add(path.dirname(realpathSync(path.join(dir, file))));
        } catch { /* 悬空软链跳过 */ }
      }
    }
  }
  return [...dirs];
}

/** home 不在 /home、/root 之下时（如 /data）需要单独遮住。 */
function homeMaskDir(homeDir: string | null): string | null {
  if (!homeDir || homeDir === "/") return null;
  if (homeDir === "/home" || homeDir === "/root") return null;
  if (homeDir.startsWith("/home/") || homeDir.startsWith("/root/")) return null;
  return homeDir;
}

/**
 * 用 bwrap 包住 codex：S3 实测证实 codex 的 read-only 沙箱仍能读家目录，
 * 所以进程级隔离交给 bubblewrap。
 *
 * 白名单模型（实测确认可让 codex exec 正常出话）：
 * 1. --ro-bind / / 先让整个文件系统只读可见，保证系统库与运行时不缺文件；
 * 2. --tmpfs 遮住 /home、/root 与非标准位置的家目录，藏掉全部用户文件；
 * 3. 遮挡之后逐个放行：工具链目录与 arg0 辅助二进制目标（只读）、
 *    CODEX_HOME、空白沙箱、extraRwDirs（可写）；extraRoDirs 只读。
 * 4. 网络保持共享（要调模型接口）。
 *
 * 挂载顺序敏感：--ro-bind / / 必须在 --proc / --dev / --tmpfs 之前，
 * 家目录 tmpfs 必须在放行挂载之前。
 */
export function bwrapWrap(inner: string[], spec: BwrapSpec): string[] {
  const resolved = realpathSync(spec.binaryPath);
  const argv = [
    spec.bwrapPath,
    "--unshare-all", "--share-net", "--die-with-parent",
    "--ro-bind", "/", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", "/home",
    "--tmpfs", "/root",
  ];
  const homeMask = homeMaskDir(spec.homeDir);
  if (homeMask) argv.push("--tmpfs", homeMask);

  const roDirs = new Set<string>(spec.extraRoDirs ?? []);
  for (const dir of toolchainDirs(resolved, spec.homeDir)) roDirs.add(dir);
  if (spec.codexHome) {
    for (const dir of arg0HelperDirs(spec.codexHome)) roDirs.add(dir);
  }
  const rwDirs = new Set<string>(spec.extraRwDirs ?? []);
  for (const dir of [...roDirs].sort()) {
    argv.push("--ro-bind", dir, dir);
  }
  argv.push("--ro-bind", resolved, resolved);
  for (const dir of [...rwDirs].sort()) {
    argv.push("--bind", dir, dir);
  }
  if (spec.codexHome && existsSync(spec.codexHome)) {
    argv.push("--bind", spec.codexHome, spec.codexHome);
  }
  argv.push("--bind", spec.sandboxDir, spec.sandboxDir);
  argv.push("--chdir", spec.sandboxDir);
  argv.push(...inner);
  return argv;
}

let bwrapPathCache: string | null | undefined;

/** 在 PATH 里找可执行的 bwrap；找不到返回 null（调用方决定降级或标记有风险）。 */
export function findBwrap(): string | null {
  if (bwrapPathCache !== undefined) return bwrapPathCache;
  if (process.platform !== "linux") {
    bwrapPathCache = null;
    return null;
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "bwrap");
    try {
      accessSync(candidate, constants.X_OK);
      bwrapPathCache = candidate;
      return candidate;
    } catch { /* 下一个目录 */ }
  }
  bwrapPathCache = null;
  return null;
}

export function codexEngine(config: CliConfig<"codex">): ReplyEngine {
  const bwrap = findBwrap();
  if (!bwrap) {
    // S3 实测：codex 的 read-only 沙箱读得到家目录，不加系统级隔离就是泄密。
    // 没有 bubblewrap 时拒绝启动这个引擎，绝不裸跑。
    throw new Error(
      "codex engine requires bubblewrap (bwrap) for filesystem isolation; install bubblewrap or choose another agent"
    );
  }
  return {
    kind: "codex",
    async reply(req: ReplyRequest): Promise<string> {
      const outFile = path.join(config.sandboxDir, `codex-last-${randomUUID()}.txt`);
      const inner = codexArgv(config, outFile);
      const argv = bwrapWrap(inner, {
        bwrapPath: bwrap,
        binaryPath: config.binaryPath,
        sandboxDir: config.sandboxDir,
        codexHome: process.env.CODEX_HOME || (process.env.HOME ? path.join(process.env.HOME, ".codex") : null),
        homeDir: process.env.HOME || null,
        extraRoDirs: config.bwrapRoDirs,
        extraRwDirs: config.bwrapRwDirs,
      });
      const result = await runCli({
        argv,
        stdin: req.prompt,
        cwd: config.sandboxDir,
        signal: req.signal,
        env: childEnv("codex", process.env),
        maxOutputBytes: MAX_REPLY_BYTES,
      });
      if (result.code !== 0) {
        await rm(outFile, { force: true });
        throw new Error(`codex exited with code ${result.code}${stderrTail(result.stderr)}`);
      }
      let text: string;
      try {
        text = await readFile(outFile, "utf8");
      } catch {
        throw new Error("codex did not write an output file");
      } finally {
        await rm(outFile, { force: true });
      }
      return text.trimEnd();
    },
  };
}

export function geminiCliEngine(config: CliConfig<"gemini-cli">): ReplyEngine {
  return {
    kind: "gemini-cli",
    async reply(req: ReplyRequest): Promise<string> {
      const result = await runCli({
        argv: geminiArgv(config, req.prompt),
        stdin: "",
        cwd: config.sandboxDir,
        signal: req.signal,
        env: childEnv("gemini-cli", process.env),
        maxOutputBytes: MAX_REPLY_BYTES,
      });
      if (result.code !== 0) {
        throw new Error(`gemini exited with code ${result.code}${stderrTail(result.stderr)}`);
      }
      return result.stdout.trimEnd();
    },
  };
}
