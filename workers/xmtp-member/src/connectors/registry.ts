import type { Connector } from "./types.ts";

/**
 * 按 scope（+可选账户）路由连接器：
 * - accountId 未指定：只匹配「无账户绑定」的连接器——绝不静默拿某个具体账户的
 *   凭据替未绑定请求干活（M4 fail closed，宁可 no_connector 也不张冠李戴）；
 * - accountId 指定：只返回 accountId 完全一致的连接器——批准绑定的账户不可被换成别的凭据。
 */
export function findConnector(
  connectors: Connector[],
  scope: string,
  accountId?: string
): Connector | null {
  for (const c of connectors) {
    if (!c.scopes.includes(scope)) continue;
    if (accountId === undefined) {
      if (!c.accountId) return c;
      continue;
    }
    if (c.accountId === accountId) return c;
  }
  return null;
}
