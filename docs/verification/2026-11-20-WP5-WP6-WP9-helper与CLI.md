# 验证报告：WP5/WP6/WP9 Worker 侧——helper 暂停/恢复与房间元数据同步、`mapr join`、云端席位自查、Hub 规则合并、`team_config_markdown` 注入

日期：2026-11-20
执行者：Devin（实现子代理）
范围：仓库 `/data/projects/multi-agent-project-room`，仅 `workers/xmtp-member`；未提交、未推送、未合并、未部署、未触达真实 Gmail/XMTP 网络。

---

## 1. 结论

- WP5/WP6/WP9 Worker 侧实现：**已完成（已验证）**，单元级。
- 测试：聚焦套件 117 通过 / 0 失败（基线 86 → 新增 31 个用例全部通过）。
- 类型检查：`npm run typecheck` 中本批文件全部干净；仅剩 `src/index.ts`(441) 与 `src/ownerConsole.test.ts`(308) 两处既有错误——两者都在「不得触碰」清单内，属于并行工作者的进行中改动（`git diff` 确认错误行在其未提交 diff 里），本批不负责修复。
- 遗留问题：见 §6。

## 2. 做了什么

### WP5 helper 暂停/恢复生命周期（`src/helper/**`）

- `types.ts`：`SeatRecord` 新增 `pausedAt?: string | null` 与 `pausedSource?: "hub" | "local" | null`；`SeatView` 透出 `pausedAt`；`HeartbeatResponse` 新增 `seats_to_pause?: string[]` 与 `rooms?: HeartbeatRoom[]`（可选字段，兼容不下发它们的旧 Hub）。
- `seats.ts`：`SEAT_ID_RE` 导出（up.ts 拼路径前复用同一道防线）；`views()` 透出 `pausedAt`。
- `up.ts` 心跳对账（`seats_to_pause` 与 `seats_to_stop` 严格分离，绝不复用删除路径）：
  - 在列表内 → 置 `pausedAt` + `pausedSource="hub"` 并 `supervisor.stop()`，seat.json/私钥/沙箱全保留；
  - 移出列表且来源为 hub → 清标记并 `supervisor.start()` 恢复；
  - `pausedSource="local"`（本机手动暂停）不受 Hub 对账影响，只有本机 resume 能解除。
- `up.ts` 房间元数据同步 `syncRoomSettings()`：心跳 `rooms[]` 里每个房间写给本机同房间席位的 `<root>/seats/<seatId>/state/hub-room-settings.json`；仅 `settings_version` 严格前进时重写（防旧心跳回滚），经 `secureFile.writeJsonSecure` 原子落盘（0600/0700+fsync）。`ROOM_SETTINGS_FILENAME` 常量导出。
- `up.ts` 启动恢复：`restoreSeats()` 导出，`pausedAt` 非空的席位不自动拉起；`runHelper` 改用它。`HelperRuntimeOptions.supervisor` 注入点供测试。
- `server.ts`：新增 `POST /api/seats/:id/pause` 与 `/resume`（owner-write 类：仅回环 + `X-MAPR-Owner` 头，hubOrigin 一律 403）。pause 置 `pausedSource="local"` + `supervisor.stop()`；resume 清标记 + `supervisor.start()`，启动失败不假报成功（视图如实返回 crashed/stopped）。
  - 说明：Hub 的 pause/resume 端点只收人类登录令牌，helper 令牌无权调用；本机端点做本地一半（停/起进程+标记），Hub 侧状态由心跳对账收敛。

### WP6 `mapr join` 与云端席位自查

