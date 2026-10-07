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

async function act(id, action) {
  const res = await fetch("/api/consents/" + encodeURIComponent(id) + "/" + action, { method: "POST", headers: H });
  const body = await res.json();
  if (!body.ok) alert("失败：" + body.reason);
  refresh();
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
      tr.innerHTML = "<td><code>" + item.peer + "</code></td><td>" + item.accepted + "</td><td>" + item.rejected + "</td>";
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
    row.append(text(div(), "请求方：" + c.requester));
    row.append(text(div(), "范围：" + c.scope + "（" + c.constraints.date_from + " 到 " + c.constraints.date_to + "）"));
    row.append(text(div(), "对方说明的用途：" + (c.purpose || "（未填写）")));
    row.append(text(div(), "批准后只会发出这段日期内每个日程的开始和结束时间，不含标题、备注、参与人。"));
    const yes = text(document.createElement("button"), "允许一次");
    yes.onclick = () => act(c.request_id, "approve");
    const no = text(document.createElement("button"), "拒绝");
    no.onclick = () => act(c.request_id, "deny");
    row.append(yes, no);
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

  const inbox = document.getElementById("inbox");
  inbox.replaceChildren();
  for (const e of state.inbox || []) {
    const row = div("row");
    row.append(text(div(), "来自 " + e.from + "，" + e.payload.date_from + " 到 " + e.payload.date_to));
    row.append(text(div(), "忙碌时段：" + (e.payload.busy.map((b) => b.start + " ~ " + b.end).join("；") || "无")));
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
<title>Connect with MAPR - 授权请求</title>
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
<div class="badge">Connect with MAPR</div>
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
      window.opener.postMessage({ type: "MAPR_CONNECT_RESPONSE", ...data }, "*");
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

