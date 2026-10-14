# 验证记录：生产配置、数据库迁移、就绪检查与发布流程安全（D 组）

> 文档编号：VER-2026-AUDIT-D-01
> 分支：`fix/audit-production-safety`
> 基线：`60b0f05c83027838ce404caf6000870daeeebdd6`
> 日期：2026-10-13
> 状态：已完成（已验证）

---

## 1. 本次修复范围

MAPR 第三次安全与运维审计 D 组：生产环境配置、数据库迁移、就绪检查与发布流程安全。

| 编号 | 任务 | 状态 |
|---|---|---|
| 1 | 生产启动无法意外进入弱密钥开发模式 | 已完成（已验证） |
| 2 | 默认占位符与不安全密钥被正确拒绝 | 已完成（已验证） |
| 3 | `/ready` 检查数据库连接、迁移版本与必要 Schema；保留 `/health` 为轻量存活探针 | 已完成（已验证） |
| 4 | 独立临时 PostgreSQL 库验证 `g70c20261012` 升级/回滚/再升级 | 已完成（已验证） |
| 5 | 修复 main 分支自动触发生产部署的风险 | 已完成（已验证） |
| 6 | 评估可信代理配置接口并向 A 组说明 | 已完成（已验证） |

**严格遵守的边界**：全程只操作独立临时测试数据库，未接触北京生产数据库；未执行任何真实部署；未推送 main。

---

## 2. 变更文件清单

| 文件 | 变更 |
|---|---|
| `backend/app/config.py` | 新增 `INSECURE_SECRET_BLACKLIST`；生产密钥校验（非空、无首尾空白、≥32 字符、非黑名单、熵 ≥4）；新增 `trusted_proxies` 字段与解析器 |
| `backend/app/core/database.py` | 新增 `check_database_readiness`：校验连通性（`SELECT 1`）、迁移版本（`g70c20261012`）、关键表（`users`） |
| `backend/app/gateway/routes.py` | `/health` 保持轻量存活探针；`/ready` 接入 `check_database_readiness`，降级返回 HTTP 503 |
| `docker-compose.yml` | backend 健康检查指向 `/ready`；frontend `depends_on: backend: condition: service_healthy` |
| `scripts/deploy.sh` | 部署前密钥预检（在停止容器与执行迁移之前） |
| `.env.example` | 移除不安全占位符，补充 `openssl rand -hex 32` 生成说明与 `MAPR_TRUSTED_PROXIES` 示例 |
| `.github/workflows/deploy.yml` | 部署任务 `if` 收紧为仅 `workflow_dispatch && inputs.deploy` |
| `backend/tests/test_audit_production_safety_d.py` | 新增 30 项 D 组回归测试 |
| `backend/tests/test_audit_hardening_round2.py` | 更新低熵测试夹具（`"a"*32` → 高熵 32 位串） |
| `tests/test_deploy_script.py` | 就绪探针断言由 `/health` 改为 `/ready` |
| `docs/安全配置说明-可信反向代理与客户端IP.md` | 新增面向 A 组的可信代理配置说明 |

---

## 3. 数据库迁移验证（任务 4）

### 3.1 环境

- 独立 PostgreSQL 17 临时实例，仅本机可用：Unix socket `/tmp`，端口 `54329`。
- 独立数据库：`agent_room_migration_test`。
- **未连接、未读取、未修改任何生产数据库。**

### 3.2 验证结果：升级 → 回滚 → 再升级

```
=== Step 1: 升级到 f60c20261011（g70c20261012 的前一个版本）===
  Alembic 版本: f60c20261011
  users 表存在 is_active 列: False

=== Step 2: 升级到 g70c20261012 ===
  Alembic 版本: g70c20261012
  users 表存在 is_active 列: True
  is_active 列详情: type=boolean, default=true, nullable=NO

=== Step 3: 回滚到 f60c20261011 ===
  Alembic 版本: f60c20261011
  users 表存在 is_active 列: False

=== Step 4: 再升级到 g70c20261012 ===
  Alembic 版本: g70c20261012
  users 表存在 is_active 列: True
  is_active 列详情: type=boolean, default=true, nullable=NO
```

### 3.3 结论

迁移 `g70c20261012` 可**双向**、**幂等**地反复执行：`is_active` 列被干净地添加、删除、再添加，
无报错、无数据不一致。升级与回滚路径均验证通过。

### 3.4 就绪探针连接真实 PostgreSQL 验证

用 `check_database_readiness` 连接上述真实 PostgreSQL 17 库，返回：

```python
{'status': 'ready', 'revision': 'g70c20261012', 'reason': None}
```

即：连通性正常、迁移版本与期望头指针一致、`users` 表存在 → 判定为就绪。

---

## 4. 就绪检查与存活探针验证（任务 3）

### 4.1 设计

