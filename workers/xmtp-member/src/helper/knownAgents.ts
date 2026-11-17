import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HelperConfig, KnownCliAgent, LocalAgent, LoginState } from "./types.ts";

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
}

/**
 * 探测这台电脑上的全部 Agent：KNOWN_CLI_AGENTS 逐个探测 + config.manualAgents 原样列出。
 * 结果按 KNOWN_CLI_AGENTS 顺序，手动添加的排在后面。没装的命令行 Agent 不出现在结果里。
 *
 * codex 特例：引擎要求 bwrap 做文件系统隔离（S3，没有 bwrap 时引擎创建即抛错，绝不裸跑）。
 * LoginState 只有三档、没有「装了但不能跑」这一档，所以缺 bwrap（或不在 Linux 上）时标
 * "unknown"，让本机页面显示「不可用」而不是谎称已就绪。
 */
export async function detectLocalAgents(
  deps: DetectDeps,
  config: Pick<HelperConfig, "manualAgents"> | null
): Promise<LocalAgent[]> {
  const out: LocalAgent[] = [];
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
      const bwrap = process.platform === "linux" ? await deps.findOnPath("bwrap") : null;
      if (!bwrap) loginState = "unknown";
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
    });
  }
  return out;
}

/**
 * 生产用探测实现。
 * - findOnPath：逐个 PATH 目录 stat，不经过 shell，返回第一个可执行文件的绝对路径。
 * - readVersion：spawn 直接执行（无 shell），3 秒超时杀进程，只取 stdout 首行。
 * - exists：相对家目录拼接，只 stat 不读内容。
 */
export function defaultDetectDeps(): DetectDeps {
  const home = os.homedir();
  // Windows 下命令常以 .cmd/.exe 形式存在，PATHEXT 是系统登记的可执行后缀清单。
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

  return {
    async findOnPath(binary) {
      for (const dir of (process.env.PATH || "").split(path.delimiter)) {
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
    },
    readVersion(binaryPath, args) {
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
          // spawn 的 timeout 选项到期自动 SIGTERM；版本探测失败不致命，返回 null。
          child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
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
  };
}
