# 安全兼容说明：A2A 出站 URL 与 SSRF 防护策略

> 文档编号：SEC-2026-A2A-SSRF-01  
> 适用模块：`backend/app/a2a/discovery.py`、`backend/app/a2a/url_policy.py`  
> 修复等级：P0 核心安全硬化  
> 日期：2026-10-10

---

## 1. 风险背景与审查结论

在原有的 `AgentDiscovery.register` 与 `AgentDiscovery.health_check` 实现中，系统直接对客户端传入的 `card_url` 或数据库现存 URL 发起 HTTP GET 请求：

1. **内网与元数据探测**：未对 URL Scheme、Host、IP 网段进行校验，攻击者可通过注册 `http://127.0.0.1:6379`、`http://169.254.169.254/latest/meta-data/`、`http://10.0.0.1` 或 `file:///etc/passwd` 探测本地端口、内网资产及云厂商实例元数据。
2. **DNS 重绑定 (TOCTOU) 隐患**：若仅在验证阶段做一次 DNS 查询，随后以原始 Host 发起请求，攻击者可通过配置 TTL=0 的双 A 记录或重绑定 DNS 服务器，在出站连接时重绑定至内网或环回地址。
3. **环境代理劫持与重定向绕过**：默认使用系统代理环境变量（`HTTP_PROXY` / `HTTPS_PROXY`）可能导致流量外泄或被代理拦截；未禁用 HTTP 30x 重定向可能被利用跳转至私网地址。
4. **异常日志凭证泄露**：URL 中若携带 `user:pass@` 凭证，在抛出异常或记录日志时存在密码明文泄露风险。

---

## 2. 安全硬化架构与防御策略

为彻底消除上述风险，系统在 `backend/app/a2a/url_policy.py` 中实现了严格的出站前安全验证策略，并在 `discovery.py` 中执行全生命周期校验：

### 2.1 出站前强校验（Validation Before Outbound）
所有传入的 `card_url` 在发起任何套接字连接或 HTTP 请求前，必须通过 `validate_agent_card_url` 验证：
- **Scheme 白名单**：严格限制仅允许 `http` 与 `https`。阻断 `file://`、`ftp://`、`gopher://`、`data:` 等非 HTTP 协议。
- **凭据剥离与脱敏**：禁止 URL Authority 中包含任何 Userinfo（`username`、`password` 或 `@`）。所有异常信息均经过脱敏，绝不回显任何密码或密钥。
- **端口合法性**：端口号必须为 1~65535 的合法整数，默认 HTTP 为 80，HTTPS 为 443。
- **IP 范围全面封锁**：
  - 环回地址（`127.0.0.0/8`、`::1`）
  - 私有网络（RFC 1918：`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`；RFC 4193：`fc00::/7`）
  - 链路本地与云元数据（`169.254.0.0/16`、`169.254.169.254`、`169.254.169.253`、`100.100.100.200`、`fd00:ec2::254`、`fe80::/10`）
  - 组播地址（`224.0.0.0/4`、`ff00::/8`）
  - 保留网段与未指定地址（`0.0.0.0/8`、`240.0.0.0/4`、`::`）
  - 运营商级 NAT（`100.64.0.0/10`）与基准测试/测试保留网段（`198.18.0.0/15`、`192.0.2.0/24` 等）
- **IPv4 进制混淆解析**：采用底层 `socket.inet_aton` 规范化解析十进制长整数（Dword 如 `2130706433`）、八进制（如 `0177.0.0.1`）、十六进制（如 `0x7f000001`）、短缩分段（如 `127.1`）以及前导零格式。
- **IPv6 映射 IPv4**：提取 `::ffff:x.x.x.x` 底层 IPv4 地址，递归执行全套 IPv4 范围封锁规则。
- **内部域名与元数据主机名阻断**：直接阻断 `metadata.google.internal`、`instance-data`、`metadata.azure.com` 以及 `.local`、`.internal`、`.lan`、`.corp`、`.home`、`.arpa` 等内部顶级域名。

### 2.2 防范 DNS 重绑定（TOCTOU Mitigation）
- **DNS 结果全量核验**：通过 `socket.getaddrinfo` 解析主机名的所有 A/AAAA 记录。如果返回的 IP 列表中存在**任何一个**私网/保留/元数据 IP（混合解析攻击），立即整机 Fail-Closed 拒绝。
- **目标 IP 固定（IP Pinning）**：出站请求直接将连接目标固定为已通过安全审查的特定 IP（`pinned_ip`）。
- **Host 头部与 TLS SNI 保留**：
  - HTTP 请求：向 `pinned_ip` 发起请求，并在 HTTP 头部保留原始域名：`Host: <original_host>`。注意：方括号 `[...]` 严格仅对 IPv6 字面量地址使用（如 `Host: [::1]:8000`）；若域名通过 DNS AAAA 解析为 IPv6，其 `Host` 头部保持标准域名格式（`Host: agent.example.com`），绝不添加非法方括号。
  - HTTPS 请求：向 `pinned_ip` 发起请求，保留 `Host` 头部的同时，通过 httpx extensions 显式指定 `sni_hostname: <original_host>`。TLS 握手时的 SNI 扩展与证书域名匹配（SAN）均以原始主机名为准，确保证书验证严格有效，同时 TCP 连接无法被二次 DNS 解析重定向。