| 探针 | 用途 | 行为 |
|---|---|---|
| `/health` | 存活（liveness） | 纯内存返回 HTTP 200，**不查数据库**。避免数据库维护或连接抖动时编排器误杀容器。 |
| `/ready` | 就绪（readiness） | 校验数据库连通性、迁移版本（`g70c20261012`）、关键表（`users`）。任一不满足返回 HTTP 503。 |

### 4.2 自动化测试覆盖

`backend/tests/test_audit_production_safety_d.py`：

- `test_health_liveness_probe_is_lightweight_in_memory`：`/health` 返回 200 且响应体**不含** `database` 字段（证明未查库）。
- `test_readiness_probe_success`：`/ready` 返回 200，`revision == g70c20261012`。
- `test_readiness_probe_database_unavailable_returns_503`：数据库超时 → 503，`database == "unavailable"`。
- `test_check_database_readiness_revision_mismatch`：版本不符 → `not_ready`，原因含当前值与期望值。
- `test_check_database_readiness_missing_critical_table`：关键表缺失 → `not_ready`。

### 4.3 全栈一致性

`/ready` 端点已在四处对齐：`docker-compose.yml` 健康检查、`scripts/deploy.sh` 轮询、
`backend/app/gateway/routes.py` 实现、`tests/test_deploy_script.py` 断言。

---

## 5. 发布流程安全验证（任务 5）

### 5.1 变更

`.github/workflows/deploy.yml` 的 `deploy` 任务触发条件：

```yaml
# 变更前（危险：push 到 main 即自动部署生产）
if: github.ref == 'refs/heads/main' || (github.event_name == 'workflow_dispatch' && inputs.deploy)

# 变更后（必须人工明确批准）
if: github.event_name == 'workflow_dispatch' && inputs.deploy
```

### 5.2 效果

- 向 `main` 推送代码**不再**自动部署到生产。
- 部署必须由人工在 GitHub Actions 界面手动触发 `workflow_dispatch`，并勾选 `deploy = true`。
- `inputs.deploy` 默认为 `false`，即使误触 `workflow_dispatch` 也不会部署。

### 5.3 自动化测试覆盖

`test_deploy_workflow_requires_manual_approval`：断言 `deploy` 任务的 `if` 条件包含
`workflow_dispatch` 与 `inputs.deploy`，且**不含** `refs/heads/main`。

---

## 6. 部署脚本预检验证（任务 1 & 2）

`scripts/deploy.sh` 的密钥预检在 `PYCONFIG` 段执行，**位于**停止运行中容器（`stop backend`）
与执行迁移（`alembic upgrade head`）**之前**。若 `.env` 密钥不合格，脚本在动任何容器与数据前即中止。

预检规则（与 `config.py` 一致）：

1. 非空，且无首尾空白。
2. 长度 ≥ 32。
3. 不匹配已知占位符黑名单（13 项）。
4. 字符熵 ≥ 4 个不同字符。

`SYNTHETIC=1` 或环境变量 `SYNTHETIC=1` 时跳过预检（仅供测试桩使用）。

### 6.1 自动化测试覆盖

`tests/test_deploy_script.py` 使用假工具桩（fake docker/curl/sleep），不接触真实服务器与数据库，
覆盖 5 种场景：正常、迁移失败、健康检查失败、Docker 无权限、独立 compose 命令。
全部通过。

---

## 7. 测试执行结果

### 7.1 D 组新增测试

```
backend/tests/test_audit_production_safety_d.py .......... 30 passed
```

### 7.2 相关既有测试（含回归）

```
backend/tests/test_audit_hardening_round2.py
tests/test_deploy_script.py
backend/tests/test_health.py
backend/tests/test_auth.py
backend/tests/test_audit_production_safety_d.py   ......... 47 passed
```

### 7.3 全量后端套件（与 CI 相同的条件：PostgreSQL 服务、无 Redis）

```
backend/tests/ tests/test_local_agent_adapter.py tests/test_deploy_script.py
612 passed, 55 skipped, 0 failed in 218.86s
```

> 说明：本机存在一个可达的本地 Redis（db 0），会残留限流键导致个别测试在**本地**误报 429。
> 该现象在未改动的基线提交上同样复现，**与本次变更无关**；CI 环境无 Redis 服务，
> 走内存回退，不受影响。上表结果即为屏蔽该本地 Redis 后的 CI 等价条件。

---

## 8. 遗留问题与移交

1. **生产 `.env` 的 `MAPR_TRUSTED_PROXIES` 取值**：需 A 组按
   `docs/安全配置说明-可信反向代理与客户端IP.md` 第 4 节在服务器上核对。
   默认值已覆盖 Docker 网桥，通常无需改动。
2. **Cloudflare 真实 IP 还原**：属 A 组可选加固项，不影响本次后端防护。
3. **本分支未推送 main、未部署**：等待人工审批合并。

---

## 9. 未执行事项（明确声明）

- 未连接、未读取、未修改北京生产数据库。
- 未执行任何真实部署。
- 未推送 `main` 分支。
