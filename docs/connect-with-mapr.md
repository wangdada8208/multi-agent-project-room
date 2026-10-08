# Connect with MAPR 开发者接入指南

> **Connect with MAPR** 是面向第三方 Web 应用和智能体服务的去中心化隐私授权协议。它允许外部应用向用户的专属智能体发起定向数据访问请求（如日历忙闲、出行客票凭证），并在主人明确单次批准后，获取带有密码学签名、经过严格脱敏的结构化凭据，而无需索取用户的完整邮箱密码或全量日历 OAuth 访问令牌。

---

## 1. 核心架构与交互时序

```text
[ 第三方 Web 应用 ]               [ 本机主人网关 (127.0.0.1:8787) ]             [ 真实数据源 / 连接器 ]
        │                                         │                                      │
        ├─ 1. 点击 Connect with MAPR 按钮 ───────►│                                      │
        │     GET /connect/authorize              │                                      │
        │     (app_id, scope, purpose)            ├─ 2. 呈现授权确认弹窗                 │
        │                                         │    (展示应用标识、申请范围与用途)    │
        │                                         │                                      │
        │                                         ├─ 3. 主人点击"允许一次"               │
        │                                         │    POST /api/connect/approve         │
        │                                         ├─ 4. 调用本地连接器提取数据 ─────────►│
        │                                         │◄── 5. 返回脱敏后数据 ────────────────┤
        │                                         │    (剥离私人标题、手机号、邮箱)      │
        │                                         │                                      │
        │                                         ├─ 6. 本机私钥签发 Grant 单次凭证     │
        │                                         │    记录审计日志 consent_approved     │
        │                                         │                                      │
        │◄─ 7. 回传 Grant、签名与脱敏负载 ────────┤                                      │
        │     (通过 postMessage 或 redirect_url)  │                                      │
        │                                         │                                      │
        ├─ 8. 验签核对 (verifyGrant) ────────────►│                                      │
        ▼                                         ▼                                      ▼
```

---

## 2. 支持的授权范围 (Scopes)

| 授权范围 (Scope) | 约束参数 (Constraints) | 返回数据结构 (Payload) | 隐私保证与脱敏机制 |
| :--- | :--- | :--- | :--- |
| `calendar.free_busy` | `date_from`, `date_to` (最多14天) | `{ scope, date_from, date_to, busy: [{ start, end }] }` | 仅返回忙碌起止时间戳，彻底剔除事件标题、描述、与会人员与地点信息。 |
| `email.receipt` | `query` (如 `from:12306`), `date_from`, `date_to` | `{ scope, subject, sent_at, attachment_name, attachment_sha256, body_excerpt }` | 自动正则清洗手机号码 (`[PHONE]`) 与邮箱 (`[EMAIL]`)，正文摘要截断至 500 字。 |

---

## 3. 前端一键接入 (React 组件)

### 安装与引用

直接引入 `ConnectButton` 组件：

```tsx
import { ConnectButton } from "@mapr/connect-button";

export function FlightBookingPage() {
  const handleSuccess = ({ grant, signature, payload }) => {
    console.log("授权凭据 ID:", grant.grant_id);
    console.log("获取的忙碌区间:", payload.busy);
    // 向您的后端提交订单或匹配航班时间
  };

  return (
    <ConnectButton
      appId="flight-booking-pro"
      scope="calendar.free_busy"
      purpose="查询空闲时间以匹配最优商务出行航班"
      constraints={{ date_from: "2026-10-05", date_to: "2026-10-09" }}
      buttonText="使用 MAPR 授权日历忙闲"
      onSuccess={handleSuccess}
      onError={(err) => alert("授权失败: " + err.message)}
    />
  );
}
```

---

## 4. 原生 JavaScript / Web 标准接入

对于非 React 项目或第三方网站，可以通过标准 OAuth 风格重定向或弹窗接入：

### 4.1 构造授权重定向地址

```javascript
import { buildConnectUrl } from "./lib/connectClient";

const authUrl = buildConnectUrl("http://127.0.0.1:8787", {
  appId: "my-expense-app",
  scope: "email.receipt",
  purpose: "检索铁路报销车票凭证",
  redirectUri: "https://myapp.example.com/callback",
  constraints: { query: "from:12306", date_from: "2026-10-01", date_to: "2026-10-10" }
});

// 跳转或打开授权窗口
window.location.href = authUrl;
```

### 4.2 处理回调返回

在 `redirectUri` 页面中解析 URL Hash：

```javascript
import { parseConnectCallback } from "./lib/connectClient";

const result = parseConnectCallback(window.location.hash);
if (result.ok) {
  const { grant, signature, payload } = result;
  // 执行凭证核验与业务落地
} else {
  console.error("授权被拒绝:", result.error);
}
```

---

## 5. 密码学签名核验 (服务端与客户端通用)

第三方应用在消费收到的凭据前，必须核验其密码学签名，防止恶意篡改或假冒：

```typescript
import { verifyMessage } from "viem";

export function grantMessage(grant: any): string {
  return "MAPR1-GRANT " + JSON.stringify([
    grant.grant_id,
    grant.owner,
    grant.audience,
    grant.request_id,
    grant.scope,
    grant.constraints.date_from,
    grant.constraints.date_to,
    grant.payload_hash,
    grant.expires_at,
    grant.max_uses,
  ]);
}

export async function verifyReceivedGrant(grant, signature, expectedOwner, expectedAppId, payload) {
  // 1. 核验签发人与接收人
  if (grant.owner.toLowerCase() !== expectedOwner.toLowerCase()) return false;
  if (grant.audience.toLowerCase() !== expectedAppId.toLowerCase()) return false;

  // 2. 核验有效期 (单次凭证仅 10 分钟有效)
  if (Date.parse(grant.expires_at) <= Date.now()) return false;

  // 3. 核验数据哈希一致性
  const expectedHash = sha256(JSON.stringify(payload));
  if (grant.payload_hash !== expectedHash) return false;

  // 4. 验证以太坊个人签名 (EIP-191 / EIP-712)
  const isValid = await verifyMessage({
    address: grant.owner,
    message: grantMessage(grant),
    signature: signature,
  });

  return isValid;
}
```

---

## 6. 安全边界与威胁模型防护

1. **零账户权限暴露**：第三方应用无法接触用户的 Google OAuth Refresh Token 或邮箱明文密码。所有外部凭据均被隔离在本机 `0600` 权限目录中。
2. **防双重支付与重放**：`Grant` 凭据内含 `max_uses: 1` 和唯一 `grant_id`，且具备严格的 10 分钟时间戳约束。
3. **敏感信息自动清洗**：正则脱敏引擎会在生成 `payload` 前自动替换手机号与邮箱地址，杜绝附带敏感人员联系信息。
