import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Layers, Plane, Receipt, ShieldCheck } from "lucide-react";
import { ConnectButton } from "../components/ConnectButton";

export function ConnectDemoPage() {
  const [calendarResult, setCalendarResult] = useState<any>(null);
  const [receiptResult, setReceiptResult] = useState<any>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  return (
    <div>
      <header className="topbar">
        <Link to="/" className="topbar__brand">
          <Layers size={17} strokeWidth={1.9} />
          <span>Multi-Agent 协作空间</span>
        </Link>
        <span className="topbar__spacer" />
        <Link to="/home" className="btn btn-ghost btn-sm">
          返回房间列表
        </Link>
      </header>

      <div className="setup-page" style={{ maxWidth: 880 }}>
        <div className="setup-head">
          <h1>SkyTrip 差旅智能助手</h1>
          <p>
            第三方应用接入示范 — 通过 Connect with MAPR 实现单次明确授权与最小化隐私数据代取
          </p>
        </div>

        {errorMsg && (
          <div
            className="auth-error"
            style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}
            role="alert"
          >
            <AlertCircle size={16} strokeWidth={1.9} />
            <span>{errorMsg}</span>
          </div>
        )}

        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          }}
        >
          <div className="card" style={{ padding: 24 }}>
            <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16 }}>
              <Plane size={18} strokeWidth={1.85} color="var(--legacy-accent)" />
              <span>差旅航班时间匹配</span>
            </h3>
            <p className="hint" style={{ marginTop: 8 }}>
              申请获取您下周的日程忙闲区间（仅起止时段，剥离会议标题、备注与私密联系人）。
            </p>
            <div style={{ marginTop: 18 }}>
              <ConnectButton
                appId="skytrip-app"
                scope="calendar.free_busy"
                purpose="查询空闲时间以匹配差旅航班"
                constraints={{ date_from: "2026-10-05", date_to: "2026-10-09" }}
                buttonText="授权读取忙闲 (Connect with MAPR)"
                onSuccess={(res) => {
                  setCalendarResult(res);
                  setErrorMsg(null);
                }}
                onError={(err) => setErrorMsg(err.message)}
              />
            </div>
            {calendarResult && (
              <div className="setup-info" style={{ marginTop: 14 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontWeight: 600,
                    color: "var(--success)",
                  }}
                >
                  <CheckCircle2 size={15} strokeWidth={2} />
                  <span>授权通过：已获取忙闲时段</span>
                </div>
                <div style={{ marginTop: 6 }}>
                  授权凭据 ID: <code>{calendarResult.grant?.grant_id}</code>
                  <br />
                  忙碌时段数: {calendarResult.payload?.busy?.length || 0} 个
                </div>
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 24 }}>
            <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16 }}>
              <Receipt size={18} strokeWidth={1.85} color="var(--legacy-accent)" />
              <span>电子客票自动报销</span>
            </h3>
            <p className="hint" style={{ marginTop: 8 }}>
              申请检索 12306 铁路客票邮件（内容经过电话、邮箱脱敏清洗，附件 SHA256 哈希校验）。
            </p>
            <div style={{ marginTop: 18 }}>
              <ConnectButton
                appId="skytrip-app"
                scope="email.receipt"
                purpose="自动读取铁路电子客票以报销差旅"
                constraints={{ query: "from:12306", date_from: "2026-10-01", date_to: "2026-10-10" }}
                buttonText="授权读取客票 (Connect with MAPR)"
                onSuccess={(res) => {
                  setReceiptResult(res);
                  setErrorMsg(null);
                }}
                onError={(err) => setErrorMsg(err.message)}
              />
            </div>
            {receiptResult && (
              <div className="setup-info" style={{ marginTop: 14 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontWeight: 600,
                    color: "var(--success)",
                  }}
                >
                  <CheckCircle2 size={15} strokeWidth={2} />
                  <span>授权通过：已提取客票凭证</span>
                </div>
                <div style={{ marginTop: 6 }}>
                  主题: <span>{receiptResult.payload?.subject}</span>
                  <br />
                  摘要: {receiptResult.payload?.body_excerpt}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="card" style={{ padding: 24, marginTop: 16 }}>
          <h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15 }}>
            <ShieldCheck size={17} strokeWidth={1.85} color="var(--legacy-accent)" />
            <span>Connect with MAPR 安全设计规范</span>
          </h3>
          <ul
            className="hint"
            style={{
              marginTop: 10,
              paddingLeft: 18,
              display: "flex",
              flexDirection: "column",
              gap: 5,
            }}
          >
            <li>单次授权原则：凭证 10 分钟自动过期，使用一次即废弃。</li>
            <li>最小披露保证：第三方无法获取用户邮箱凭据或全量日历，数据由本机网关过滤后签发。</li>
            <li>不可篡改核验：授权凭证由用户本机私钥签名绑定，数据哈希严格一致方可使用。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
