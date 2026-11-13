# 接入层证书校验改严（方案 A）— 2026-11-12 验收记录

> 决策依据：`decisions.md` 2026-11-12 节；调查结论：`docs/verification/2026-10-17-接入层证书校验调查.md`。
> 主人于 2026-11-12 一次性批准全部剩余收尾事项，本项是其中之一。
> 范围：`trusted_runner.py`、`run_live_verification.py`、新增 `tests/test_tls_verification.py`。
> 未连接生产服务器、未使用任何生产凭据、未部署。

## 1. 问题与批准的方案

审计发现 4 处关闭 TLS 证书校验，其中 3 处传输 Bearer 令牌或账号口令：

| 位置 | 用途 | 凭据 |
|---|---|---|
| `trusted_runner.py:125` `_get_client()` | 主通道（dialogue-rpc、agent 注册） | Bearer 令牌 |
| `trusted_runner.py:604` | 登录换取令牌 | **账号口令原文** |
| `trusted_runner.py:622` | 房间名解析 | Bearer 令牌 |
| `run_live_verification.py:30` | 线上联调脚本登录 | **账号口令原文** |

不校验证书时，能插到网络中间的人可以冒充服务器直接取走口令/令牌。
线上证书由 Google Trust Services 签发、2026-12-18 到期，改严后不会连不上线上，
但会挡掉用户自签证书的内网服务器，且证书续期失败会直接断连。

批准的方案 A：**默认使用系统信任库校验，不提供"无条件不校验"开关**；
只对显式传入的一份 CA 证书或一张叶子证书指纹放开；配套证书到期提醒。

## 2. 实际改动

`trusted_runner.py`：

- 新增 `compute_verify(server_url, tls_ca_bundle, tls_cert_fingerprint)`：
  默认返回显式 `True`；`--tls-ca-bundle PATH` 返回该文件路径（httpx 用它作 CA 证书）；
  `--tls-cert-fingerprint HEX` 返回一个只信任该叶子证书的 `ssl.SSLContext`。
  两个参数互斥；CA 文件不存在时明确报错；指纹必须是 64 位 SHA-256（允许冒号分隔、大小写不敏感）。
- 指纹模式：先用 `ssl.get_server_certificate()` 只取回证书字节（不发 HTTP 请求、不携带凭据），
  换算 DER 的 SHA-256 与用户给的指纹比对，一致才 `load_verify_locations(cadata=pem)` 作为唯一信任锚；
  `verify_mode=CERT_REQUIRED` 保持不变。注释写明固定指纹取代自签服务器主机名信任这一设计取舍。
- 三处 `httpx.AsyncClient(verify=False, ...)` 全部改为使用同一份 `compute_verify()` 结果；
  `websockets.connect` 在自定义 CA / 指纹模式下也传入同一份 SSLContext（默认模式保持系统信任库）。
- `ws_ssl_context()` 把 CA 路径转换成 SSLContext 供 WebSocket 复用。
- 新增尽力而为的到期提醒：`days_until_expiry()` / `should_warn_cert_expiry()` /
  `peer_cert_not_after()` / `warn_if_cert_expiring_soon()`，https 目标证书剩余 ≤ 30 天时记录 WARNING，
  任何网络/解析异常都只 `debug` 记录、绝不阻断启动。启动时调用一次。
- `truncate_error_body()`：登录失败异常与日志中的响应体截断到 200 字符，
  避免被冒充的服务器把任意文本注入日志（调查报告第 7 节的后果）。
- 构造函数新增两个可选关键字参数，原有 `TrustedRunner(agent_name=..., server_url=...)` 调用方式不变；
  CLI 新增 `--tls-ca-bundle` / `--tls-cert-fingerprint`。

`run_live_verification.py`：

- `verify=False` 删除，改用默认系统信任库校验。
- **删除写入 git 的硬编码账号与口令字面量**（原文件把线上验证账号名、口令以及登录字段写死在源码里）：
  改为从环境变量 `MAPR_LIVE_USERNAME` / `MAPR_LIVE_PASSWORD` 读取，缺失时打印明确提示并退出；
  登录成功日志不再回显用户名。
- 登录失败只打印截断到 200 字符的响应预览。

`tests/test_tls_verification.py`（新增，25 项）：覆盖默认值、CA 路径、缺失路径拒绝、
两参数互斥、指纹正确/错误/格式错误、非 https 拒绝、WebSocket SSLContext 复用、
到期天数与告警阈值、网络异常不崩溃、http 回环不受影响、
两个源文件零 `verify=False`、无硬编码口令、凭据来自环境变量、登录错误体截断等。

## 3. 真实验证结果

```text
$ .venv/bin/python -m pytest tests/test_tls_verification.py -q
25 passed in 0.90s

$ .venv/bin/python -m pytest tests/ -q
66 passed in 24.36s

$ .venv/bin/python -m py_compile trusted_runner.py run_live_verification.py
(exit 0)

$ grep -c 'verify=False' trusted_runner.py run_live_verification.py
trusted_runner.py:0
run_live_verification.py:0
```

**变异验证（证明测试真的能抓住旧行为）**：临时把 `_get_client()` 改回 `verify=False` 后，
`tests/test_tls_verification.py::test_trusted_runner_source_has_zero_verify_false` 结果为
`1 failed`；恢复文件后同一用例 `1 passed`。最终源码已恢复，`verify=False` 计数为 0。

未做（如实记录）：没有用真实生产账号去连 `https://hub.wangdada8208.xyz` 跑一遍登录——
本环境没有生产凭据，且该操作会向生产发起带口令的外部请求，不在本次授权范围内。
证书校验本身由单元测试与 `httpx` 的默认值保证，不需要真实账号即可验证。

## 4. 剩余风险 / 使用方须知

1. 线上证书 **2026-12-18 到期**。改严后若 ACME 自动续期失败，接入层会直接拒绝连接
   （而不是像旧代码那样静默继续）。`warn_if_cert_expiring_soon()` 会在 ≤30 天时告警，
   但**仍需运维在到期前确证续期成功**。
2. 使用自签内网服务器的用户必须显式传 `--tls-ca-bundle <CA文件>` 或
   `--tls-cert-fingerprint <SHA256>`；不再存在"跳过校验"的后门。
3. 指纹模式按设计关闭了主机名检查（身份由那一张固定的叶子证书保证），
   仅适用于用户明确知道自己在固定哪台自签服务器的场景；公网地址请用默认模式或 CA bundle。
4. `run_live_verification.py` 现在要求运行前设置 `MAPR_LIVE_USERNAME` / `MAPR_LIVE_PASSWORD`；
   这两个值不得写入 git 或命令行参数。
