# MAPR 第四轮审计 B 组修复与验证报告

## 一、审查与修复背景
- 基线提交：`5f261b4d0c724563349eb6828d320f978449c028` (`integration/audit-round3`)
- 独立修复分支：`fix/audit-round4-a2a`
- 修复提交：`2d8bfd3f894c141bf92cc51c41a0edd9b306e5de`
- 运行环境：PostgreSQL 17.11 (role: `mapr`, db: `mapr_test`)

## 二、修复内容明细

### 1. A2A 真实并发幂等与数据库一致性
- 文件：`backend/app/a2a/http_protocol.py`、`backend/tests/test_a2a_audit_group_b.py`
- 修复点：
  - 在并发唯一键竞争重试路径中增加重试退避让步，确保先提交事务释放锁后重试查询能够稳定读取。
  - 测试用例 `test_concurrent_send_same_key_creates_one_task` 通过真实 PostgreSQL 并发同时提交两个相同幂等键请求。
  - 严格断言两次请求均成功且返回完全相同的任务 ID。
  - 数据库层面严格验证仅产生 1 条 Message、1 个 A2ATask 以及 1 条对应的 Delivery 记录。

### 2. A2A 重试与冲突检测
- 修复点：
  - 测试用例 `test_same_key_retry_returns_existing_task` 补全了真正的第二次相同请求发送。
  - 验证重试返回同一任务 ID，且列表分页中不产生重复任务记录。
  - 增加相同幂等键但修改消息正文的测试，验证严格返回 HTTP 409 Conflict (`payload mismatch`)。
  - 增加相同幂等键但修改目标 Agent 的测试，验证严格返回 HTTP 409 Conflict (`target mismatch`)。

### 3. SSE 绑定失败、生命周期与补偿机制
- 修复点：
  - 测试用例 `test_sse_bind_failure_does_not_cancel_existing_task` 改用真实 `SendStreamingMessage` 流程触发 `bind_task` 失败。
  - 验证绑定失败时已存在的旧任务状态严格保持为 `submitted`，绝不会被误取消。
  - 新增 `test_sse_bind_failure_compensates_new_task_and_releases_lease`，验证新任务在绑定失败时执行补偿并标记为 `canceled`，同时释放配额租约，后续恢复查询能正确读取取消状态。
  - 新增 `test_sse_bind_failure_compensation_failure_marks_task_failed`，验证补偿取消异常时降级为 `failed` 状态，后续恢复查询能正常读取。
  - 修复 `test_compensation_logs_no_payload_data`，通过注入补偿取消异常真实触发警告日志，验证日志包含异常类名且绝不泄露正文、房间号及 Agent 标识。

### 4. ListTasks 任务分页扫描穿透
- 修复点：
  - 修复了 `http_protocol.py` 中当扫描达到 4096 条原始记录且页面未满时错误结束分页的问题。
  - 调整为只要扫描达到上限且底层数据库仍有后续记录，即使当前页过滤后无可见数据，也稳定签发 `nextPageToken` 推进游标。
  - 新增 `test_pagination_over_4096_filtered_records` 专项测试：在两个可见任务之间批量注入 4200 条被权限过滤的不可见记录，验证跨页遍历能够完整且无重复地获取所有可见任务。

### 5. PostgreSQL 类型兼容性
- 修复点：
  - 修复了无关联人类属主的 Agent 用户在列出任务时 `A2ATask.id == -1` 引发的 PostgreSQL 字符串与整数类型比较错误。
  - 替换为安全且跨数据库兼容的 SQLAlchemy `false()` 条件。
  - 新增 `test_postgres_agent_without_owner_list_tasks` 并在真实 PostgreSQL 环境下验证通过。

## 三、真实 PostgreSQL 测试证据

### 1. 专项测试套件（test_a2a_audit_group_b.py）
```text
rootdir: /data/projects/multi-agent-project-room
collected 31 items

backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[abc-123-True] PASSED [  3%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[a.b_c:d-e-True] PASSED [  6%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK-True] PASSED [  9%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK-False] PASSED [ 12%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[-False] PASSED [ 16%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[has space-False] PASSED [ 19%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[sla/sh-False] PASSED [ 22%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[line\nbreak-False] PASSED [ 25%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[percent%20-False] PASSED [ 29%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[semi;colon-False] PASSED [ 32%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[quote'd-False] PASSED [ 35%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[<script>-False] PASSED [ 38%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyGrammar::test_regex_accepts_and_rejects[../../etc/passwd-False] PASSED [ 41%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyRejection::test_overlong_key_is_rejected_not_truncated PASSED [ 45%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyRejection::test_whitespace_key_is_rejected PASSED [ 48%]
backend/tests/test_a2a_audit_group_b.py::TestIdempotencyKeyRejection::test_valid_key_is_accepted PASSED [ 51%]
backend/tests/test_a2a_audit_group_b.py::test_concurrent_send_same_key_creates_one_task PASSED [ 54%]
backend/tests/test_a2a_audit_group_b.py::TestJWTTypeClaim::test_typ_mismatch_is_rejected PASSED [ 58%]
backend/tests/test_a2a_audit_group_b.py::TestJWTTypeClaim::test_matching_typ_is_accepted PASSED [ 61%]
backend/tests/test_a2a_audit_group_b.py::test_list_tasks_excludes_other_rooms PASSED [ 64%]
backend/tests/test_a2a_audit_group_b.py::test_pagination_is_consistent_across_pages PASSED [ 67%]
backend/tests/test_a2a_audit_group_b.py::test_page_token_round_trip_is_stable PASSED [ 70%]
backend/tests/test_a2a_audit_group_b.py::test_same_key_retry_returns_existing_task PASSED [ 74%]
backend/tests/test_a2a_audit_group_b.py::test_distinct_messages_create_distinct_tasks PASSED [ 77%]
backend/tests/test_a2a_audit_group_b.py::test_sse_bind_failure_does_not_cancel_existing_task PASSED [ 80%]
backend/tests/test_a2a_audit_group_b.py::test_sse_bind_failure_compensates_new_task_and_releases_lease PASSED [ 83%]
backend/tests/test_a2a_audit_group_b.py::test_sse_bind_failure_compensation_failure_marks_task_failed PASSED [ 87%]
backend/tests/test_a2a_audit_group_b.py::test_compensation_logs_no_payload_data PASSED [ 90%]
backend/tests/test_a2a_audit_group_b.py::test_sse_endpoint_returns_the_task_stream PASSED [ 93%]
backend/tests/test_a2a_audit_group_b.py::test_pagination_over_4096_filtered_records PASSED [ 96%]
backend/tests/test_a2a_audit_group_b.py::test_postgres_agent_without_owner_list_tasks PASSED [100%]

============================= 31 passed in 18.04s ==============================
```

### 2. A2A 全量套件无回归验证
```text
collected 174 items

backend/tests/test_a2a_audit_group_b.py ...............................  [ 17%]
backend/tests/test_a2a_protocol_v1_linux.py ............................ [ 33%]
........                                                                 [ 38%]
backend/tests/test_a2a_acceptance_linux.py ...........................   [ 54%]
backend/tests/test_a2a_egress_ssrf_linux.py ............................ [ 70%]
..........................................                               [ 94%]
backend/tests/test_a2a_dialogues.py ..                                   [ 95%]
backend/tests/test_a2a.py ........                                       [100%]

============================= 174 passed in 59.90s =============================
```
