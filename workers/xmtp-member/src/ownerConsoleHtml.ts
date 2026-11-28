export const OWNER_CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>主人控制台</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 880px; margin: 24px auto; padding: 0 16px; }
section { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
.row { border-top: 1px solid #eee; padding: 8px 0; }
button { margin-right: 8px; }
code { font-size: 12px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eee; }
th { background-color: #f9f9f9; }
.action-detail { margin: 6px 0; }
.action-detail div { padding: 1px 0; }
.field-label { color: #666; font-size: 13px; }
.body-preview { white-space: pre-wrap; background: #f7f7f7; border: 1px solid #e5e5e5; border-radius: 6px; padding: 8px; max-height: 180px; overflow: auto; font-size: 13px; }
</style>
</head>
<body>
<h1>主人控制台</h1>
<p>本机地址：<code id="self"></code><span id="role-badge" style="color:#666;font-size:14px;margin-left:8px;"></span></p>

<section>
<h2>成果计分板</h2>
<div id="scoreboard">加载中...</div>
</section>

<section>
<h2>待批准</h2>
<div id="consents">加载中...</div>
</section>

<section id="task-section">
<h2>派发新任务</h2>
<form id="task-form">
<p>执行者地址 <input name="to" size="46" required></p>
<p>任务目标 <input name="goal" size="46" maxlength="500" required></p>
<p>验收标准（每行一条）<br><textarea name="acceptance" rows="3" cols="50" required placeholder="如：地点数量必须恰好为3个&#10;每个地点附带一句风景特色"></textarea></p>
<button type="submit">派发任务</button> <span id="task-result"></span>
</form>
</section>

<section id="request-section">
<h2>向对方请求空闲时间</h2>
<form id="request-form">
<p>对方地址 <input name="to" size="46" required></p>
<p>日期 <input name="date_from" type="date" required> 到 <input name="date_to" type="date" required></p>
<p>用途 <input name="purpose" size="46" maxlength="280"></p>
<button type="submit">发送请求</button> <span id="request-result"></span>
</form>
</section>

<section id="action-request-section">
<h2>发起动作请求</h2>
<form id="action-form">
<p>对方地址 <input name="to" size="46" required></p>
<p>动作 <input name="action" value="gmail.send" size="24" required></p>
<p>参数（JSON）<br><textarea name="params" rows="7" cols="60" required placeholder='{"to":["a@x.com"],"subject":"主题","body":"正文"}'></textarea></p>
<p>用途 <input name="purpose" size="46" maxlength="280"></p>
<button type="submit">发送动作请示</button> <span id="action-request-result"></span>
</form>
</section>

<section id="accounts-section">
<h2>外部账户</h2>
<div id="accounts"></div>
<form id="account-form">
<p>账户 id <input name="id" size="20" required placeholder="work-mail">
服务 <select name="service"><option value="gmail">gmail</option><option value="google_calendar">google_calendar</option></select>
显示名 <input name="label" size="16" required placeholder="工作邮箱"></p>
<p>凭据 JSON（写入本机 0600 文件；accounts.json 不保存 secret）<br>
<textarea name="credentials" rows="4" cols="60" required placeholder='{"access_token":"…","refresh_token":"…","client_id":"…","client_secret":"…"}'></textarea></p>
<button type="submit">登记账户</button> <span id="account-result"></span>
</form>
</section>

<section id="triggers-section">
<h2>事件触发器</h2>
<p style="color:#666;font-size:13px;">触发器只产生「待批准候选」——一律进审批队列，默认需人工放行；硬禁区动作根本建不了。</p>
<div id="triggers"></div>
<form id="trigger-form">
<p>触发器 id <input name="id" size="20" required placeholder="new-mail-notify">
账户 <select name="account_id" id="trigger-account-select"></select>
每小时间隔上限 <input name="max_per_hour" type="number" value="5" min="1" max="1000" size="5" style="width:70px">
轮询毫秒 <input name="poll_interval_ms" type="number" value="60000" min="5000" size="8" style="width:90px"></p>
<p>Gmail 查询 <input name="query" size="40" placeholder="is:unread label:invoice"></p>
<p>动作 <input name="action" value="gmail.send" size="20" required></p>
<p>参数模板（支持 {{external_event_id}} {{trigger_id}} {{account_id}}；account 字段会被强制写回所选账户）<br>
<textarea name="action_params_template" rows="5" cols="60" required placeholder='{"to":["me@x.com"],"subject":"新邮件 {{external_event_id}}","body":"触发器命中"}'></textarea></p>
<p><label><input name="enabled" type="checkbox" checked> 启用</label></p>
<button type="submit">创建触发器</button> <span id="trigger-result"></span>
</form>
</section>

<section>
<h2>任务执行状态</h2>
<div id="tasks"></div>
</section>

<section>
<h2>收到的数据</h2>
<div id="inbox"></div>
</section>

<section>
<h2>本机账本</h2>
<div id="ledger"></div>
</section>

<script>
const H = { "Content-Type": "application/json", "X-MAPR-Owner": "1" };
function text(el, value) { el.textContent = value; return el; }
function div(cls) { const d = document.createElement("div"); if (cls) d.className = cls; return d; }

// 账户/触发器元数据——GET 也要 owner 头，每次刷新重取（数据量小）。
let accountsMap = {};

async function act(id, action) {
  const res = await fetch("/api/consents/" + encodeURIComponent(id) + "/" + action, { method: "POST", headers: H });
  const body = await res.json();
  if (!body.ok) alert("失败：" + body.reason);
  refresh();
}

function accountLabel(id) {
  const a = accountsMap[id];
  return a ? a.label + "（" + id + "）" : id;
}

async function deleteAccount(id) {
  if (!confirm("删除账户 " + id + " 及其本机凭据文件？")) return;
  const res = await fetch("/api/accounts/" + encodeURIComponent(id), { method: "DELETE", headers: H });
  const body = await res.json();
  if (!body.ok) alert("失败：" + body.reason);
  refresh();
}

async function toggleTrigger(id, enabled) {
  const res = await fetch("/api/triggers/" + encodeURIComponent(id) + "/toggle", {
    method: "POST", headers: H, body: JSON.stringify({ enabled: !enabled }),
  });
  const body = await res.json();
  if (!body.ok) alert("失败：" + body.reason);
  refresh();
}

// 完整动作参数只在 owner 头的详情端点给；这里把它渲染成审批卡。
async function fillActionDetail(box, id, brief) {
  try {
    const res = await fetch("/api/consents/" + encodeURIComponent(id), { headers: H });
    if (!res.ok) { text(box, "参数详情加载失败（" + res.status + "）"); return; }
    const data = await res.json();
    const c = data.consent || {};
    const p = c.params || {};
    box.replaceChildren();
    if (!brief) {
      if (p.to) box.append(text(div(), "收件人：" + (Array.isArray(p.to) ? p.to.join(", ") : String(p.to))));
      if (Array.isArray(p.cc) && p.cc.length) box.append(text(div(), "抄送：" + p.cc.join(", ")));
      if (Array.isArray(p.bcc) && p.bcc.length) box.append(text(div(), "密送：" + p.bcc.join(", ")));
      if (p.account) box.append(text(div(), "账户：" + accountLabel(p.account)));
      if (typeof p.subject === "string") box.append(text(div(), "主题：" + p.subject));
      if (typeof p.body === "string") {
        box.append(text(div("field-label"), "正文："));
        box.append(text(div("body-preview"), p.body));
      }
      for (const k of Object.keys(p)) {
        if (["to", "cc", "bcc", "subject", "body", "account"].indexOf(k) === -1) {
          box.append(text(div(), k + "：" + JSON.stringify(p[k])));
        }
      }
    }
    if (c.result_status) {
      box.append(text(div(), "执行结果：" + c.result_status +
        (c.result_receipt ? "｜外部回执 " + c.result_receipt : "") +
        (c.result_summary ? "｜" + c.result_summary : "")));
    }
  } catch (e) {
    text(box, "参数详情加载失败");
  }
}

async function refresh() {
  const state = await (await fetch("/api/state")).json();
  text(document.getElementById("self"), state.self);

  if (state.role === "observer") {
    text(document.getElementById("role-badge"), " (观察者 - 只读)");
    const ts = document.getElementById("task-section");
    if (ts) ts.style.display = "none";
    const rs = document.getElementById("request-section");
    if (rs) rs.style.display = "none";
    const ar = document.getElementById("action-request-section");
    if (ar) ar.style.display = "none";
    const as = document.getElementById("accounts-section");
    if (as) as.style.display = "none";
    const trs = document.getElementById("triggers-section");
    if (trs) trs.style.display = "none";
  }

  // 账户与触发器：owner 头的 GET 端点；501/403 时静默隐藏（未配置也能用旧控制台）。
  const accounts = await fetch("/api/accounts", { headers: H })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && d.accounts) || [])
    .catch(() => []);
  accountsMap = {};
  for (const a of accounts) accountsMap[a.id] = a;
  const accountsEl = document.getElementById("accounts");
  if (accountsEl) {
    accountsEl.replaceChildren();
    if (accounts.length === 0) text(accountsEl, "尚未登记外部账户");
    for (const a of accounts) {
      const row = div("row");
      row.append(text(div(), a.label + "｜" + a.id + "｜" + a.service + "｜凭据 " + a.cred_path));
      const del = text(document.createElement("button"), "删除");
      del.onclick = () => deleteAccount(a.id);
      row.append(del);
      accountsEl.append(row);
    }
    const sel = document.getElementById("trigger-account-select");
    if (sel) {
      const prev = sel.value;
      sel.replaceChildren();
      for (const a of accounts.filter((x) => x.service === "gmail")) {
        const opt = document.createElement("option");
        opt.value = a.id;
        opt.textContent = a.label + "（" + a.id + "）";
        sel.append(opt);
      }
      if (prev) sel.value = prev;
    }
  }

  const triggers = await fetch("/api/triggers", { headers: H })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && d.triggers) || [])
    .catch(() => []);
  const triggersEl = document.getElementById("triggers");
  if (triggersEl) {
    triggersEl.replaceChildren();
    if (triggers.length === 0) text(triggersEl, "尚未配置触发器");
    for (const t of triggers) {
      const row = div("row");
      row.append(text(div(),
        (t.enabled ? "🟢 启用中" : "⚪ 已停用") + "｜" + t.id + "｜账户 " + accountLabel(t.account_id) +
        "｜动作 " + t.action + "｜每小时≤" + t.max_per_hour +
        (t.query ? "｜q=" + t.query : "")));
      row.append(text(div(),
        "窗口已入队 " + (t.window_count || 0) + "｜去重游标 " + (t.seen_count || 0) +
        " 条｜连续失败 " + (t.consecutive_failures || 0) +
        (t.next_poll_at ? "｜下次轮询 " + t.next_poll_at : "")));
      const btn = text(document.createElement("button"), t.enabled ? "停用" : "启用");
      btn.onclick = () => toggleTrigger(t.id, t.enabled);
      row.append(btn);
      triggersEl.append(row);
    }
  }

  const sbEl = document.getElementById("scoreboard");
  sbEl.replaceChildren();
  if (!state.scoreboard || state.scoreboard.length === 0) {
    text(sbEl, "暂无成果计分数据");
  } else {
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>智能体成员地址</th><th>采纳交付数 (Accepted)</th><th>质疑驳回数 (Rejected)</th></tr>";
    table.append(thead);
    const tbody = document.createElement("tbody");
    for (const item of state.scoreboard) {
      const tr = document.createElement("tr");
      const peerCell = document.createElement("td");
      peerCell.append(text(document.createElement("code"), String(item.peer)));
      tr.append(peerCell, text(document.createElement("td"), String(item.accepted)), text(document.createElement("td"), String(item.rejected)));
      tbody.append(tr);
    }
    table.append(tbody);
    sbEl.append(table);
  }

  const consents = document.getElementById("consents");
  consents.replaceChildren();
  const pending = (state.consents || []).filter((c) => c.status === "pending");
  if (pending.length === 0) text(consents, "没有待批准的请求");
  for (const c of pending) {
    const row = div("row");
    row.append(text(div(), "请求方：" + c.requester + (c.kind === "action" ? "【动作】" : "") +
      (c.source === "trigger" ? "（由触发器发起）" : "")));
    if (c.account_id) row.append(text(div(), "绑定账户：" + accountLabel(c.account_id)));
    if (c.kind === "action") {
      row.append(text(div(), "动作：" + c.scope));
      const detail = div("action-detail");
      text(detail, "参数加载中…");
      row.append(detail);
      fillActionDetail(detail, c.request_id, false);
      row.append(text(div(), "批准后按上述参数执行一次；参数与批准绑定，改动必须重新请示。"));
    } else {
      row.append(text(div(), "范围：" + c.scope + "（" + c.constraints.date_from + " 到 " + c.constraints.date_to + "）"));
      row.append(text(div(), "批准后只会发出这段日期内每个日程的开始和结束时间，不含标题、备注、参与人。"));
    }
    row.append(text(div(), "对方说明的用途：" + (c.purpose || "（未填写）")));
    if (c.rule_hit) row.append(text(div(), "触发规则：" + c.rule_hit));
    if (c.expires_at) row.append(text(div(), "到期时间：" + c.expires_at));
    const yes = text(document.createElement("button"), "允许一次");
    yes.onclick = () => act(c.request_id, "approve");
    const no = text(document.createElement("button"), "拒绝");
    no.onclick = () => act(c.request_id, "deny");
    row.append(yes, no);
    consents.append(row);
  }

  // 进行中/需对账的条目：状态真实可见；awaiting_receipt 可手动重发回执（不重新执行）。
  const STATUS_LABEL = {
    approved: "已批准·未开始",
    executing: "执行中",
    awaiting_receipt: "待回执（已执行·发送未确认）",
    uncertain: "结果不明·需人工对账",
    completed: "已完成",
    denied: "已拒绝",
    expired: "已过期",
  };
  const inflight = (state.consents || []).filter((c) =>
    ["approved", "executing", "awaiting_receipt", "uncertain"].includes(c.status));
  for (const c of inflight) {
    const row = div("row");
    row.append(text(div(), "请求方：" + c.requester + (c.kind === "action" ? "【动作】" : "") +
      (c.source === "trigger" ? "（由触发器发起）" : "")));
    if (c.account_id) row.append(text(div(), "绑定账户：" + accountLabel(c.account_id)));
    row.append(text(div(), "范围：" + c.scope + " | 状态：" + (STATUS_LABEL[c.status] || c.status)));
    if (c.kind === "action") {
      const detail = div("action-detail");
      row.append(detail);
      fillActionDetail(detail, c.request_id, true);
    }
    if (c.status === "approved") {
      // 已批准未开始：仍可收回——执行一旦开始（executing 起）就不能再拒。
      const no = text(document.createElement("button"), "收回批准");
      no.onclick = () => act(c.request_id, "deny");
      row.append(no);
    }
    if (c.status === "awaiting_receipt") {
      const resend = text(document.createElement("button"), "重发回执");
      resend.onclick = () => act(c.request_id, "resend");
      row.append(resend);
    }
    if (c.status === "uncertain") {
      row.append(text(div(), "外部动作可能已生效——请先与对方/外部凭据对账，不要重复执行。"));
    }
    consents.append(row);
  }

  const tasksEl = document.getElementById("tasks");
  tasksEl.replaceChildren();
  const tasks = state.tasks || [];
  if (tasks.length === 0) text(tasksEl, "暂无执行中的任务");
  for (const t of tasks.slice().reverse()) {
    const row = div("row");
    row.append(text(div(), "任务 [" + t.request_id + "] -> " + t.task.to + " | 状态: " + t.status));
    row.append(text(div(), "目标: " + t.task.goal + " (轮次: " + t.task.round + ")"));
    if (t.results && t.results.length > 0) {
      const lastRes = t.results[t.results.length - 1];
      row.append(text(div(), "最新成果: " + lastRes.summary));
    }
    if (t.verdicts && t.verdicts.length > 0) {
      const lastVer = t.verdicts[t.verdicts.length - 1];
      row.append(text(div(), "最新裁决: " + (lastVer.accepted ? "通过" : "质疑: " + lastVer.challenge)));
    }
    tasksEl.append(row);
  }

  // 完整 inbox 只在 owner 头端点给；/api/state 里的只是脱敏元数据。
  const inboxEntries = await fetch("/api/inbox", { headers: H })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (d && d.inbox) || [])
    .catch(() => []);
  const inbox = document.getElementById("inbox");
  inbox.replaceChildren();
  for (const e of inboxEntries) {
    const row = div("row");
    const p = e.payload || {};
    if (p.kind === "action_result") {
      row.append(text(div(), "来自 " + e.from + " 的动作回执：" + (p.status || "?") +
        (p.receipt ? "｜外部回执 " + p.receipt : "") + (p.summary ? "｜" + p.summary : "")));
    } else if (p.scope === "email.receipt") {
      row.append(text(div(), "来自 " + e.from + " 的邮件回执：" + (p.subject || "（无主题）") +
        (p.sent_at ? "｜" + p.sent_at : "") + (p.attachment_name ? "｜附件 " + p.attachment_name : "")));
    } else {
      row.append(text(div(), "来自 " + e.from + "，" + (p.date_from || "?") + " 到 " + (p.date_to || "?")));
      const busy = Array.isArray(p.busy) ? p.busy.map((b) => b.start + " ~ " + b.end).join("；") : "";
      row.append(text(div(), "忙碌时段：" + (busy || "无")));
    }
    inbox.append(row);
  }

  const ledger = document.getElementById("ledger");
  ledger.replaceChildren();
  for (const e of (state.ledger || []).slice(-30).reverse()) {
    ledger.append(text(div("row"), e.at + "  " + e.kind + "  " + (e.peer || "") + "  " + (e.reason || "")));
  }
}