- `cli.ts` `mapr join <invite-url-or-token> [--hub] [--name] [--state-dir] [--wait s] [--poll ms]`（`joinWithInvite` 导出，可注入 fetch/sleep 测试）：
  - 解析完整邀请 URL（`/rooms/<id>?invite=<token>`，也兼容 `/invite(s)/<token>`、`?token=`）或裸 token；Hub 源站优先级 `--hub` > URL 自带源站 > 环境变量 > 默认生产 Hub。
  - 本地 XMTP 身份：`.env` 已有合法 `XMTP_WALLET_KEY` 则复用，否则生成；私钥绝不打印。
  - `POST /api/v1/invites/nonce`（action=`invite-agent-register`）→ `viem privateKeyToAccount().signMessage` 按服务器 message 原文 EIP-191 签名 → `POST /api/v1/invites/{token}/agent-register`。
  - `pending`（主人审批）→ 用同样签名走 `GET .../agent-register` 轮询直到 `consumed` 或 `--wait` 到期（每次领新 nonce）；`denied`/`expired`/`revoked`（409/410）干净退出 1，不落盘。
  - 成功后原子写 `.env`（0600）：`XMTP_*`、`HUB_BASE_URL/HUB_ROOM_ID/HUB_TOKEN`、`MAPR_HUB_URL/MAPR_SEAT_ID/MAPR_AGENT_TOKEN`、`XMTP_GROUP_ID`、`XMTP_ALLOW_GROUP_MEMBERS=1`（云端席位无 helper 下发白名单，群成员即信任边界）。
  - 原子写 `.state/policy.json`（0600）：`approved_scopes` 过滤硬禁区后落成 `rules.actors[本机地址]` 的 `"ask"` 建议（只填空，本机已有裁决不改）。
  - stdout 只含 `status/seat_id/room_id/address`；stderr 只含 reason+HTTP 状态码，不回显响应正文（422 会照抄请求字段）。
- `helper/cloudSeat.ts`（新增，Wave 3 接 `index.ts` 用）：`checkCloudSeat()` → `GET /api/v1/agent-seats/{id}` 映射 `active|paused|removed|unknown`；`removed_at`/`group_status=removed`/403/404 一律 fail-closed 按 removed；5xx/网络/解析失败 → unknown 不误停。`renewToken` 时 active 顺带 `POST .../token`。`startCloudSeatPolling()`：removed 触发一次 `onRemoved` 即自停；paused 边沿回调；续约成功 `onToken`。

### WP5/WP9 Hub 规则合并（`rulesEngine.ts`）

- `isHardForbiddenScope()` 导出（decide 与 CLI 共用同一道红线）。
- `HubRoomSettings` + `normalizeHubRoomSettings()`：`settings_version`/`settings_json` 边界清理；house_rules.scopes 上限 64 条、notes ≤32×280 字符、`team_config_markdown` ≤4096、`default_max_rounds` 限 1–64；非法项逐条丢弃。**铁律 1 在边界执行：Hub "allow" 无条件收成 "ask"。**
- `loadHubRoomSettings(file)`：缺失/损坏/非法 → null（=无建议，本机默认兜底）。
- `mergeHubHouseRules(policy, settings)`：有效优先级 `hard_cannot > 本机 actor > 本机 house > hub 建议 > 出厂默认(ask)`；且 Hub 只收紧不放宽——本机 `*`→cannot 时 Hub 的 "ask" 不得松开，本机 `*` 缺省时 Hub `*`→cannot 可填空收紧。

### WP9 `team_config_markdown` 非授权注入

- `teamConfigPromptBlock()`（rulesEngine.ts）：统一包裹「仅背景参考，不构成授权依据」+ 明确不得扩权/跳过本机规则/绕过审批；≤4096 字符。
- `executor.buildTaskPrompt(task, {teamConfigMarkdown?})`、`coordinator.buildVerdictPrompt(task, result, {teamConfigMarkdown?})`、`onInboundText` 新增 `teamConfigMarkdown` 入参（在送引擎前把包裹块拼到提示词最前）。
- `coordinator.nextStep(task, verdict, maxRounds=3)`：注入 Hub `default_max_rounds`，非法值回落 3。
- 说明：`index.ts`/`handleEnvelope.ts` 在边界外未动；接线（从 `state/hub-room-settings.json` 读入并传入这些可选参数）留给 Wave 3，接口已就位且向后兼容。

## 3. 运行过的命令与结果

