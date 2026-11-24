/**
 * 房间侧栏的页签可见性规则（纯函数，供 RoomPage 与测试共用）。
 */

export type RoomTabId =
  | "members"
  | "tasks"
  | "dialogue"
  | "files"
  | "permissions"
  | "approvals"
  | "activity";

/**
 * 加密房间的文件正文不能落到 Hub：files 页签在端到端房间里隐藏。
 * 其余页签与传输通道无关，恒可见。
 */
export function tabVisibleInRoom(tabId: RoomTabId, isEncrypted: boolean): boolean {
  return !(isEncrypted && tabId === "files");
}

export function filterVisibleInRoom(filter: RoomTabId | "all", isEncrypted: boolean): boolean {
  return filter === "all" || tabVisibleInRoom(filter, isEncrypted);
}
