# 安全配置说明：可信反向代理与真实客户端 IP 提取（面向 A 组）

> 文档编号：SEC-2026-PROXY-TRUST-01
> 适用模块：`backend/app/config.py`（`Settings.trusted_proxies`）、`backend/app/auth/rate_limit.py`（`_is_trusted_proxy` / `_client_ip`）
> 关联组：D 组（生产配置与就绪检查）评估并提出；A 组（网关与部署）负责在生产环境落地
> 日期：2026-10-13
> 状态：已完成（已验证）——配置接口与解析逻辑已随 D 组分支交付；生产环境变量取值需 A 组确认后写入服务器 `.env`

---

## 1. 为什么需要这个配置

系统部署在 Nginx 反向代理之后。后端看到的 TCP 连接来源永远是 Nginx 容器的地址，
而不是真实访问者的地址。为了让「登录失败限流」和「审计日志」拿到真实的客户端 IP，
Nginx 会在请求头里写入 `X-Forwarded-For`。

问题在于：`X-Forwarded-For` 是**客户端可以自己伪造的请求头**。如果后端无条件相信它，
攻击者只要在请求里塞一个假的 `X-Forwarded-For: 1.2.3.4`，就能：

1. **绕过限流**：每次请求伪造不同的 IP，限流计数器永远不会命中同一个键。
2. **污染审计**：日志里记录的是伪造的 IP，事后无法追溯真实来源。
3. **牵连他人**：把失败次数嫁祸到某个无辜 IP 上，导致该 IP 被锁定。

因此后端采取「**只信任已知代理**」的策略：只有当 TCP 直连来源落在可信代理列表里时，
才采信 `X-Forwarded-For`；否则一律使用 TCP 直连地址。

---

## 2. 配置项：`MAPR_TRUSTED_PROXIES`

### 2.1 位置与默认值

定义在 `backend/app/config.py` 的 `Settings.trusted_proxies`：

```python
trusted_proxies: list[str] = ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
```

默认值覆盖：本机环回（`127.0.0.1`、`::1`）以及 RFC 1918 私有网段
（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）。这些正是 Docker 网桥与内网代理会使用的地址段。

### 2.2 环境变量取值格式

支持两种写法，二选一即可：

```bash
# 写法一：逗号分隔（推荐，简单直观）
MAPR_TRUSTED_PROXIES="127.0.0.1, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16"

# 写法二：JSON 数组（与 CORS 配置风格一致）
MAPR_TRUSTED_PROXIES='["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]'
```

- 每个元素可以是单个 IP（`10.0.0.5`）或 CIDR 网段（`172.16.0.0/12`）。
- 支持 IPv4 与 IPv6。
- 空白字符会被自动去除；空字符串解析为空列表。
- `.env.example` 中已提供注释形式的示例，默认注释掉，使用代码默认值。

### 2.3 解析逻辑

`parse_trusted_proxies`（`field_validator(mode="before")`）在配置加载时完成解析：
字符串先去除首尾空白；若形如 `[...]` 则按 JSON 解析；否则按逗号切分。
解析失败时安全回退为按逗号切分，绝不抛异常导致进程无法启动。

---

## 3. 匹配与提取逻辑

`backend/app/auth/rate_limit.py` 中：

- **`_is_trusted_proxy(client_host)`**：判断 TCP 直连地址是否可信。
  精确匹配字符串，或（对 CIDR）用 `ipaddress.ip_network(..., strict=False)` 做网段包含判断。
  非法地址一律返回 `False`（安全默认拒绝）。
- **`_client_ip(request)`**：
  - 若直连地址**不在**可信列表 → 直接返回直连地址，**忽略** `X-Forwarded-For`。
  - 若直连地址**在**可信列表 → 取 `X-Forwarded-For` 中**最左侧**（即最初的客户端）IP；
    头部为空则回退到直连地址。

`X-Forwarded-For` 的语义是「客户端, 代理1, 代理2, …」，最左侧才是原始客户端。
取最左侧是标准做法；安全性由「只信任已知代理」这一前提保证。

