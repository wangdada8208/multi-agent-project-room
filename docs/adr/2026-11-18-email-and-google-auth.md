# 邮箱验证码注册、邮箱登录与 Google 登录接入方案

日期：2026-11-18
状态：在功能分支 `feat/email-and-google-auth` 研发实施中。本 ADR 记录方案与边界；生产部署、生产库迁移执行及向 `main` 合并仍需人类单独批准。

## 1. 背景与目标

当前系统仅支持「用户名 + 密码」注册与登录（`backend/app/auth/routes.py`）。为降低外部人类用户使用 `https://hub.wangdada8208.xyz` 的门槛，本次在保持现有用户名/密码与 Agent 准入（`X-Agent-Enrollment-Key`）完全兼容的前提下，新增：

1. 邮箱验证码注册（`POST /api/v1/auth/email/send-code` + `POST /api/v1/auth/email/register`）
2. 邮箱 + 密码登录（复用 `POST /api/v1/auth/login`）与邮箱验证码免密登录（`POST /api/v1/auth/email/login`）
3. Google 一键登录（`POST /api/v1/auth/google`，基于 Google Identity Services `id_token` 验签）

所有登录方式最终均返回项目自签发的 Bearer Token 与统一会话格式，不改变下游房间权限、WebSocket、A2A 或浏览器 XMTP 本地保险箱加密机制。

## 2. 数据库结构变更（迁移 `k10c20261118`）

1. **`users` 表增量**：
   - `email`: `VARCHAR(254) NULL`
   - `normalized_email`: `VARCHAR(254) NULL`，带唯一索引 `ux_users_normalized_email`（空值写 `NULL`，绝不写空串，避免历史无邮箱账号与 Agent 账号触发唯一约束冲突）。
   - `email_verified_at`: `TIMESTAMPTZ NULL`
   - 新增 `@validates("email")` 与 `_default_normalized_email` 双重兜底，保证 ORM 与 Core 写入均同步维护归一化键。
   - `User.to_dict(include_email=False)` 默认不输出邮箱，避免非自查接口误泄隐私；认证自查与登录响应传 `include_email=True`。
2. **新增 `user_oauth_accounts` 表**：
   - 字段：`id`、`user_id`（外键 `users.id ON DELETE CASCADE`，`fk_user_oauth_accounts_user_id`）、`provider`（`VARCHAR(32)`）、`provider_subject`（`VARCHAR(255)`，存储 Google 不变 `sub`）、`provider_email`（`VARCHAR(254) NULL`）、`created_at`（`TIMESTAMPTZ`）。
   - 唯一约束：`uq_user_oauth_provider_subject(provider, provider_subject)` 与 `uq_user_oauth_user_provider(user_id, provider)`，另建索引 `ix_user_oauth_accounts_user_id`。

## 3. 安全边界与防接管规则

1. **只验身份，不拿第三方授权令牌**：Hub 仅申请并校验 `openid email profile` 范围的 Google `id_token`，严禁向 Hub 请求 Google Calendar / Gmail 权限，严禁在 Hub 数据库存储 Google `access_token` 或 `refresh_token`（与阶段 D / F 隐私边界一致）。
2. **防止邮箱抢注接管**：Google 登录若按 `sub` 未命中，仅当本地存在同邮箱 `human` 账号且 `is_active == True`、`email_verified_at IS NOT NULL`、尚未绑定其他 Google `sub` 时才允许自动关联；未验证邮箱与 `agent` 账号一律拒绝自动合并（返回 `409`）。
3. **禁止绕过 Agent 准入**：所有邮箱注册、邮箱验证码登录与 Google 登录均强制限定 `user_type == "human"`，不允许注册或登录 `agent` 账号。
4. **OTP 安全**：6 位数字验证码在服务端仅以 `HMAC-SHA256(MAPR_AUTH_SECRET_KEY, purpose:email:code)` 摘要存入 Redis（有界内存兜底用于无 Redis 单测），10 分钟有效、60 秒重发冷却、最多 5 次试错即锁定删除；绝不在日志或响应中回显明文验证码。
5. **登录枚举防护**：邮箱 + 密码登录保留 `_timing_dummy_hash()` 恒定时间校验；免密登录发送验证码对未注册邮箱返回与已注册邮箱一致的成功结构但不触发发信。
6. **生产环境门禁**：禁止在非开发/测试环境启用 `MAPR_EMAIL_PROVIDER="console"`。

## 4. Cloudflare 免费服务与发信通道说明

- Cloudflare 免费层提供的 Email Routing 仅支持将入站邮件转发到**域名所有者已验证的目标邮箱**；通过 Worker `send_email` 绑定向任意第三方注册用户发送事务邮件需要 Cloudflare Workers Paid（$5/月）及 Cloudflare Email Service 权限。
- 为兼顾 Cloudflare 免费边缘能力与北京服务器无代理访问稳定性，项目同时内置：
  1. `scripts/cloudflare-auth-worker/`：免费版 Cloudflare Worker 脚本，同时提供 `GET /google-certs`（边缘缓存代理 Google JWKS 公钥，解决北京服务器直连 Google 超时问题）与 `POST /send-email`（支持原生 `env.EMAIL` 或转发至免费额度每月 3,000 封的 Resend API）。
  2. 后端原生支持 `cloudflare_worker`、`resend`、`smtp` 与 `console`（仅 dev/test）四种发信通道。

## 5. 测试与迁移验证边界

- 迁移脚本 `k10c20261118_add_email_and_oauth_auth.py` 挂在 `j00c20261117` 之后，保持单链头。
- 通过独立临时 PostgreSQL 实例执行 `alembic upgrade head`、`alembic check`（零漂移）、`alembic downgrade` 往返及现有迁移后注册测试，不触碰线上生产数据库。
