# Cloudflare Auth Relay Worker（适用于 `wangdada8208.xyz`）

本目录提供一个零外部依赖的 Cloudflare Worker，用于解决两件事：

1. **`GET /google-certs`**：通过 Cloudflare 边缘节点缓存代理 Google OAuth JWKS 公钥，让北京生产服务器无需代理即可毫秒级完成 Google `id_token` 验签。
2. **`POST /send-email`**：通过统一的中继接口发送注册/登录 6 位验证码邮件。

> **关于 Cloudflare 免费版的真实边界**：
> Cloudflare 免费版的 **Email Routing** 只支持把收到的邮件转发到你**自己已验证的收件箱**；若要向任意外部注册用户发送事务邮件（验证码），Cloudflare 原生 `send_email` 绑定需要 **Workers Paid（$5/月）**。
> 如果你想 **0 元成本** 起步，可以把 Worker 保留在 Cloudflare 免费版，搭配 **Resend 免费额度（每月 3,000 封、无需信用卡）**，一键在 Cloudflare 授权添加 DNS 记录即可发信。

---

## 三步完成部署（全程在浏览器或本机 CLI 操作）

### 第一步：部署 Worker 并绑定子域名 `auth-relay.wangdada8208.xyz`

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → 创建 Worker（名称如 `mapr-auth-relay`），将 `worker.js` 全部内容粘贴进去并部署。
   - 若使用 Wrangler CLI：
     ```bash
     cd scripts/cloudflare-auth-worker
     npx wrangler deploy
     ```
2. 进入该 Worker 的 **Settings → Domains & Routes → Add → Custom Domain**，填入：
   `auth-relay.wangdada8208.xyz`
   （Cloudflare 会自动为你生成 DNS 记录与 SSL 证书，不影响现有的 `hub.wangdada8208.xyz`）。
3. 在 Worker 的 **Settings → Variables and Secrets** 添加加密 Secret：
   - `RELAY_SECRET`：用 `openssl rand -hex 32` 生成一串 64 位随机密钥（千万不要写入 Git）。

### 第二步：配置发信能力（二选一）

- **方案 A（推荐，0 元起步）：免费版 Worker + Resend 免费层**
  1. 注册 [Resend](https://resend.com/) → **Domains → Add Domain**，填写发信子域名（如 `mail.wangdada8208.xyz`；本部署实际复用已验证的 `notify.wangdada8208.xyz`）。
  2. 点击 **Sign in with Cloudflare** 一键自动把 SPF / DKIM / MX 记录写入你现有的 Cloudflare DNS。
  3. 在 Resend 创建一个 API Key（`re_...`，建议仅授予 Sending access 并限定到该域名）。
  4. 两种接法任选其一：
     - 经由本 Worker 转发：在 Worker Secrets 填入 `RESEND_API_KEY`，后端配置 `MAPR_EMAIL_PROVIDER="cloudflare_worker"`（**本部署采用此方式**）。
     - 后端直连 Resend（最简单，不经过 Worker 转发发信）：后端直接配置 `MAPR_EMAIL_PROVIDER="resend"` 和 `MAPR_EMAIL_API_KEY="re_..."`（此时 Worker 仅负责 `/google-certs`）。

- **方案 B（Cloudflare Paid 套餐）：原生 Cloudflare Email Service**
  1. 若账号已开通 Workers Paid 及 Cloudflare Email Service，取消 `wrangler.jsonc` 中 `send_email` 注释或在 Dashboard 添加 `EMAIL` 绑定。
  2. 无需配置 `RESEND_API_KEY`，Worker 会自动优先调用 `env.EMAIL.send(...)`。

### 第三步：配置 Google OAuth 与服务器 `.env`

1. 打开 [Google Cloud Console → API 和服务 → 凭据](https://console.cloud.google.com/apis/credentials)：
   - 创建 **OAuth 2.0 客户端 ID**（应用类型：**Web 应用**）。
   - **已获授权的 JavaScript 来源**填入：`https://hub.wangdada8208.xyz`（本地联调可加 `http://localhost:5173`）。
   - 不需要申请日历/Gmail 敏感权限（仅需基础 `openid email profile`）。
   - 复制得到的 **客户端 ID**（形如 `xxxx.apps.googleusercontent.com`）。
2. 在部署机 `/opt/multi-agent-project-room/.env` 补齐以下环境变量后重启生效：
   ```bash
   MAPR_EMAIL_PROVIDER="cloudflare_worker"
   MAPR_EMAIL_FROM_ADDRESS="noreply@notify.wangdada8208.xyz"
   MAPR_EMAIL_FROM_NAME="Parlor"
   MAPR_EMAIL_WORKER_URL="https://auth-relay.wangdada8208.xyz/send-email"
   MAPR_EMAIL_WORKER_SECRET="<你刚生成的 64 位 RELAY_SECRET>"

   MAPR_GOOGLE_CLIENT_ID="<你的 Google Client ID>"
   MAPR_GOOGLE_JWKS_URL="https://auth-relay.wangdada8208.xyz/google-certs"
   ```
3. 验证 Worker 是否就绪：
   ```bash
   curl -sS https://auth-relay.wangdada8208.xyz/health
   curl -sS https://auth-relay.wangdada8208.xyz/google-certs | head -c 200
   ```
