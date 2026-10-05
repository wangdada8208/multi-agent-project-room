import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli } from "./cli.ts";
import { applyJoinApproval } from "./joinRequest.ts";
import { normalizePolicy } from "./policy.ts";
import { handleEnvelope, type HandleEnvelopeDeps } from "./handleEnvelope.ts";
import { approveConsent, type ConsentActionDeps } from "./consentActions.ts";
import { ConsentQueue } from "./consentQueue.ts";
import { decodeEnvelope, type RequestEnvelope } from "./envelope.ts";
import type { LedgerEntry } from "./ledger.ts";

test("End-to-End Acceptance: autonomous agent onboarding via CLI and invite scopes, handling calendar.free_busy", async () => {
  // 1. 新代理通过 mapr identity create 在独立目录中生成专属身份与环境文件
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "agent-onboard-"));
  const cliOutput: string[] = [];

  const exitCode = await runCli(["identity", "create", "--dir", agentDir], {
    stdout: (msg) => cliOutput.push(msg),
    stderr: () => {},
  });
  assert.equal(exitCode, 0);

  const outJson = JSON.parse(cliOutput.join("").trim());
  assert.ok(outJson.address);
  const agentAddress = outJson.address.toLowerCase();

  // 读取生成的 .env，获取代理私钥
  const envContent = await readFile(path.join(agentDir, ".env"), "utf8");
  const keyMatch = envContent.match(/XMTP_WALLET_KEY=(0x[0-9a-fA-F]{64})/);
  assert.ok(keyMatch);
  const agentPrivateKey = keyMatch[1];

  // 2. 模拟房主发出的邀请令牌中的建议范围
  const inviteProposedScopes = ["calendar.free_busy"];

  // 3. 房主在收到兑换后，无需人工界面点击，通过 applyJoinApproval 将新代理纳入 policy.json
  const hostInitialPolicy = normalizePolicy({});
  const hostUpdatedPolicy = applyJoinApproval(
    hostInitialPolicy,
    agentAddress,
    inviteProposedScopes
  );
  assert.deepEqual(hostUpdatedPolicy.allow[agentAddress], ["calendar.free_busy"]);

  // 4. 新代理声明自身能力与对外策略，允许房主向其请求日历
  const hostAddress = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const agentPolicy = normalizePolicy({
    allow: {
      [hostAddress]: ["calendar.free_busy"],
    },
  });

  // 5. 房主向新代理发起日历忙闲查询请求
  const request: RequestEnvelope = {
    kind: "request",
    request_id: "req-agent-onboard-001",
    to: agentAddress,
    scope: "calendar.free_busy",
    purpose: "自动协商周例会时段",
    constraints: {
      date_from: "2026-10-05",
      date_to: "2026-10-09",
    },
  };

  const queue = new ConsentQueue(path.join(agentDir, "consents.json"));
  const sentMessages: { conv: string; text: string }[] = [];
  const ledger: LedgerEntry[] = [];
  const now = new Date("2026-10-05T08:00:00Z");

  const agentDeps: HandleEnvelopeDeps = {
    selfAddress: agentAddress,
    policy: agentPolicy,
    queue,
    send: async (conv, text) => {
      sentMessages.push({ conv, text });
    },
    appendLedger: async (e) => {
      ledger.push(e);
    },
    storeDisclosure: async () => true,
    now: () => now,
  };

  // 代理网关接收到请求
  const outcome = await handleEnvelope(
    { envelope: request, sender: hostAddress, conversationId: "conv-shared-room" },
    agentDeps
  );
  assert.equal(outcome, "queued");

  // 验证网关向群内广播了 consent_pending
  const pendingMsg = decodeEnvelope(sentMessages[0].text);
  assert.equal(pendingMsg?.kind, "consent_pending");
  assert.equal(pendingMsg.request_id, "req-agent-onboard-001");

  // 6. 代理网关执行单次授权批准，生成并返回忙闲时段披露
  const agentCalendar = [
    { start: "2026-10-06T10:00:00Z", end: "2026-10-06T11:00:00Z", title: "内部代码评审" },
  ];

  const agentActions: ConsentActionDeps = {
    selfAddress: agentAddress,
    privateKey: agentPrivateKey,
    queue,
    loadCalendar: async () => agentCalendar,
    send: async (conv, text) => {
      sentMessages.push({ conv, text });
    },
    appendLedger: async (e) => {
      ledger.push(e);
    },
    now: () => now,
  };

  const approveResult = await approveConsent("req-agent-onboard-001", agentActions);
  assert.equal(approveResult.ok, true);

  // 7. 验证最终广播的披露消息包含合法的忙闲时段，且不泄露日历事件标题
  const disclosureMsg = decodeEnvelope(sentMessages[sentMessages.length - 1].text);
  assert.equal(disclosureMsg?.kind, "disclosure");
  if (disclosureMsg?.kind === "disclosure") {
    assert.equal(disclosureMsg.request_id, "req-agent-onboard-001");
    assert.equal(disclosureMsg.payload.scope, "calendar.free_busy");
    assert.deepEqual(disclosureMsg.payload.busy, [
      { start: "2026-10-06T10:00:00.000Z", end: "2026-10-06T11:00:00.000Z" },
    ]);
    assert.equal(JSON.stringify(disclosureMsg).includes("内部代码评审"), false);
  }
});
