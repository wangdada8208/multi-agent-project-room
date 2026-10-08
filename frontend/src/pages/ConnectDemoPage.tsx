import React, { useState } from "react";
import { Plane, Receipt, Shield, CheckCircle2, AlertCircle } from "lucide-react";
import { ConnectButton } from "../components/ConnectButton";

export function ConnectDemoPage() {
  const [calendarResult, setCalendarResult] = useState<any>(null);
  const [receiptResult, setReceiptResult] = useState<any>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mx-auto max-w-4xl space-y-8">
        {/* Header */}
        <header className="border-b border-slate-800 pb-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-600 text-white shadow-lg shadow-sky-500/20">
                  <Plane className="h-5 w-5" />
                </div>
                <h1 className="text-2xl font-bold tracking-tight">SkyTrip 差旅智能助手</h1>
              </div>
              <p className="mt-2 text-sm text-slate-400">
                第三方应用接入示范 — 通过 Connect with MAPR 按钮实现单次授权与隐私安全数据代取
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-950/40 px-3 py-1.5 text-xs text-sky-300">
              <Shield className="h-3.5 w-3.5" />
              <span>MAPR Connect 协议 v1</span>
            </div>
          </div>
        </header>

        {errorMsg && (
          <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-950/40 p-4 text-sm text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Integration Demos Grid */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* Calendar Free/Busy Demo */}
          <div className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-sm">
            <div>
              <div className="flex items-center gap-2 text-sky-400">
                <Plane className="h-4 w-4" />
                <h2 className="font-semibold text-slate-200">差旅航班时间匹配</h2>
              </div>
              <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                申请获取您下周的日程忙闲区间（仅起止时段，完全剥离会议标题、备注与私密联系人）。
              </p>

              <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs text-slate-400">嵌入式授权组件：</div>
                <div className="mt-3">
                  <ConnectButton
                    appId="skytrip-app"
                    scope="calendar.free_busy"
                    purpose="查询空闲时间以智能匹配差旅航班"
                    constraints={{ date_from: "2026-10-05", date_to: "2026-10-09" }}
                    buttonText="授权读取忙闲 (Connect with MAPR)"
                    onSuccess={(res) => {
                      setCalendarResult(res);
                      setErrorMsg(null);
                    }}
                    onError={(err) => setErrorMsg(err.message)}
                  />
                </div>
              </div>
            </div>

            {calendarResult && (
              <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-4 text-xs text-emerald-300">
                <div className="flex items-center gap-1.5 font-medium">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>授权通过：已获取忙闲时段</span>
                </div>
                <div className="mt-2 text-slate-300">
                  授权凭据 ID: <code className="text-emerald-400">{calendarResult.grant?.grant_id}</code>
                </div>
                <div className="mt-1 text-slate-300">
                  忙碌时段数: {calendarResult.payload?.busy?.length || 0} 个
                </div>
              </div>
            )}
          </div>

          {/* Email Receipt Demo */}
          <div className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-sm">
            <div>
              <div className="flex items-center gap-2 text-sky-400">
                <Receipt className="h-4 w-4" />
                <h2 className="font-semibold text-slate-200">电子客票自动报销</h2>
              </div>
              <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                申请检索 12306 铁路客票邮件（内容经过电话、邮箱脱敏清洗，附件 SHA256 哈希校验）。
              </p>

              <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs text-slate-400">嵌入式授权组件：</div>
                <div className="mt-3">
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
              </div>
            </div>

            {receiptResult && (
              <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-4 text-xs text-emerald-300">
                <div className="flex items-center gap-1.5 font-medium">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>授权通过：已提取客票凭证</span>
                </div>
                <div className="mt-2 text-slate-300">
                  主题: <span className="text-emerald-400">{receiptResult.payload?.subject}</span>
                </div>
                <div className="mt-1 text-slate-400">
                  摘要: {receiptResult.payload?.body_excerpt}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Security Disclosures */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h3 className="font-semibold text-sm text-slate-300 flex items-center gap-2">
            <Shield className="h-4 w-4 text-sky-400" />
            <span>Connect with MAPR 安全设计规范</span>
          </h3>
          <ul className="mt-3 list-disc list-inside space-y-1.5 text-xs text-slate-400">
            <li>单次授权原则：凭证 10 分钟自动过期，使用一次即废弃。</li>
            <li>最小披露保证：第三方无法获取用户邮箱凭据或日程全量日历，数据由本机网关过滤后签发。</li>
            <li>不可篡改核验：授权凭证由用户以太坊私钥签名绑定，数据哈希严格一致方可使用。</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
