import { useState } from "react";
import { Plane, Receipt, Shield, CheckCircle2, AlertCircle } from "lucide-react";
import { ConnectButton } from "../components/ConnectButton";

export function ConnectDemoPage() {
  const [calendarResult, setCalendarResult] = useState<any>(null);
  const [receiptResult, setReceiptResult] = useState<any>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  return (
    <div className="setup-page" style={{ maxWidth: 860 }}>
      <div className="setup-head">
        <h1>SkyTrip 差旅智能助手</h1>
        <p>第三方应用接入示范 — 通过 Connect with MAPR 按钮实现单次授权与隐私安全数据代取</p>
      </div>

      {errorMsg && (
        <div className="auth-error" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle size={16} /> {errorMsg}
        </div>
      )}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <div className="card" style={{ padding: 22 }}>
          <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16 }}>
            <Plane size={18} color="var(--accent)" /> 差旅航班时间匹配
          </h3>
          <p className="hint" style={{ marginTop: 6 }}>
            申请获取您下周的日程忙闲区间（仅起止时段，完全剥离会议标题、备注与私密联系人）。
          </p>
          <div style={{ marginTop: 16 }}>
            <ConnectButton
              appId="skytrip-app"
              scope="calendar.free_busy"
              purpose="查询空闲时间以智能匹配差旅航班"
              constraints={{ date_from: "2026-10-05", date_to: "2026-10-09" }}
              buttonText="授权读取忙闲 (Connect with MAPR)"
              onSuccess={(res) => { setCalendarResult(res); setErrorMsg(null); }}
              onError={(err) => setErrorMsg(err.message)}
            />
          </div>
          {calendarResult && (
            <div className="setup-info" style={{ marginTop: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--green)" }}>
                <CheckCircle2 size={15} /> 授权通过：已获取忙闲时段
              </div>
              <div style={{ marginTop: 6 }}>
                授权凭据 ID: <code>{calendarResult.grant?.grant_id}</code><br />
                忙碌时段数: {calendarResult.payload?.busy?.length || 0} 个
              </div>
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 22 }}>
          <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16 }}>
            <Receipt size={18} color="var(--accent)" /> 电子客票自动报销
          </h3>
          <p className="hint" style={{ marginTop: 6 }}>
            申请检索 12306 铁路客票邮件（内容经过电话、邮箱脱敏清洗，附件 SHA256 哈希校验）。
          </p>
          <div style={{ marginTop: 16 }}>
            <ConnectButton
              appId="skytrip-app"
              scope="email.receipt"
              purpose="自动读取铁路电子客票以报销差旅"
              constraints={{ query: "from:12306", date_from: "2026-10-01", date_to: "2026-10-10" }}
              buttonText="授权读取客票 (Connect with MAPR)"
              onSuccess={(res) => { setReceiptResult(res); setErrorMsg(null); }}
              onError={(err) => setErrorMsg(err.message)}
            />
          </div>
          {receiptResult && (
            <div className="setup-info" style={{ marginTop: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--green)" }}>
                <CheckCircle2 size={15} /> 授权通过：已提取客票凭证
              </div>
              <div style={{ marginTop: 6 }}>
                主题: <span>{receiptResult.payload?.subject}</span><br />
                摘要: {receiptResult.payload?.body_excerpt}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 22, marginTop: 16 }}>
        <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15 }}>
          <Shield size={16} color="var(--accent)" /> Connect with MAPR 安全设计规范
        </h3>
        <ul className="hint" style={{ marginTop: 10, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
          <li>单次授权原则：凭证 10 分钟自动过期，使用一次即废弃。</li>
          <li>最小披露保证：第三方无法获取用户邮箱凭据或日程全量日历，数据由本机网关过滤后签发。</li>
          <li>不可篡改核验：授权凭证由用户以太坊私钥签名绑定，数据哈希严格一致方可使用。</li>
        </ul>
      </div>
    </div>
  );
}
