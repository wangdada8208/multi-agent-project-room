import { describe, expect, it } from "vitest";
import { AGENT_PRESETS, findAgentPreset } from "./agentPresets";

describe("AGENT_PRESETS", () => {
  it("contains all 7 flagship and universal agent presets in order", () => {
    expect(AGENT_PRESETS.map((p) => p.id)).toEqual([
      "claude-code",
      "codex",
      "grok",
      "muse",
      "gemini-cli",
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

  it("configures Grok / Grokbot and Muse with both primary and webhook bridge presets", () => {
    const grok = findAgentPreset("grok");
    expect(grok).toMatchObject({
      title: "Grok / Grokbot",
      mode: "helper-preset",
      helperPreset: "grok",
      altHelperPreset: "grokbot-webhook",
      trustTier: "cloud-api",
    });

    const muse = findAgentPreset("muse");
    expect(muse).toMatchObject({
      title: "Muse",
      mode: "helper-preset",
      helperPreset: "muse",
      altHelperPreset: "muse-webhook",
      trustTier: "cloud-api",
    });
  });

  it("configures Ollama and custom Webhook presets with honest trust tiers", () => {
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
