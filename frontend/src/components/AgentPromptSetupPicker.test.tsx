// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PROMPT_CLIENTS,
  AgentPromptSetupPicker,
  buildAgentPrompt,
  buildFallbackCommand,
} from "./AgentPromptSetupPicker";

const origin = "https://parlor.example/";

let container: HTMLDivElement;
let root: Root;

function mountPicker(props?: Partial<Parameters<typeof AgentPromptSetupPicker>[0]>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <AgentPromptSetupPicker
        hubOrigin={origin}
        roomId="room-42"
        roomName="发布冲刺"
        pairingCode="mpc_test_code"
        {...props}
      />,
    );
  });
}

function unmountPicker() {
  act(() => root.unmount());
  container.remove();
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  expect(button, `missing button ${text}`).toBeTruthy();
  return button as HTMLButtonElement;
}

describe("AgentPromptSetupPicker", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders all supported clients and a prompt with origin, room, pairing context, and static docs", () => {
    mountPicker();
    try {
      for (const client of AGENT_PROMPT_CLIENTS) {
        expect(container.textContent).toContain(client.label);
      }

      const prompt = container.querySelector('[data-testid="agent-prompt-preview"]')!.textContent ?? "";
      expect(prompt).toContain("Parlor 站点：https://parlor.example");
      expect(prompt).toContain("目标房间：发布冲刺（room-42）");
      expect(prompt).toContain("配对码：mpc_test_code");
      expect(prompt).toContain("https://parlor.example/prompts/claude-code.md");
      expect(prompt).toContain("https://parlor.example/agents/skill.md");

      const links = Array.from(container.querySelectorAll<HTMLAnchorElement>(".agent-prompt-setup__doclinks a"));
      expect(links[0]?.href).toBe("https://parlor.example/prompts/claude-code.md");
      expect(links[1]?.href).toBe("https://parlor.example/agents/skill.md");
    } finally {
      unmountPicker();
    }
  });

  it("switches clients and updates the prompt, link, and fallback command", () => {
    mountPicker();
    try {
      act(() => {
        buttonByText("Grok Bot / 云端助手").click();
      });

      const prompt = container.querySelector('[data-testid="agent-prompt-preview"]')!.textContent ?? "";
      expect(prompt).toContain("Grok Bot / 云端助手");
      expect(prompt).toContain("https://parlor.example/prompts/cloud-webhook.md");
      expect(prompt).toContain("不要自己编造邀请令牌");

      const fallback = container.querySelector(".agent-prompt-setup__fallback pre")!.textContent ?? "";
      expect(fallback).toContain("xmtp-member-latest.tar.gz");
      expect(fallback).toContain("--invite");
      expect(fallback).toContain("邀请链接");
    } finally {
      unmountPicker();
    }
  });

  it("copies the tailored prompt and shows success feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    mountPicker();
    try {
      const copyPrompt = buttonByText("复制专属提示词");
      await act(async () => {
        copyPrompt.click();
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0]?.[0]).toContain("你是主人的 Claude Code Agent");
      expect(copyPrompt.textContent).toContain("已复制");
    } finally {
      unmountPicker();
    }
  });

  it("keeps the original terminal install and pairing commands as fallback", () => {
    mountPicker();
    try {
      const fallback = container.querySelector(".agent-prompt-setup__fallback pre")!.textContent ?? "";
      expect(fallback).toContain("install.sh");
      expect(fallback).toContain("install.ps1");
      expect(fallback).toContain("--pair 'mpc_test_code'");
      expect(fallback).toContain("npm install -g @anthropic-ai/claude-code && claude");
      expect(container.textContent).toContain("备用方式：终端安装 / 配对命令");
    } finally {
      unmountPicker();
    }
  });

  it("uses clear placeholders when room or pairing context is absent", () => {
    const prompt = buildAgentPrompt({
      clientId: "codex",
      origin: "https://parlor.example",
    });
    expect(prompt).toContain("<目标房间：请先在 Parlor 网页选择或创建一个房间>");
    expect(prompt).toContain("<未提供。若本机助手未配对，请让人类在 Parlor 的「接入助手」页生成一次性配对码>");
    expect(prompt).toContain("https://parlor.example/prompts/codex.md");
  });

  it("quotes generated fallback pairing commands for safe copy and paste", () => {
    const command = buildFallbackCommand({
      clientId: "gemini-cli",
      origin: "https://parlor.example",
      pairingCode: "mpc test'code",
    });
    expect(command).toContain("--pair 'mpc test'\"'\"'code'");
    expect(command).toContain("-Pair 'mpc test''code'");
    expect(command).toContain("npm install -g @google/gemini-cli && gemini");
  });
});
