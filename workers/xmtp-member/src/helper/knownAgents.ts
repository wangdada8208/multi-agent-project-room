import { spawn } from "node:child_process";
import { constants, readdirSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HelperConfig, KnownCliAgent, LocalAgent, LoginState } from "./types.ts";

/**
 * 在 POSIX（linux / darwin）环境下保留原有 env.PATH 顺序，并去重追加用户级与常见包管理器 CLI 目录，
 * 解决 systemd / launchd 后台服务默认 PATH 过窄导致扫不到 claude / codex / gemini 的问题。
 */
export function buildExpandedPath(
  env: NodeJS.ProcessEnv,
  homeDir?: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "win32") {
    return env.PATH ?? env.Path ?? "";
  }

  const home = (homeDir ?? env.HOME ?? os.homedir()).trim();
  const seen = new Set<string>();
  const entries: string[] = [];
  const push = (dir: string | undefined) => {
    const cleaned = (dir || "").trim();
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    entries.push(cleaned);
  };

  for (const existing of (env.PATH || "").split(":")) {
    push(existing);
  }

  if (home) {
    push(path.posix.join(home, ".local/bin"));
    push(path.posix.join(home, ".npm-global/bin"));
    push(path.posix.join(home, ".volta/bin"));
    push(path.posix.join(home, ".bun/bin"));
    push(path.posix.join(home, ".cargo/bin"));

    const nvmNodesDir = path.posix.join(home, ".nvm/versions/node");
    try {
      const versions = readdirSync(nvmNodesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
      for (const ver of versions) {
        push(path.posix.join(nvmNodesDir, ver, "bin"));
      }
    } catch {
      // 未安装 nvm 时忽略。
    }
  }

  push("/opt/homebrew/bin");
  push("/usr/local/bin");

  return entries.join(":");
}

/**
 * 能自动探测的本机命令行 Agent。新增一种 = 在这里加一行，并在 engines/ 里加一个引擎。
 * 云端 Agent（Grok、Muse 等）无法探测，由主人在本机页面或网站上手动添加，见 ManualAgent。
 */
export const KNOWN_CLI_AGENTS: readonly KnownCliAgent[] = [
  {
    kind: "claude-code",
    displayName: "Claude Code",
    binaries: ["claude"],
    versionArgs: ["--version"],
    // .claude 目录和 .claude.json 都是首次启动就自动创建的，不算登录。
    // 唯一可靠标记是 OAuth 凭证文件；空壳/截断文件（实测 15B 残桩）按未登录处理。
    // 纯 API key 用户会被标 needs-login——这只是提示不是门禁，见 AgentsPage 的 loginHint。
    loginMarkers: [{ path: ".claude/.credentials.json", minBytes: 32 }],
  },
  {
    kind: "codex",
    displayName: "Codex",
    binaries: ["codex"],
    versionArgs: ["--version"],
    loginMarkers: [".codex/auth.json"],
  },
  {
    kind: "gemini-cli",
    displayName: "Gemini CLI",
    binaries: ["gemini"],
    versionArgs: ["--version"],
    loginMarkers: [".gemini"],
  },
];

export interface DetectDeps {
  /** 在 PATH 中查找命令，返回绝对路径或 null。不得调用 shell（不用 `which`）。 */
  findOnPath: (binary: string) => Promise<string | null>;
  /** 运行 `<binary> --version`，3 秒超时，返回首行或 null。 */
  readVersion: (binaryPath: string, args: string[]) => Promise<string | null>;
  /** 判断存在与否，不读内容；minBytes 时文件还需达到最小字节数。 */
  exists: (pathFromHome: string, minBytes?: number) => Promise<boolean>;
  /** Linux 沙箱（bubblewrap）是否可用；向后兼容可选提供。 */
  hasBwrap?: () => Promise<boolean>;
  /** macOS 原生 Seatbelt 沙箱（/usr/bin/sandbox-exec）是否可用。 */
  hasDarwinSandbox?: () => Promise<boolean>;
  /** 运行平台覆盖（便于跨平台单测），缺省取 process.platform。 */
  platform?: NodeJS.Platform;
}

/**
 * 探测这台电脑上的全部 Agent：KNOWN_CLI_AGENTS 逐个探测 + config.manualAgents 原样列出。
 * 结果按 KNOWN_CLI_AGENTS 顺序，手动添加的排在后面。没装的命令行 Agent 不出现在结果里。
 *
 * codex 特例：Linux 要求 bwrap、macOS 要求 /usr/bin/sandbox-exec 做文件系统写隔离（S1/S3）。
 * 缺少对应平台沙箱时标 "unknown"，让本机页面如实提示缺少沙箱而不是谎称已就绪。
 */