document.getElementById("request-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(ev.target).entries());
  data.scope = "calendar.free_busy";
  const res = await fetch("/api/requests", { method: "POST", headers: H, body: JSON.stringify(data) });
  const body = await res.json();
  text(document.getElementById("request-result"), body.ok ? "已发送" : "失败：" + body.reason);
  refresh();
};

document.getElementById("action-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(ev.target).entries());
  let params;
  try {
    params = JSON.parse(data.params);
  } catch {
    text(document.getElementById("action-request-result"), "参数不是合法 JSON");
    return;
  }
  const res = await fetch("/api/action-requests", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ to: data.to, action: data.action, params, purpose: data.purpose }),
  });
  const body = await res.json();
  text(document.getElementById("action-request-result"), body.ok ? "已发送" : "失败：" + body.reason);
  refresh();
};

document.getElementById("account-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(ev.target).entries());
  let credentials;
  try {
    credentials = JSON.parse(data.credentials);
  } catch {
    text(document.getElementById("account-result"), "凭据不是合法 JSON");
    return;
  }
  const res = await fetch("/api/accounts", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ id: data.id, service: data.service, label: data.label, credentials }),
  });
  const body = await res.json();
  text(document.getElementById("account-result"), body.ok ? "已登记" : "失败：" + body.reason);
  refresh();
};

