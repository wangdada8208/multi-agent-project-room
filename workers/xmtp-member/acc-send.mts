// 一次性发消息：复用验收 owner 身份，往群里发一条文本。
import { readFileSync } from "node:fs";
import { Agent, createSigner, createUser } from "@xmtp/agent-sdk";

const OUT = process.env.OUT_DIR || "/tmp/mapr-acc";
const TEXT = process.argv.slice(2).join(" ") || "@Claude Code 请回复「在」";
const user = createUser(readFileSync(`${OUT}/owner-key.txt`, "utf8").trim() as `0x${string}`);
const owner = await Agent.create(createSigner(user), { env: "production", dbPath: `${OUT}/xmtp-owner.db` });
await owner.start();
const gid = readFileSync(`${OUT}/group-id.txt`, "utf8").trim();
const ctx = await owner.getConversationContext(gid);
if (!ctx) throw new Error("group not found locally");
await ctx.conversation.sendText(TEXT);
console.log(`sent: ${TEXT}`);
process.exit(0);