export async function detectLocalAgents(
  deps: DetectDeps,
  config: Pick<HelperConfig, "manualAgents"> | null
): Promise<LocalAgent[]> {
  const out: LocalAgent[] = [];
  const platform = deps.platform ?? process.platform;
  for (const spec of KNOWN_CLI_AGENTS) {
    let binaryPath: string | null = null;
    for (const name of spec.binaries) {
      binaryPath = await deps.findOnPath(name);
      if (binaryPath) break;
    }
    if (!binaryPath) continue;
    const version = (await deps.readVersion(binaryPath, spec.versionArgs)) ?? undefined;

    let loginState: LoginState = "needs-login";
    for (const marker of spec.loginMarkers) {
      const markerPath = typeof marker === "string" ? marker : marker.path;
      const markerMin = typeof marker === "string" ? undefined : marker.minBytes;
      if (await deps.exists(markerPath, markerMin)) {
        loginState = "likely-ready";
        break;
      }
    }
    if (spec.kind === "codex") {
      let sandboxReady = false;
      if (platform === "darwin" && deps.hasDarwinSandbox) {
        sandboxReady = await deps.hasDarwinSandbox();
      } else if (deps.hasBwrap) {
        sandboxReady = await deps.hasBwrap();
      } else if (platform === "linux") {
        sandboxReady = Boolean(await deps.findOnPath("bwrap"));
      }
      if (!sandboxReady) loginState = "unknown";
    }
    out.push({
      key: spec.kind,
      kind: spec.kind,
      displayName: spec.displayName,
      source: "detected",
      binaryPath,
      version,
      loginState,
    });
  }
  for (const manual of config?.manualAgents ?? []) {
    out.push({
      key: manual.key,
      kind: manual.kind,
      displayName: manual.displayName,
      source: "manual",
      loginState: "unknown",
      ...(manual.baseUrl ? { baseUrl: manual.baseUrl } : {}),
    });
  }
  return out;
}

/**
 * 生产用探测实现。
 * - findOnPath：逐个扩展 PATH 目录 stat，不经过 shell，返回第一个可执行文件的绝对路径。
 * - readVersion：spawn 直接执行（无 shell，注入扩展 PATH 保证 #!/usr/bin/env node 可用），3 秒超时杀进程。
 * - exists：相对家目录拼接，只 stat 不读内容。
 */
export function defaultDetectDeps(): DetectDeps {
  const home = os.homedir();
  const pathexts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((s) => s.trim()).filter(Boolean)
      : [];
  const candidateNames = (binary: string): string[] => {
    if (process.platform !== "win32") return [binary];
    const names = [binary];
    for (const ext of pathexts) {
      names.push(binary + ext.toLowerCase(), binary + ext);
    }
    return names;
  };

  const findOnPath = async (binary: string): Promise<string | null> => {
    const searchPath = buildExpandedPath(process.env, home);
    for (const dir of searchPath.split(path.delimiter)) {
      if (!dir) continue;
      for (const name of candidateNames(binary)) {
        const candidate = path.join(dir, name);
        try {
          const st = await stat(candidate);
          if (!st.isFile()) continue;
          await access(candidate, constants.X_OK);
          return candidate;
        } catch {
          // 不存在或不可执行：下一个候选。
        }
      }
    }
    return null;
  };

  return {
    platform: process.platform,
    findOnPath,
    readVersion(binaryPath, args) {
      const searchPath = buildExpandedPath(process.env, home);
      return new Promise((resolve) => {
        let out = "";
        let done = false;
        const finish = (value: string | null) => {
          if (!done) {
            done = true;
            resolve(value);
          }
        };
        let child;
        try {
          child = spawn(binaryPath, args, {
            env: { ...process.env, PATH: searchPath },
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 3000,
          });
        } catch {
          finish(null);
          return;
        }
        child.stdout?.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
        });
        child.on("error", () => finish(null));
        child.on("close", () => {
          const first = out
            .split(/\r?\n/)
            .map((s) => s.trim())
            .find((s) => s.length > 0);
          finish(first ?? null);
        });
      });
    },
    async exists(pathFromHome, minBytes) {
      try {
        const st = await stat(path.join(home, pathFromHome));
        if (minBytes !== undefined && st.isFile()) return st.size >= minBytes;
        return true;
      } catch {
        return false;
      }
    },
    async hasBwrap() {
      if (process.platform !== "linux") return false;
      return Boolean(await findOnPath("bwrap"));
    },
    async hasDarwinSandbox() {
      if (process.platform !== "darwin") return false;
      try {
        await access("/usr/bin/sandbox-exec", constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}