---

## 4. A 组需要在生产环境做的事

### 4.1 确认代理链

当前生产拓扑：**Cloudflare → 北京服务器 → Nginx 容器 → 后端容器**。

关键问题：后端容器看到的 TCP 直连地址是 **Nginx 容器的地址**，属于 Docker 网桥网段
（通常是 `172.16.0.0/12` 或 `192.168.0.0/16`）。默认值已覆盖，**通常无需改动**。

### 4.2 核对服务器 `.env`

1. 若服务器 `.env` 中**没有** `MAPR_TRUSTED_PROXIES`，则使用代码默认值（已覆盖 Docker 网桥），**无需操作**。
2. 若服务器 `docker-compose.yml` 使用了**自定义 Docker 网络**且网段不在 RFC 1918 范围内
   （例如管理员手动指定了 `100.64.0.0/10` 这类 CGNAT 网段），必须在 `.env` 中显式追加该网段：

   ```bash
   MAPR_TRUSTED_PROXIES="127.0.0.1, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, <自定义网段>"
   ```

3. **绝不要把公网地址段（如 `0.0.0.0/0`）写进可信列表**——那等于无条件信任所有伪造头，
   会让整个限流机制失效。

### 4.3 验证步骤（在服务器上执行，只读）

```bash
# 1. 查看后端容器实际看到的直连来源网段
docker compose exec -T backend python3 -c "import socket; print(socket.gethostbyname('nginx'))"

# 2. 确认配置已生效（打印解析后的可信列表）
docker compose exec -T backend python3 -c "from app.config import get_settings; print(get_settings().trusted_proxies)"

# 3. 确认限流拿到真实客户端 IP（从外网发起一次失败登录，观察日志中的 IP）
```

第 2 步输出的列表必须包含第 1 步得到的网段。若不含，按 4.2 第 2 点补充。

### 4.4 Nginx 侧现状（已确认，无需改动）

`frontend/nginx.conf` 已正确设置：

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

`$proxy_add_x_forwarded_for` 会**追加**而不是覆盖，行为正确。
后端读取最左侧 IP，与 Nginx 的追加语义一致。

**注意**：Cloudflare 位于最外层。若希望拿到访客真实 IP 而非 Cloudflare 边缘节点 IP，
需在 Nginx 层引入 Cloudflare 的 `CF-Connecting-IP` 或启用 `ngx_http_realip_module`
并加载 Cloudflare IP 段。这属于 A 组可选的加固项，**不影响**后端本次的可信代理防护——
后端防护的目标是阻止伪造头绕过限流，无论上游是否做了 realip 还原都成立。

---

## 5. 安全边界与已知限制

| 项目 | 说明 |
|---|---|
| 信任前提 | 只有 TCP 直连来源在可信列表内，才采信 `X-Forwarded-For`。列表外的来源一律忽略该头。 |
| 安全默认 | 列表为空或地址非法时，回退为「不信任任何转发头」，只使用直连地址。 |
| 最左取值 | 采信时取 `X-Forwarded-For` 最左侧 IP，符合 RFC 7239 惯例。 |
| 不覆盖场景 | 若部署链路中**多级**代理（如 CDN + 负载均衡 + Nginx），且中间节点会重写最左侧 IP，需逐级核对；本方案假设所有中间代理都追加而非覆盖。 |
| 本机开发 | 开发环境环回地址 `127.0.0.1` 已在默认列表，本地直连测试正常。 |

---

## 6. 变更记录

- 2026-10-13（D 组）：新增 `trusted_proxies` 字段与 `parse_trusted_proxies` 解析器；
  在 `_is_trusted_proxy` 中引入 CIDR 网段判定；补充本文档供 A 组落地。
  相关测试：`backend/tests/test_audit_production_safety_d.py`
  （`test_trusted_proxies_*` 共 4 项）与 `backend/tests/test_audit_hardening_round2.py`
  （`test_trusted_proxy_cidr_parsing`、`test_client_ip_extraction_with_forwarded_for`）。