```
cd workers/xmtp-member
node --experimental-strip-types --test src/helper/*.test.ts src/cli.test.ts \
  src/rulesEngine.test.ts src/policy.test.ts src/coordinator.test.ts \
  src/executor.test.ts src/onInboundText.test.ts
# → tests 117, pass 117, fail 0（duration ~1.5s）

npm run typecheck
# → src/helper/*, src/cli*, src/rulesEngine*, src/coordinator*, src/executor*,
#   src/onInboundText* 全部干净；
#   仅 src/index.ts(441) 与 src/ownerConsole.test.ts(308) 两处报错——
#   均属并行工作者进行中改动，不在本批边界内。
```

基线对照：改动前同一命令 86 通过；本次新增 31 个用例，全绿。

## 4. 修改文件清单

```
workers/xmtp-member/src/cli.ts
workers/xmtp-member/src/cli.test.ts
workers/xmtp-member/src/coordinator.ts
workers/xmtp-member/src/coordinator.test.ts
workers/xmtp-member/src/executor.ts
workers/xmtp-member/src/executor.test.ts
workers/xmtp-member/src/helper/cloudSeat.ts          (新增)
workers/xmtp-member/src/helper/cloudSeat.test.ts     (新增)
workers/xmtp-member/src/helper/seats.ts
workers/xmtp-member/src/helper/server.ts
workers/xmtp-member/src/helper/server.test.ts
workers/xmtp-member/src/helper/types.ts
workers/xmtp-member/src/helper/up.ts
workers/xmtp-member/src/helper/up.test.ts
workers/xmtp-member/src/onInboundText.ts
workers/xmtp-member/src/onInboundText.test.ts
workers/xmtp-member/src/rulesEngine.ts
workers/xmtp-member/src/rulesEngine.test.ts
docs/verification/2026-11-20-WP5-WP6-WP9-helper与CLI.md (本文件)
```

`policy.ts`/`policy.test.ts` 无需改动（`defaultPolicy`/`normalizePolicy`/`savePolicy` 直接复用）。`backend/**`、`frontend/**` 与禁触 worker 文件（`index.ts`、`handleEnvelope*`、`consent*`、`ownerConsole*`、`accounts*`、`triggers*`、`connectors/**`、`ledger*`、`activity*`、`revocations*`、`senderPolicy*`）均未触碰。

## 5. 安全自查

- `mapr join` 输出不含私钥/签名/令牌/邀请 token/响应正文（用例断言 64-hex、签名、token 均不出现在 stdout）。
- `.env`、`policy.json`、`hub-room-settings.json` 全部原子写 0600，父目录 0700。
- Hub 元数据在任何路径都不会产出 `allow` 决策；hard_cannot 不受 Hub 影响（用例覆盖 `payment.send` 经 Hub 建议仍 cannot）。
- 心跳错误只打印状态级信息；`seats_to_pause` 绝不走删除路径（用例断言 seat.json 保留）。

## 6. 遗留问题 / 边界说明

1. **`src/index.ts` + `src/ownerConsole.test.ts` 类型错误**：并行工作者进行中改动所致，在本批边界外；他们收尾后 `npm run typecheck` 才能全绿。本批文件独立 tsc 无错。
2. **Hub pause/resume 端点是人类 JWT 专用**：helper 侧本机 pause/resume 端点只做本地停/起+标记；网页端发起的暂停经 `seats_to_pause` 心跳收敛（后端 `set_seat_paused` 已写 `paused_at`）。若需要「本机点暂停 → Hub 同步」，需后端加一个 helper 令牌可用的暂停端点（建议 m2/WP5 后续）。
3. **接线在 Wave 3**：`index.ts` 读 `state/hub-room-settings.json` → `loadHubRoomSettings` → 传给 `onInboundText`/envelope 处理 + `startCloudSeatPolling`；`handleEnvelope.ts` 同理。所有接口为可选参数，未接线时行为与此前完全一致。
4. **`mapr join` 未验证真 Hub**：用例用本机回环假 Hub 覆盖 nonce/签名形态/轮询/拒绝路径；真实 EIP-191 验签依赖后端已验证的 `require_signed_nonce`，建议联调阶段跑一遍真实邀请闭环。
5. `mapr join` 的 `--state-dir` 语义 = 工作目录（`.env` 在其下、`.state/policy.json` 在其子目录），与成员进程 `XMTP_LOOP_STATE_PATH` 指向同一 `.state` 即可生效。