### 2.3 受控传输策略
- **禁用环境代理**：客户端显式设置 `trust_env=False`，防止通过系统环境变量（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`）被引流或劫持。
- **禁止自动重定向**：显式设置 `follow_redirects=False`，防止目标服务返回 HTTP 301/302 重定向至内网或元数据地址。
- **超时收敛**：出站请求超时时间严格限制在 5 秒以内（探测健康检查为 3 秒）。长耗时 POST/JSON-RPC 任务通过 `safe_agent_http_request` 显式隔离连接超时（`connect_timeout <= 5.0s`）与读取超时（`read_timeout <= 60.0s`）。

### 2.4 数据库历史脏数据防护
在 `AgentDiscovery.health_check()` 中，对数据库既有存量记录执行同样的校验逻辑：
- 在发包前重新通过 `validate_agent_card_url` 评估。
- 若既有记录包含恶意或不合法 URL，**绝对不发送出站网络请求**。
- 将该记录标记为 `is_active = False`（安全置为 offline），不修改数据库结构（Schema 零改动）。

### 2.5 跨模块通用出站助手：`safe_agent_http_request`
为消除 REST Agent Card 注册任意 URL 后由 A2A 出站发送或 `A2AClient` 直接 POST 产生的二次 SSRF 风险，`url_policy` 导出了统一的安全 HTTP 助手：

```python
async def safe_agent_http_request(
    base_url: str,
    suffix: str = "",
    *,
    method: str = "GET",
    json_body: dict | list | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 5.0,
    connect_timeout: float | None = None,
    read_timeout: float | None = None,
) -> httpx.Response:
    ...
```

**API 契约与调用规范**：
1. **调用方无需自行解析或绑定 IP**：只需传入 `base_url`（如 `https://agent.example.com` 或 `https://agent.example.com/a2a`）和可选的 `suffix`（如 `/rpc` 或 `/.well-known/agent-card.json`）。
2. **每次调用强制复验**：内部每次执行都会调用 `validate_agent_card_url(base_url)` 重新解析并执行全量 A/AAAA 检查与 IP 固定，防止 TOCTOU 与 DNS 动态重绑定。
3. **支持标准 JSON-RPC POST**：当 `method="POST"` 且提供 `json_body` 时，自动补充 `Content-Type: application/json` 并序列化 body，请求直连至安全固定目标 IP。
4. **长耗时超时防御**：针对任务分发等长耗时 RPC 任务，支持将 `read_timeout` 放宽至最高 60.0s，但握手建连超时 `connect_timeout` 始终强制限制在 `<= 5.0s`，杜绝内网慢速探测与挂起攻击。
5. **安全 Fail-Closed**：若传入任何恶意或未授权地址（包括未在白名单的 localhost、内网 RFC 1918、云元数据等），立即抛出 `SSRFValidationError`（继承自 `ValueError`），**绝对不产生任何出站套接字或网络流量**。

---

## 3. 本机 Agents 行为变更与静态白名单配置

### 3.1 行为变更说明
在旧版本中，注册 `http://localhost:9999` 或 `http://127.0.0.1:8000` 会直接发起本地探测。修复后：
- **默认行为**：所有未显式授权的 `localhost`、`127.0.0.1`、`[::1]` 均被视为 SSRF 攻击，Fail-Closed 直接拒绝。
- 此项变更可能影响原本依赖随意探测本机未受控端口的旧脚本或测试。

### 3.2 服务端显式静态白名单（Server-side Static Allowlist）
为了在不牺牲安全性的前提下兼容 A2A 本机 Agents 调试与本地适配器场景，系统提供了严格的服务端静态白名单机制：

1. **配置环境变量**（直接由 `url_policy` 模块读取，不改动公共配置模块）：
   ```bash
   # 1. 显式开启本机白名单支持（默认禁用）
   export MAPR_A2A_ALLOW_LOCALHOST=true

   # 2. 精确指定管理员允许的本地监听地址与端口（逗号分隔）
   export MAPR_A2A_LOCAL_ALLOWLIST="http://localhost:9999,http://127.0.0.1:9999,http://localhost:8000"
   ```

2. **白名单不可被滥用原则（Invariant Rules）**：
   - 客户端无法自行决定或通过请求参数控制白名单。
   - 即使管理员或测试在 `MAPR_A2A_LOCAL_ALLOWLIST` 中误配置了云元数据地址（如 `169.254.169.254`）或私网网段（如 `10.0.0.1`），策略引擎在解析白名单时会**自动将其识别并剔除**。
   - 白名单仅放行严格属于本机 Loopback 的指定端口。
   - **协议 Scheme 严格一致**：若白名单条目显式声明了 Scheme（如 `https://localhost:9999`），则发起请求的 Scheme 必须严格一致，禁止使用 `http://localhost:9999` 跨协议降级利用。

---

## 4. 剩余边界与安全假设

1. **首查 IP 绑定策略**：防御 DNS 重绑定的核心机制为出站连接直接使用首查已验证的公网 IP，不依赖系统 Resolver 的二次查询。
2. **公共域名解析失败**：当上游公共 DNS 故障或解析超时，系统采取 Fail-Closed 策略，直接拒绝注册。
3. **外部反向代理边界**：若公网合法 IP 背后的远端反向代理服务器自身存在二次代理内部网络的能力，该行为属于远端系统的独立边界，MAPR Hub 已确保自身不成为内网跳板。
