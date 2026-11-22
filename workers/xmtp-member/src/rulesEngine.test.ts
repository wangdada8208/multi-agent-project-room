import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decide,
  effectiveRules,
  isHardForbiddenScope,
  loadHubRoomSettings,
  mergeHubHouseRules,
  normalizeHubRoomSettings,
  normalizeRules,
  teamConfigPromptBlock,
  TEAM_CONFIG_MAX_CHARS,
  type HubRoomSettings,
} from "./rulesEngine.ts";
import { normalizePolicy, type Policy } from "./policy.ts";

const A = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const B = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

function policy(raw: any = {}): Policy {
  return normalizePolicy(raw);
}

test("hard-cannot scopes are denied no matter what rules say", () => {
  const rules = effectiveRules(policy({ rules: { house: { "payment.send": "allow", "*": "allow" } } }));
  assert.equal(decide(rules, policy(), { actor: A, kind: "action", scope: "payment.send" }).decision, "cannot");
  assert.equal(decide(rules, policy(), { actor: A, kind: "data", scope: "data.export_all" }).decision, "cannot");
});

test("actor override beats house rule", () => {
  const rules = effectiveRules(policy({
    rules: { house: { "gmail.send": "cannot" }, actors: { [A]: { "gmail.send": "ask" } } },
  }));
  assert.equal(decide(rules, policy(), { actor: A, kind: "action", scope: "gmail.send" }).decision, "ask");
  assert.equal(decide(rules, policy(), { actor: B, kind: "action", scope: "gmail.send" }).decision, "cannot");
});

test("house scope rule applies to every actor", () => {
  const rules = effectiveRules(policy({ rules: { house: { "calendar.event.create": "ask" } } }));
  for (const actor of [A, B]) {
    const hit = decide(rules, policy(), { actor, kind: "action", scope: "calendar.event.create" });
    assert.deepEqual(hit, { decision: "ask", rule: "house:calendar.event.create=ask" });
  }
});

test("legacy allow-list maps to ask for data requests, never auto-executes", () => {
  const p = policy({ allow: { [A]: ["calendar.free_busy"] } });
  const rules = effectiveRules(p);
  assert.equal(decide(rules, p, { actor: A, kind: "data", scope: "calendar.free_busy" }).decision, "ask");
  // 动作 scope 不吃旧白名单——allow 表里本来没有动作语义。
  assert.equal(decide(rules, p, { actor: A, kind: "action", scope: "calendar.free_busy" }).decision, "ask");
  assert.notEqual(
    decide(rules, p, { actor: A, kind: "data", scope: "calendar.free_busy" }).rule,
    "house:*=allow"
  );
});

test("unlisted actors fall to the wildcard default ask", () => {
  const rules = effectiveRules(policy());
  assert.deepEqual(
    decide(rules, policy(), { actor: B, kind: "data", scope: "calendar.free_busy" }),
    { decision: "ask", rule: "house:*=ask" }
  );
  assert.equal(decide(rules, policy(), { actor: B, kind: "action", scope: "gmail.send" }).decision, "ask");
});

test("owner can tighten wildcard to cannot", () => {
  const rules = effectiveRules(policy({ rules: { house: { "*": "cannot" } } }));
  assert.equal(decide(rules, policy(), { actor: A, kind: "action", scope: "anything" }).decision, "cannot");
});

test("allow rule produces an allow decision with the rule recorded", () => {
  const rules = effectiveRules(policy({ rules: { actors: { [A]: { "calendar.free_busy": "allow" } } } }));
  assert.deepEqual(decide(rules, policy(), { actor: A, kind: "data", scope: "calendar.free_busy" }), {
    decision: "allow",
    rule: "actor:calendar.free_busy=allow",
  });
});

test("normalizeRules drops invalid decisions and normalizes actor case", () => {
  const rules = normalizeRules({
    house: { "gmail.send": "maybe", "calendar.event.create": "ask" },
    actors: { [A.toUpperCase()]: { "gmail.send": "allow" }, bad: "nope" },
  });
  assert.deepEqual(rules.house, { "calendar.event.create": "ask" });
  assert.deepEqual(rules.actors[A], { "gmail.send": "allow" });
});

// ── WP5/WP9：Hub 房间元数据建议的边界与合并 ──

function hubSettings(scopes: Record<string, string>, over: Record<string, unknown> = {}): HubRoomSettings | null {
  return normalizeHubRoomSettings({
    settings_version: 3,
    settings_json: { house_rules: { scopes }, ...over },
  });
}

test("isHardForbiddenScope: 硬禁区规范化后仍命中", () => {
  assert.equal(isHardForbiddenScope("payment.send"), true);
  assert.equal(isHardForbiddenScope(" PAYMENT.send "), true);
  assert.equal(isHardForbiddenScope("data.export_all"), true);
  assert.equal(isHardForbiddenScope("calendar.free_busy"), false);
});

test("normalizeHubRoomSettings: Hub allow 一律降格 ask，cannot 保留，非法项丢弃", () => {
  const s = hubSettings({
    "gmail.send": "allow",
    "calendar.event.create": "cannot",
    "calendar.free_busy": "ask",
    "bad scope!": "cannot",
    "payment.send": "allow",
    "*": "allow",
  });
  assert.ok(s);
  assert.deepEqual(s.houseRules.scopes, {
    "gmail.send": "ask",
    "calendar.event.create": "cannot",
    "calendar.free_busy": "ask",
    "payment.send": "ask",
    "*": "ask",
  });
  assert.equal(s.houseRules.scopes["bad scope!"], undefined);
});

