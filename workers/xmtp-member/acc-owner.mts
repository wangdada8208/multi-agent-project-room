// 真机验收的「主人」XMTP 驱动：扮演浏览器里房主做的事——
// 建加密群 → 轮询 Hub 待入群席位 → 拉群 → 回报 group-added → 发话 → 听回复。
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { Agent, createSigner, createUser } from "@xmtp/agent-sdk";

const HUB = (process.env.HUB_ORIGIN || "https://hub.wangdada8208.xyz").replace(/\/$/, "");
const TOKEN = process.env.OWNER_TOKEN!;
const ROOM_ID = process.env.ROOM_ID!;
const OUT = process.env.OUT_DIR || "/tmp/mapr-acc";
const LOG = `${OUT}/replies.log`;
const log = (m: string) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
};

const authed = (p: string, init?: RequestInit) =>
  fetch(`${HUB}${p}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init?.headers || {}) },
  });

// 身份落盘：重启复用同一个 owner（否则 createUser 会换随机身份、丢群管理权）。
const KEY_FILE = `${OUT}/owner-key.txt`;
let user;
if (existsSync(KEY_FILE)) {
  user = createUser(readFileSync(KEY_FILE, "utf8").trim() as `0x${string}`);
} else {
  user = createUser();
  writeFileSync(KEY_FILE, String((user as any).key ?? (user as any).privateKey ?? ""), { mode: 0o600 });
}

const owner = await Agent.create(createSigner(user), {
  env: "production",
  dbPath: `${OUT}/xmtp-owner.db`,
});
writeFileSync(`${OUT}/owner-address.txt`, String(owner.address).toLowerCase());
log(`owner address: ${owner.address}`);

owner.on("text", async (ctx: any) => {
  const sender = (await ctx.getSenderAddress?.()) || "?";
  const text = typeof ctx.message?.content === "string" ? ctx.message.content : ctx.message?.content?.text || "";
  log(`REPLY from ${sender}: ${text}`);
});
await owner.start();

let group: any;
if (existsSync(`${OUT}/group-id.txt`)) {
  const gid = readFileSync(`${OUT}/group-id.txt`, "utf8").trim();
  const ctx = await owner.getConversationContext(gid);
  if (!ctx) throw new Error(`group ${gid} not found locally`);
  group = ctx.conversation;
  log(`reusing group ${gid}`);
} else {
  group = await owner.createGroupWithAddresses([]);
  writeFileSync(`${OUT}/group-id.txt`, group.id);
  log(`group created: ${group.id}`);
}

const addedSeats = new Set<string>();
let welcomed = false;
const poll = async () => {
  try {
    const resp = await authed(`/api/v1/rooms/${ROOM_ID}/seats`);
    if (!resp.ok) { log(`seats poll: HTTP ${resp.status}`); return; }
    const seats: any[] = await resp.json();
    for (const s of seats) {
      if (s.group_status !== "pending" || addedSeats.has(s.seat_id)) continue;
      const addr = String(s.xmtp_address).toLowerCase();
      log(`pending seat ${s.seat_id} (${s.agent_display_name}) @ ${addr}`);
      const members = await group.members();
      const present = new Set(members.flatMap((m: any) => (m.accountIdentifiers || []).map((i: any) => String(i.identifier).toLowerCase())));
      if (!present.has(addr)) {
        await owner.addMembersWithAddresses(group, [addr as `0x${string}`]);
        log(`added ${addr} to group`);
      }
      const r = await authed(`/api/v1/rooms/${ROOM_ID}/seats/${encodeURIComponent(s.seat_id)}/group-added`, { method: "POST" });
      log(`group-added ${s.seat_id}: HTTP ${r.status}`);
      addedSeats.add(s.seat_id);
      if (!welcomed) {
        welcomed = true;
        await group.sendText("验收：请各位在座的 Agent 回复一个字——「在」");
        log("welcome message sent");
      }
    }
  } catch (e: any) {
    log(`poll error: ${e?.message || e}`);
  }
};
await poll();
setInterval(poll, 10_000);
setTimeout(() => { log("driver timeout; exiting"); process.exit(0); }, 20 * 60_000);
