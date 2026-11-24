import { describe, expect, it } from "vitest";
import { AGENT_PRESETS, cloudAgentConnectCommand, findAgentPreset } from "./agentPresets";

describe("AGENT_PRESETS", () => {
  it("orders the cloud agents before the terminal and model presets", () => {
    expect(AGENT_PRESETS.map((p) => p.id)).toEqual([
      "grok",
      "muse",
      "claude-code",
      "codex",
      "gemini-cli",
      "xai-api",
      "ollama",
      "webhook",
    ]);
  });

  it("configures local-cli presets with cliKey, local-cli trustTier, and installCmd", () => {
    const localPresets = AGENT_PRESETS.filter((p) => p.mode === "local-cli");
    expect(localPresets.map((p) => p.id)).toEqual(["claude-code", "codex", "gemini-cli"]);
    for (const preset of localPresets) {
      expect(preset.cliKey).toBe(preset.id);
      expect(preset.trustTier).toBe("local-cli");
      expect(preset.installCmd).toMatch(/^npm install -g /);
    }
  });

  it("provides direct cloud invitations for Grok Bot and Muse", () => {
    const grok = findAgentPreset("grok");
    expect(grok).toMatchObject({
      title: "Grok Bot",
      mode: "cloud-agent",
      trustTier: "cloud-api",
    });

    const muse = findAgentPreset("muse");
    expect(muse).toMatchObject({
      title: "Muse",
      mode: "cloud-agent",
      trustTier: "cloud-api",
    });
    expect(grok).not.toHaveProperty("helperPreset");
    expect(muse).not.toHaveProperty("helperPreset");
  });

  it("configures xAI, Ollama, and custom Webhook through the helper", () => {
    expect(findAgentPreset("xai-api")).toMatchObject({
      mode: "helper-preset",
      helperPreset: "grok",
      trustTier: "cloud-api",
    });
    expect(findAgentPreset("ollama")).toMatchObject({
      mode: "helper-preset",
      helperPreset: "ollama",
      trustTier: "local-cli",
    });
    expect(findAgentPreset("webhook")).toMatchObject({
      mode: "helper-preset",
      helperPreset: "webhook",
      trustTier: "custom-webhook",
    });
  });

  it("contains zero emoji characters in titles, subtitles, and descriptions", () => {
    const emojiPattern = /\p{Extended_Pictographic}/u;
    for (const item of AGENT_PRESETS) {
      expect(item.title).not.toMatch(emojiPattern);
      expect(item.subtitle).not.toMatch(emojiPattern);
      expect(item.description).not.toMatch(emojiPattern);
    }
  });
});

describe("cloudAgentConnectCommand", () => {
  it("builds the bridge command using the selected XMTP environment", () => {
    expect(cloudAgentConnectCommand({
      hubOrigin: "https://hub.example",
      inviteUrl: "https://app.example/rooms/room-42?invite=invite%2Btoken",
      title: "Grok Bot",
      env: "dev",
    })).toBe([
      "curl -fsSL https://hub.example/downloads/xmtp-member-latest.tar.gz -o /tmp/mapr.tar.gz",
      "mkdir -p ~/.mapr-bot/app",
      "tar -xzf /tmp/mapr.tar.gz -C ~/.mapr-bot/app --strip-components=1",
      "(cd ~/.mapr-bot/app && npm ci --omit=dev)",
      'node --experimental-strip-types ~/.mapr-bot/app/src/cli.ts bridge --invite "https://app.example/rooms/room-42?invite=invite%2Btoken" --name "Grok Bot" --env "dev"',
    ].join(" && "));
  });

  it("keeps shell metacharacters inside quoted arguments", () => {
    const command = cloudAgentConnectCommand({
      hubOrigin: "https://hub.example",
      inviteUrl: 'https://app.example/rooms/room-42?invite="quoted"&amount=$1',
      title: "Muse",
      env: "local",
    });
    expect(command).toContain('--invite "https://app.example/rooms/room-42?invite=\\"quoted\\"&amount=\\$1"');
    expect(command).toContain('--name "Muse" --env "local"');
  });
});
