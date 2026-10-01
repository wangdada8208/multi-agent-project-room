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
</style>
</head>
<body>
<h1>主人控制台</h1>
<p>本机地址：<code id="self"></code></p>

<section>
<h2>待批准</h2>
<div id="consents">加载中...</div>
</section>

<section>
<h2>向对方请求空闲时间</h2>
<form id="request-form">
<p>对方地址 <input name="to" size="46" required></p>
<p>日期 <input name="date_from" type="date" required> 到 <input name="date_to" type="date" required></p>
<p>用途 <input name="purpose" size="46" maxlength="280"></p>
<button type="submit">发送请求</button> <span id="request-result"></span>
</form>
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

  const consents = document.getElementById("consents");
  consents.replaceChildren();
  const pending = state.consents.filter((c) => c.status === "pending");
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

  const inbox = document.getElementById("inbox");
  inbox.replaceChildren();
  for (const e of state.inbox) {
    const row = div("row");
    row.append(text(div(), "来自 " + e.from + "，" + e.payload.date_from + " 到 " + e.payload.date_to));
    row.append(text(div(), "忙碌时段：" + (e.payload.busy.map((b) => b.start + " ~ " + b.end).join("；") || "无")));
    inbox.append(row);
  }

  const ledger = document.getElementById("ledger");
  ledger.replaceChildren();
  for (const e of state.ledger.slice(-30).reverse()) {
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

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
`;