test("normalizeHubRoomSettings: 边界限量——markdown/notes/rounds 截断，坏文档返回 null", () => {
  const s = normalizeHubRoomSettings({
    settings_version: 1,
    settings_json: {
      team_config_markdown: "x".repeat(TEAM_CONFIG_MAX_CHARS + 100),
      default_max_rounds: 99,
      house_rules: { notes: ["ok", 42, "y".repeat(500)] },
    },
  });
  assert.ok(s);
  assert.equal(s.teamConfigMarkdown!.length, TEAM_CONFIG_MAX_CHARS);
  assert.equal(s.defaultMaxRounds, undefined);
  assert.deepEqual(s.houseRules.notes, ["ok", "y".repeat(280)]);
  assert.equal(normalizeHubRoomSettings(null), null);
  assert.equal(normalizeHubRoomSettings("junk"), null);
  assert.equal(normalizeHubRoomSettings({ settings_version: "x" }), null);
});

test("loadHubRoomSettings: 缺失/损坏文件返回 null，正常文件往返一致", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mapr-hubsettings-"));
  try {
    const file = path.join(dir, "hub-room-settings.json");
    assert.equal(await loadHubRoomSettings(file), null);
    await writeFile(file, "not json");
    assert.equal(await loadHubRoomSettings(file), null);
    await writeFile(file, JSON.stringify({
      settings_version: 2,
      settings_json: { team_config_markdown: "排期交给 Claude", default_max_rounds: 5 },
    }));
    const s = await loadHubRoomSettings(file);
    assert.equal(s?.version, 2);
    assert.equal(s?.teamConfigMarkdown, "排期交给 Claude");
    assert.equal(s?.defaultMaxRounds, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeHubHouseRules: Hub cannot 收紧空白 scope；Hub 永不产出 allow", () => {
  const p = policy();
  const merged = mergeHubHouseRules(p, hubSettings({ "gmail.send": "cannot", "calendar.event.create": "allow" }));
  assert.equal(decide(merged, p, { actor: A, kind: "action", scope: "gmail.send" }).decision, "cannot");
  // Hub 的 "allow" 被收成 ask——远端永远不能替主人放权。
  assert.equal(decide(merged, p, { actor: A, kind: "action", scope: "calendar.event.create" }).decision, "ask");
  assert.equal(decide(merged, p, { actor: A, kind: "action", scope: "other" }).decision, "ask");
});

test("mergeHubHouseRules: 本机 actor > 本机 house > hub 建议", () => {
  const p = policy({
    rules: {
      house: { "calendar.event.create": "cannot" },
      actors: { [A]: { "gmail.send": "allow" } },
    },
  });
  const merged = mergeHubHouseRules(
    p,
    hubSettings({ "calendar.event.create": "ask", "gmail.send": "cannot" })
  );
  // 本机 house 写过 create=cannot：Hub 的 ask 不得放松它。
  assert.equal(decide(merged, p, { actor: A, kind: "action", scope: "calendar.event.create" }).decision, "cannot");
  // 本机 actor 写过 send=allow：先于 house 命中，Hub 的 cannot 影响不到它。
  assert.equal(decide(merged, p, { actor: A, kind: "action", scope: "gmail.send" }).decision, "allow");
  // 没写规则的 actor 吃 Hub 建议：send 被收紧成 cannot。
  assert.equal(decide(merged, p, { actor: B, kind: "action", scope: "gmail.send" }).decision, "cannot");
});

test("mergeHubHouseRules: 本机 *=cannot 时 Hub 不得松开；本机 *=allow 时 Hub 可收紧", () => {
  const tight = policy({ rules: { house: { "*": "cannot" } } });
  const mergedTight = mergeHubHouseRules(tight, hubSettings({ "calendar.free_busy": "ask", "*": "ask" }));
  assert.equal(decide(mergedTight, tight, { actor: A, kind: "data", scope: "calendar.free_busy" }).decision, "cannot");

  const loose = policy({ rules: { house: { "*": "allow" } } });
  const mergedLoose = mergeHubHouseRules(loose, hubSettings({ "gmail.send": "cannot", "x.y": "ask" }));
  assert.equal(decide(mergedLoose, loose, { actor: A, kind: "action", scope: "gmail.send" }).decision, "cannot");
  assert.equal(decide(mergedLoose, loose, { actor: A, kind: "action", scope: "x.y" }).decision, "ask");
  assert.equal(decide(mergedLoose, loose, { actor: A, kind: "action", scope: "unlisted" }).decision, "allow");
});

test("mergeHubHouseRules: 本机没写 * 时 Hub *→cannot 可填空收紧；hard_cannot 仍最硬", () => {
  const p = policy();
  const merged = mergeHubHouseRules(p, hubSettings({ "*": "cannot" }));
  assert.equal(decide(merged, p, { actor: A, kind: "action", scope: "anything" }).decision, "cannot");
  const merged2 = mergeHubHouseRules(p, hubSettings({ "payment.send": "ask" }));
  // Hub 建议 ask、本机也没拦——硬禁区照样 cannot。
  assert.equal(decide(merged2, p, { actor: A, kind: "action", scope: "payment.send" }).decision, "cannot");
});

test("teamConfigPromptBlock: 明确标注非授权依据，超限截断，空文本为空串", () => {
  assert.equal(teamConfigPromptBlock(""), "");
  assert.equal(teamConfigPromptBlock(null), "");
  const block = teamConfigPromptBlock("日程由 Claude 主协调");
  assert.ok(block.includes("非授权依据") || block.includes("不构成授权依据"));
  assert.ok(block.includes("<team_config>"));
  assert.ok(block.includes("日程由 Claude 主协调"));
  const huge = teamConfigPromptBlock("z".repeat(TEAM_CONFIG_MAX_CHARS + 50));
  assert.equal(huge.includes("z".repeat(TEAM_CONFIG_MAX_CHARS + 1)), false);
});
