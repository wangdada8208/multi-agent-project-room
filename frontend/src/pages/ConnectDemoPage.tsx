import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Infinity as InfinityIcon, Plane, Receipt, ShieldCheck } from "lucide-react";
import { AgentPromptSetupPicker } from "../components/AgentPromptSetupPicker";
import { ConnectButton } from "../components/ConnectButton";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function ConnectDemoPage() {
  useDocumentTitle("连接演示 · Parlor");
  const [calendarResult, setCalendarResult] = useState<any>(null);
  const [receiptResult, setReceiptResult] = useState<any>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  return (
    <div className="connect-demo-page">
      <header className="topbar">
        <Link to="/" className="topbar__brand">
          <InfinityIcon size={17} strokeWidth={2} />
          <span>Parlor</span>
        </Link>
        <span className="topbar__spacer" />
        <Link to="/home" className="ui-button ui-button--ghost ui-button--sm">
          返回房间
        </Link>
      </header>

      <div className="connect-demo__inner">
        <div className="connect-demo__head">
          <h1>SkyTrip 差旅智能助手</h1>
          <p>
            第三方应用接入示范 — 通过 Connect with Parlor 实现单次明确授权与最小化隐私数据代取
          </p>
        </div>

        {errorMsg && (
          <div className="connect-demo__error" role="alert">
            <AlertCircle size={16} strokeWidth={1.9} />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="connect-demo__grid">
          <div className="card connect-demo__card">
            <h3>
              <Plane size={18} strokeWidth={1.85} />
              <span>差旅航班时间匹配</span>
            </h3>
            <p className="hint">
              申请获取下周的日程忙闲区间（仅起止时段，剥离会议标题、备注与私密联系人）。
            </p>
            <div className="connect-demo__cta">
              <ConnectButton
                appId="skytrip-app"
                scope="calendar.free_busy"
                purpose="查询空闲时间以匹配差旅航班"
                constraints={{ date_from: "2026-10-05", date_to: "2026-10-09" }}
                buttonText="授权读取忙闲 (Connect with Parlor)"
                onSuccess={(res) => {
                  setCalendarResult(res);
                  setErrorMsg(null);
                }}
                onError={(err) => setErrorMsg(err.message)}
              />
            </div>
            {calendarResult && (
              <div className="connect-demo__result">
                <div className="connect-demo__result-ok">
                  <CheckCircle2 size={15} strokeWidth={2} />
                  <span>授权通过：已获取忙闲时段</span>
                </div>
                <p>
                  授权凭据 ID: <code>{calendarResult.grant?.grant_id}</code>
                  <br />
                  忙碌时段数: {calendarResult.payload?.busy?.length || 0} 个
                </p>
              </div>
            )}
          </div>

          <div className="card connect-demo__card">
            <h3>
              <Receipt size={18} strokeWidth={1.85} />
              <span>电子客票自动报销</span>
            </h3>
            <p className="hint">
              申请检索 12306 铁路客票邮件（内容经过电话、邮箱脱敏清洗，附件 SHA256 哈希校验）。
            </p>
            <div className="connect-demo__cta">
              <ConnectButton
                appId="skytrip-app"
                scope="email.receipt"
                purpose="自动读取铁路电子客票以报销差旅"
                constraints={{ query: "from:12306", date_from: "2026-10-01", date_to: "2026-10-10" }}
                buttonText="授权读取客票 (Connect with Parlor)"
                onSuccess={(res) => {
                  setReceiptResult(res);
                  setErrorMsg(null);
                }}
                onError={(err) => setErrorMsg(err.message)}
              />
            </div>
            {receiptResult && (
              <div className="connect-demo__result">
                <div className="connect-demo__result-ok">
                  <CheckCircle2 size={15} strokeWidth={2} />
                  <span>授权通过：已提取客票凭证</span>
                </div>
                <p>
                  主题: <span>{receiptResult.payload?.subject}</span>
                  <br />
                  摘要: {receiptResult.payload?.body_excerpt}
                </p>
              </div>
            )}
          </div>
        </div>

        <AgentPromptSetupPicker />

        <div className="card connect-demo__card connect-demo__spec">
          <h3>
            <ShieldCheck size={17} strokeWidth={1.85} />
            <span>Connect with Parlor 安全设计规范</span>
          </h3>
          <ul className="hint connect-demo__list">
            <li>单次授权原则：凭证 10 分钟自动过期，使用一次即废弃。</li>
            <li>最小披露保证：第三方无法获取用户邮箱凭据或全量日历，数据由本机网关过滤后签发。</li>
            <li>不可篡改核验：授权凭证由用户本机私钥签名绑定，数据哈希严格一致方可使用。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
