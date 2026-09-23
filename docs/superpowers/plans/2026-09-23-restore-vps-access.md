# 恢复 seoul-vps 登录并拉起 Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `https://hub.wangdada8208.xyz/health` 返回 `{"status":"ok","service":"Multi-Agent Project Room"}`。健康检查恢复之后，再在生产 PostgreSQL 上执行已有清理脚本。

**Architecture:** Hub 仍由服务器上的 Docker Compose 提供。成员进程不放进 Hub 容器。清理只用 `backend/scripts/delete_hub_rooms_postgres.py`。

**已经做完，不要重做：**

- `59945b3` 的 PostgreSQL 清理脚本和 `9c90060` 的验收清单。
- 加密房间、成员轮次、模型回复、主人记录。
- 2026-09-23 已确认公网健康检查是 HTTP 522，正文 `error code: 522`。
- 同一天 SSH 到 `seoul-vps`（`47.80.18.105`）在密钥交换阶段被远端关闭。Tailscale 地址 `100.69.135.8` 超时，节点当时离线约 14 小时。这些地址只作为上次失败记录，登录前要重新确认，不要当成当前一定可用。

**不要做：**

- 不猜主机、用户名或密码。没有可用登录方式就停止。
- 健康检查仍是 522 时不执行生产库删除。
- 不使用 `backend/scripts/delete_hub_rooms.py` 连接生产库。
- 不把密钥、连接串或 `frontend/.env.local` 写入 git。
- 不把双机演练写成已完成。

从本计划 Task 1 开始。

---

### Task 1: 重新确认机器是否在线

- [ ] **Step 1: 从本机查健康检查**

```bash
curl -sS -m 25 -D - -o /tmp/hub-health-body.txt https://hub.wangdada8208.xyz/health
echo
cat /tmp/hub-health-body.txt
```

- [ ] **Step 2: 只用本机已有的 SSH 配置再试一次登录**

先看 `ssh -G seoul-vps` 是否还有这个主机别名。能登录再继续。密钥交换再次被关闭，或 Tailscale 仍显示离线，就停止并写出缺的是控制台登录，不要换一台没记录的机器。

- [ ] **Step 3: 登录后看容器**

```bash
docker compose ps
docker compose logs --tail 80 backend
```

不要把日志中的密钥抄进仓库。

---

### Task 2: 拉起 Hub

- [ ] **Step 1: 启动**

在服务器上的实际部署目录执行 `docker compose up -d`，然后 `docker compose ps`。

- [ ] **Step 2: 本机健康检查**

```bash
curl -sS http://127.0.0.1:8000/health
```

端口以 Compose 映射为准。期望 JSON 含 `"status":"ok"` 和 `"service":"Multi-Agent Project Room"`。

- [ ] **Step 3: 公网健康检查**

在开发机执行：

```bash
curl -sS -m 25 https://hub.wangdada8208.xyz/health
```

Expected: HTTP 200 和同样的 JSON。仍是 522 就停止，不要清库。

---

### Task 3: 健康检查恢复后清理用户明文房间

- [ ] **Step 1: 在服务器上用已有的生产环境变量运行**

```bash
python -m scripts.delete_hub_rooms_postgres
```

工作目录是后端目录，连接串来自该服务器已有的 `DATABASE_URL` 或 `MAPR_DATABASE_URL`。不要把连接串写入 git。

- [ ] **Step 2: 查询结果**

```sql
select count(*) from rooms
where transport = 'hub' and id not like '\_agent\_%' escape '\';
```

Expected: `0`。`_agent_` 房间仍在。把数量写进 `ACCEPTANCE_CHECKLIST.md` 的生产健康检查行旁边，不写消息正文。

- [ ] **Step 3: Commit**

只提交清单更新。

```bash
git add ACCEPTANCE_CHECKLIST.md
git commit -m "$(cat <<'EOF'
[文档] 记录生产健康检查已恢复且用户明文房间已清理

- Changed: 健康检查改为当前实测结果
- Handoff: 双机演练仍是 Pending

EOF
)"
```

---

## 计划自检

- 登不上服务器就停止：Task 1。
- `/health` 为 200 之后才清库：Task 2 和 Task 3。
- 不重做 `59945b3`。
