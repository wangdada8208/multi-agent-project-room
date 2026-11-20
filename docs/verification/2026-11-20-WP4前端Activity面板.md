# WP4 前端 Activity 面板与 M6 审批补充验证（2026-11-20）

范围：`frontend/src/lib/activityApi.ts` + `.test.ts`、`frontend/src/components/panels/ActivityPanel.tsx`、`frontend/src/lib/roomTabs.ts` + `.test.ts`、`frontend/src/pages/RoomPage.tsx`、`frontend/src/components/panels/OwnerApprovalPanel.tsx` + `.test.tsx`。

## 交付内容

1. **Hub + 本机合并活动流（`activityApi.ts`）**：
   - `fetchHubActivity(roomId, filters)` 对接 `GET /api/v1/rooms/{room_id}/activity`（支持 `actor`、`app`、`kind`、`status`、`since`、`until`、`limit`）。
   - `fetchLocalActivity(port, filters)` 带 `X-MAPR-Owner: 1` 请求本机回环 `GET http://127.0.0.1:{port}/api/activity`（5s 超时）；远程不可达或无本机控制台时降级返回 `available: false`（不阻断页面）。
   - `mergeActivityFeeds()` 将本机账本与 Hub `activity`/`task_event`/`approval` 去重合并、按时间倒序展示，并汇总 `verifyLedger` 完整性问题（如 `anchor_truncated`、`entry_hash_mismatch`）与历史未验证条目计数。
2. **「动态」侧栏页签与面板（`ActivityPanel.tsx` / `RoomPage.tsx` / `roomTabs.ts`）**：
   - 展示完整性/锚点状态横幅、多维过滤栏（Actor、应用、事件类型 `kind`、状态、时间窗）与来源徽标（`本机账本` / `Hub 活动` / `Hub 任务` / `Hub 审批`），不包含任何聊天/邮件正文。
3. **M6 审批卡补充（`OwnerApprovalPanel.tsx`）**：
   - 崩溃恢复滞留在 `approved`（未执行）状态的条目允许在前端点击「拒绝」，与后端/worker `TRANSITIONS` 表一致。

## 本机实测

```bash
cd /data/projects/multi-agent-project-room/frontend && npm test && npm run build
```

- `vitest run`：**24 个测试文件 / 202 passed / 0 failed**（含 `activityApi.test.ts` 3 例与 `OwnerApprovalPanel.test.tsx` M6 回归）。
- `npm run build`（`tsc -b && vite build`）：**0 错误**，产物构建成功。

## 诚实声明

- 均为前端单元测试与生产构建验证；未连接真实运行中的本地 helper/Hub 实例做浏览器端到端点击流测试，亦未提交/推送/部署。
