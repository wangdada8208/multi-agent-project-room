import { ArrowRight, ArrowUpRight, Laptop, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useLocalAgents } from "../../hooks/agents/useLocalAgents";
import { AGENT_PRESETS } from "../../lib/agentPresets";
import { TRUST_TIER_LABEL, trustTierOf, type SeatViewLocal } from "../../lib/localHelper";
import { CopyButton } from "../CopyButton";
import { HelperLink } from "../HelperLink";
import { XmtpUnlock } from "../XmtpUnlock";
import { Button } from "../ui/Button";
import { ConfirmInline } from "../ui/ConfirmInline";
import { Tag } from "../ui/Tag";
import { HelperStatusStrip } from "./HelperStatusStrip";
import { LocalAgentCard } from "./LocalAgentCard";
import { PairingGuide } from "./PairingGuide";

const seatStatus = { starting: "启动中", running: "运行中", crashed: "已异常退出", stopped: "已停止", revoked: "已吊销" };

export function LocalAgentSection({ roomId, hubOrigin, ownerXmtpAddress, onJoined, legacyMobile = false, onManage }: {
  roomId: string;
  hubOrigin: string;
  ownerXmtpAddress?: string;
  onJoined?: (seat: SeatViewLocal) => void;
  legacyMobile?: boolean;
  onManage?: () => void;
}) {
  const local = useLocalAgents({ roomId, hubOrigin, ownerXmtpAddress, onJoined, legacyMobile });
  const [confirmSeat, setConfirmSeat] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const paired = local.isHelperReadyAndPaired && local.probe?.state === "running" ? local.probe.hello : undefined;
  const guide = {
    mobile: local.isMobile, pairing: local.pairing, error: local.pairingError, hubOrigin,
    onGenerate: () => local.ensurePairing(true),
  };
  const PresetArrow = local.presetDecision === "open-helper" ? ArrowUpRight : ArrowRight;

  async function leave(seat: SeatViewLocal) {
    if (leaving) return;
    setLeaving(true);
    try {
      await local.leaveSeat(seat);
      setConfirmSeat(undefined);
    } finally {
      setLeaving(false);
    }
  }

  return <section className="wb-local">
    <div className="wb-agents-section-head"><h2>在电脑上运行的助手</h2><Tag>需要电脑</Tag></div>
    {paired || (!local.probe && !local.pendingPreset && !local.isMobile) ? <HelperStatusStrip
      version={paired?.version} device={local.helpers.find((helper) => helper.id === local.helperPick)?.device_name ?? paired?.owner_display_name ?? undefined}
      onManage={onManage} onRescan={() => void local.handleManualRescan()} rescanning={local.rescanning} />
      : <div id="install-pair-section" ref={local.pairingSectionRef}>
        <PairingGuide {...guide} running={local.probe?.state === "running"} notice={local.guideNotice}
          action={local.pendingPresetAction} highlighted={local.highlightStepOne} />
      </div>}
    {paired && local.pendingPreset && local.pendingPresetAction && <div className="wb-notice" role="status" ref={local.presetContinueRef}>
      <p>电脑助手已就绪，可以继续配置「{local.pendingPreset.label}」。</p>
      <HelperLink className="ui-button ui-button--primary ui-button--sm" action={local.pendingPresetAction}>继续一键配置 <ArrowUpRight size={14} /></HelperLink>
      <Button variant="ghost" size="sm" onClick={local.clearPreset}>关闭提示</Button>
    </div>}
    {paired?.hub_origin && paired.hub_origin !== hubOrigin && <p className="wb-error" role="alert">本机助手当前配对的服务器为 {paired.hub_origin}，与当前站点不一致。</p>}
    {local.helpers.length > 1 && <label className="wb-target">执行任务的电脑
      <select value={local.helperPick} onChange={(event) => local.setHelperPick(event.target.value)}>
        {local.helpers.map((helper) => <option key={helper.id} value={helper.id}>{helper.device_name}</option>)}
      </select>
    </label>}
    {local.pendingJoin && <section className="wb-local-detail">
      <XmtpUnlock onUnlock={local.unlockForJoin} />
      <Button variant="ghost" size="sm" onClick={local.cancelJoin}>取消</Button>
    </section>}
    {(local.joinError || local.listError) && <p className="wb-error" role="alert">{local.joinError || local.listError}</p>}
    {local.joinedSeat && <div className="wb-notice" role="status">
      助手已启动。进入房间后，房主设备会让它看到加密聊天。
      <Link to={`/rooms/${encodeURIComponent(local.joinedSeat.roomId)}`}>进入房间 <ArrowRight size={14} /></Link>
    </div>}
    <div className="wb-local-grid">
      {AGENT_PRESETS.filter((item) => item.mode === "local-cli").map((item) => {
        const agent = local.agents.find((candidate) => candidate.key === item.cliKey);
        const seated = local.activeSeatKeysInSelectedRoom.has(item.cliKey);
        return <LocalAgentCard item={item} key={item.id}>
          <p>{seated ? "已在当前房间" : agent?.loginState === "needs-login" ? "请先在终端登录" : agent ? "已检测到" : paired ? "未检测到" : "配对后检测"}</p>
          {paired && agent ? !seated && <Button variant="secondary" size="sm" disabled={!roomId || Boolean(local.joiningKey) || agent.loginState === "needs-login"}
            onClick={() => local.startJoin(agent.key)}>{local.joiningKey === agent.key ? "正在加入…" : "加入房间"}</Button>
            : <details className="wb-local-install"><summary>查看安装命令</summary><code>{item.installCmd}</code><CopyButton text={item.installCmd} label="复制命令" /></details>}
        </LocalAgentCard>;
      })}
      <LocalAgentCard title="OpenClaw" subtitle="命令行助手">
        <p>在电脑助手中添加命令行助手。</p>
        <details className="wb-local-install"><summary>查看接入方式</summary>
          <p>先在电脑安装 OpenClaw，再在电脑助手里选择「命令行助手」并配置 OpenClaw 命令。</p>
          {paired && <HelperLink className="ui-button ui-button--secondary ui-button--sm" action="console">打开电脑助手</HelperLink>}
        </details>
      </LocalAgentCard>
      {AGENT_PRESETS.filter((item) => item.mode === "helper-preset").map((item) => <LocalAgentCard item={item} key={item.id}>
        <p>{item.id === "xai-api" ? "密钥只保存在你的电脑" : item.id === "ollama" ? "模型在你的电脑上运行" : "连接你已有的云端服务"}</p>
        <Button variant="secondary" size="sm" onClick={() => local.openPresetConfig(item.helperPreset, item.title)}>一键配置并接入 <PresetArrow size={14} /></Button>
      </LocalAgentCard>)}
      <LocalAgentCard title="连接另一台电脑" subtitle="设备配对">
        <Button size="sm" variant="secondary" onClick={() => local.setExpandAnotherComputer(!local.expandAnotherComputer)}><Plus size={14} />{local.expandAnotherComputer ? "收起配对指南" : "获取配对命令"}</Button>
      </LocalAgentCard>
    </div>
    {local.expandAnotherComputer && <PairingGuide {...guide} secondary />}
    {paired && local.agents.some((agent) => !["claude-code", "codex", "gemini-cli"].includes(agent.key)) && <section className="wb-local-detail">
      <h3>这台电脑上的其他助手</h3>
      {local.agents.filter((agent) => !["claude-code", "codex", "gemini-cli"].includes(agent.key)).map((agent) => <div className="wb-seat" key={agent.key}>
        <div className="wb-seat__info"><strong>{agent.displayName}</strong><small>{TRUST_TIER_LABEL[trustTierOf(agent.kind)]}</small></div>
        {local.activeSeatKeysInSelectedRoom.has(agent.key) ? <Tag tone="ok">已在当前房间</Tag>
          : <Button size="sm" variant="secondary" disabled={!roomId || Boolean(local.joiningKey)} onClick={() => local.startJoin(agent.key)}>加入房间</Button>}
      </div>)}
    </section>}
    {local.activeSeatsForDisplay.length > 0 && <section className="wb-local-detail">
      <h3>这台电脑上的助手</h3>
      {local.activeSeatsForDisplay.map((seat) => <article className="wb-seat" key={seat.seatId}>
        <Laptop size={17} />
        <div className="wb-seat__info"><strong>{local.agents.find((agent) => agent.key === seat.agentKey)?.displayName ?? seat.agentKey}</strong>
          <small>{seat.roomName} · {seatStatus[seat.status]}{seat.lastError ? ` · ${seat.lastError}` : ""}</small>
        </div>
        <Link to={`/rooms/${encodeURIComponent(seat.roomId)}`}>进入房间</Link>
        {confirmSeat === seat.seatId ? <ConfirmInline confirmLabel="移出" loading={leaving} onCancel={() => setConfirmSeat(undefined)} onConfirm={() => void leave(seat)}>
          移除此助手。已经能看到加密聊天的助手，需要在房间内移除。
        </ConfirmInline> : <Button variant="danger" size="sm" disabled={leaving} onClick={() => setConfirmSeat(seat.seatId)}>移出</Button>}
      </article>)}
    </section>}
  </section>;
}
