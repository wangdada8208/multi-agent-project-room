import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, createSigner, createUser } from "@xmtp/agent-sdk";
import { buildEvidence } from "./evidence.ts";

const PROBE = "member-send-dev-ping";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const hubSqlite = process.env.HUB_SQLITE || resolve(repoRoot, "agent_room.db");

// Verify Hub SQLite messages table presence
let messagesTablePresent = false;
let hubPlaintextCount = -1;

try {
  const tableCheck = execSync(
    `sqlite3 "${hubSqlite}" "select name from sqlite_master where type='table' and name='messages';"`
  )
    .toString()
    .trim();
  if (tableCheck === "messages") {
    messagesTablePresent = true;
    const countCheck = execSync(
      `sqlite3 "${hubSqlite}" "select count(*) from messages where content like '%${PROBE}%';"`
    )
      .toString()
      .trim();
    hubPlaintextCount = parseInt(countCheck, 10);
  }
} catch {
  messagesTablePresent = false;
}

if (!messagesTablePresent) {
  throw new Error(`messages table absent in ${hubSqlite}`);
}

const bobUser = createUser();
const bob = await Agent.create(createSigner(bobUser), {
  env: "dev",
  dbPath: null,
});

if (!bob.address) {
  throw new Error("Bob address required but was empty");
}

let probeReceived = false;
let replyReceived = false;

bob.on("text", async (ctx: any) => {
  const text =
    typeof ctx.message?.content === "string"
      ? ctx.message.content
      : ctx.message?.content?.text || "";
  if (text === PROBE) {
    probeReceived = true;
    const replyText = "收到，本轮由 Codex 处理。";
    if (typeof ctx.sendText === "function") {
      await ctx.sendText(replyText);
    } else if (ctx.conversation && typeof ctx.conversation.sendText === "function") {
      await ctx.conversation.sendText(replyText);
    }
  }
});
await bob.start();

const aliceUser = createUser();
const alice = await Agent.create(createSigner(aliceUser), {
  env: "dev",
  dbPath: null,
});

alice.on("text", async (ctx: any) => {
  const text =
    typeof ctx.message?.content === "string"
      ? ctx.message.content
      : ctx.message?.content?.text || "";
  if (text.includes("收到，本轮由")) {
    replyReceived = true;
  }
});
await alice.start();

const group = await alice.createGroupWithAddresses([bob.address as `0x${string}`]);
await group.sendText(PROBE);

const startTime = Date.now();
while (!probeReceived || !replyReceived) {
  if (Date.now() - startTime > 60_000) {
    await bob.stop().catch(() => {});
    await alice.stop().catch(() => {});
    throw new Error("Timeout waiting for probe and reply on XMTP dev network (60s)");
  }
  await new Promise((r) => setTimeout(r, 500));
}

await bob.stop().catch(() => {});
await alice.stop().catch(() => {});

// Re-check Hub database count after probe delivery
try {
  const countCheck = execSync(
    `sqlite3 "${hubSqlite}" "select count(*) from messages where content like '%${PROBE}%';"`
  )
    .toString()
    .trim();
  hubPlaintextCount = parseInt(countCheck, 10);
} catch {
  // Keep previous count
}

const evidenceDir = resolve(repoRoot, "docs/superpowers/evidence");
mkdirSync(evidenceDir, { recursive: true });
const evidencePath = resolve(evidenceDir, "dev-roundtrip.json");

let existingBrowserGroupId: string | undefined = process.env.BROWSER_GROUP_ID;
if (!existingBrowserGroupId) {
  try {
    const existing = JSON.parse(readFileSync(evidencePath, "utf-8"));
    if (existing.browser_group_id) {
      existingBrowserGroupId = existing.browser_group_id;
    }
  } catch {}
}

const evidence = buildEvidence({
  groupId: group.id,
  probeReceivedByPeer: probeReceived,
  replyReceivedBySender: replyReceived,
  hubPlaintextCount,
  messagesTablePresent,
  hubDatabase: basename(hubSqlite),
  browserGroupId: existingBrowserGroupId,
});

writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
console.log("devRoundtrip completed successfully:", evidencePath);
