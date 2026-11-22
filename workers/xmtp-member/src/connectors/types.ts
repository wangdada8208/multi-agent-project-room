import type { DateRange, EmailReceiptPayload, FreeBusyPayload } from "../envelope.ts";

/**
 * 执行上下文：与 params 分离传递，不进 canonical params 哈希。
 * request_id 供连接器把「这次执行」标记进外部系统（如 X-MAPR-Request-Id），
 * 便于 uncertain 事后对账；account_id 是批准时绑定的账户路由键（WP7 多账户）。
 */
export interface ExecuteContext {
  request_id?: string;
  account_id?: string;
}

export interface Connector {
  id: string;
  scopes: string[];
  /**
   * 绑定的外部账户 id（WP7 多账户）。无 accountId 的连接器是旧式单账户默认项；
   * findConnector 对指定 accountId 的请求只路由到 accountId 完全一致的连接器。
   */
  accountId?: string;
  fetch(scope: string, constraints: unknown): Promise<unknown>;
  /**
   * 写动作执行入口。只有实现 execute 的连接器可被审批流调用；
   * 未实现的连接器对 action_request 一律回 no_connector。
   * 返回 uncertain 时调用方不得自动重试——动作可能已在外部系统生效。
   */
  execute?(action: string, params: Record<string, unknown>, context?: ExecuteContext): Promise<ActionReceipt>;
}

export interface ActionReceipt {
  status: "executed" | "failed" | "uncertain";
  /** 外部系统回执 id（如 gmail message id），用于事后对账 */
  external_id?: string;
  /** 给人看的一行结果说明，不含敏感正文 */
  summary?: string;
}

export interface EmailReceiptConstraints {
  query: string;
  date_from: string;
  date_to: string;
}

export type { EmailReceiptPayload, FreeBusyPayload, DateRange };