document.getElementById("trigger-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(ev.target).entries());
  let template;
  try {
    template = JSON.parse(data.action_params_template);
  } catch {
    text(document.getElementById("trigger-result"), "参数模板不是合法 JSON");
    return;
  }
  const res = await fetch("/api/triggers", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      id: data.id,
      enabled: data.enabled === "on",
      account_id: data.account_id,
      query: data.query || "",
      action: data.action,
      action_params_template: template,
      max_per_hour: Number(data.max_per_hour),
      poll_interval_ms: Number(data.poll_interval_ms),
    }),
  });
  const body = await res.json();
  text(document.getElementById("trigger-result"), body.ok ? "已创建" : "失败：" + body.reason);
  refresh();
};

document.getElementById("task-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const formData = new FormData(ev.target);
  const to = formData.get("to");
  const goal = formData.get("goal");
  const acceptanceRaw = formData.get("acceptance") || "";
  const acceptance = String(acceptanceRaw)
    .split("\\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const res = await fetch("/api/tasks", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ to, goal, acceptance }),
  });
  const body = await res.json();
  text(document.getElementById("task-result"), body.ok ? "已派发" : "失败：" + body.reason);
  refresh();
};

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
`;

export const CONNECT_AUTHORIZE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Connect with Parlor - 授权请求</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 520px; margin: 40px auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
.badge { display: inline-block; padding: 4px 8px; border-radius: 6px; background: #e0f2fe; color: #0369a1; font-weight: 600; font-size: 13px; margin-bottom: 12px; }
h2 { margin-top: 0; font-size: 20px; color: #0f172a; }
p { font-size: 14px; color: #334155; line-height: 1.5; }
.card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin: 16px 0; }
.actions { display: flex; gap: 12px; margin-top: 24px; }
button { flex: 1; padding: 10px 16px; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; border: none; }
.btn-primary { background: #2563eb; color: #fff; }
.btn-secondary { background: #f1f5f9; color: #475569; }
</style>
</head>
<body>
<div class="badge">Connect with Parlor</div>
<h2>第三方应用申请数据访问</h2>
<p>应用 <strong id="app-id">...</strong> 正在向您的智能体申请访问权限。</p>
<div class="card">
  <div><strong>申请范围：</strong><code id="scope">...</code></div>
  <div style="margin-top:6px;"><strong>申请用途：</strong><span id="purpose">...</span></div>
</div>
<p style="font-size:12px;color:#64748b;">授权仅为单次有效凭证（10分钟过期）。对方只能获取脱敏后的结构化数据，无法直接读取您的私人账户。</p>
<div class="actions">
  <button id="btn-deny" class="btn-secondary">拒绝</button>
  <button id="btn-approve" class="btn-primary">允许一次</button>
</div>
<script>
const params = new URLSearchParams(window.location.search);
const appId = params.get("app_id") || "未知应用";
const scope = params.get("scope") || "";
const purpose = params.get("purpose") || "未填写用途";
const redirectUri = params.get("redirect_uri") || "";
let constraints = {};
try { constraints = JSON.parse(params.get("constraints") || "{}"); } catch {}

document.getElementById("app-id").textContent = appId;
document.getElementById("scope").textContent = scope;
document.getElementById("purpose").textContent = purpose;

async function submitAction(endpoint) {
  const res = await fetch("/api/connect/" + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MAPR-Owner": "1" },
    body: JSON.stringify({ app_id: appId, scope, purpose, constraints, redirect_uri: redirectUri })
  });
  const data = await res.json();
  if (data.redirect_url) {
    if (window.opener) {
      window.opener.postMessage({ type: "MAPR_CONNECT_RESPONSE", ...data }, new URL(redirectUri).origin);
      window.close();
    } else {
      window.location.href = data.redirect_url;
    }
  } else {
    alert(data.ok ? "授权成功" : "已拒绝");
    if (window.opener) window.close();
  }
}

document.getElementById("btn-approve").onclick = () => submitAction("approve");
document.getElementById("btn-deny").onclick = () => submitAction("deny");
</script>
</body>
</html>
`;

