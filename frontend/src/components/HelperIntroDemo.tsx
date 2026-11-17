// 本机助手演示（stageshow）：给「本机助手没装 / 被浏览器拦住」空状态看的
// 假产品动画 —— 本机助手窗口探测到 Claude Code 和 Codex，点「加入」，Agent
// 飞进加密房间的成员列表。循环播放；减弱动态时显示海报帧。
// 用 kit 的 Stage/Window/Row/Button/Collapse/Fly；不画真实 Agent 的商标。

import { Check, Cloud, Lock, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge, Bar, Button, Collapse, Fly, Row, Stage, Text, Window, type Act, type Layout, type Rect } from '../lib/stageshow'
import './HelperIntroDemo.css'

type Join = 'idle' | 'busy' | 'done'
type Flight = { which: 'a' | 'b'; from: Rect; to: Rect; go: boolean }

interface S {
  joinA: Join // Claude Code
  joinB: Join // Codex
  inRoomA: boolean // 成员列表里给它开出行位
  inRoomB: boolean
  landedA: boolean // 飞行结束，真实成员行显示出来
  landedB: boolean
  fly: Flight | null
}

const INITIAL: S = { joinA: 'idle', joinB: 'idle', inRoomA: false, inRoomB: false, landedA: false, landedB: false, fly: null }
// 海报帧：一个 Agent 已经坐进房间 —— 结果一眼即懂
const POSTER: S = { ...INITIAL, joinA: 'done', inRoomA: true, landedA: true }

// 两个设计共用一套 target 名，脚本量出来的就是当前布局下的位置
const GEO = {
  wide: {
    agents: { left: 18, top: 14, width: 368, height: 388 },
    room: { left: 412, top: 42, width: 230 },
    rest: { x: 210, y: 318 },
  },
  compact: {
    agents: { left: 12, top: 12, width: 316, height: 286 },
    room: { left: 12, top: 310, width: 316 },
    rest: { x: 168, y: 262 },
  },
} as const

async function script(a: Act<S>) {
  const join = async (which: 'a' | 'b') => {
    const btn = `join-${which}`
    const mid = `mid-${which}`
    const joinKey = which === 'a' ? 'joinA' : 'joinB'
    const roomKey = which === 'a' ? 'inRoomA' : 'inRoomB'
    const landedKey = which === 'a' ? 'landedA' : 'landedB'

    a.mark(btn)
    await a.click({ at: btn, x: 0.8, y: 0.5 })
    await a.set({ [joinKey]: 'busy' } as Partial<S>)
    await a.wait(700)

    // 终点：成员列表第一行里那个人的名字格（此时行还合着，量的是布局位）
    const to = a.rect(mid, { layout: true })
    const src = a.rect(btn)
    const from = {
      x: src.x + src.width / 2 - to.width / 2,
      y: src.y + src.height / 2 - to.height / 2,
      width: to.width,
      height: to.height,
    }
    await a.set({ fly: { which, from, to, go: false } })
    await a.wait(220)
    // 同一帧：行位展开 + 名字条飞过去
    await a.set((s) => ({ [roomKey]: true, fly: s.fly && { ...s.fly, go: true } } as Partial<S>))
    await a.wait(950)
    await a.set({ fly: null, [landedKey]: true, [joinKey]: 'done' } as Partial<S>)
  }

  await a.wait(900)
  await join('a')
  await a.wait(1500)
  await join('b')
  await a.wait(2200) // 收获帧：两个 Agent 都在房间里

  // 收口：后进的先退，按钮退回「加入」，光标回休息点 —— 接得上循环开头
  a.mark('reset')
  await a.move({ wide: GEO.wide.rest, compact: GEO.compact.rest })
  await a.set({ joinB: 'idle', inRoomB: false, landedB: false })
  await a.wait(140)
  await a.set({ joinA: 'idle', inRoomA: false, landedA: false })
  await a.wait(900)
}

function JoinButton({ target, state }: { target: string; state: Join }) {
  return (
    <Button
      variant="primary"
      size="small"
      icon={state === 'done' ? <Check size={11} strokeWidth={3} /> : undefined}
      data-target={target}
      data-state={state}
      className="hid-join"
    >
      {state === 'done' ? '已加入' : state === 'busy' ? '加入中…' : '加入'}
    </Button>
  )
}

function AgentRow({ icon, name, meta, button }: { icon: ReactNode; name: string; meta: string; button: ReactNode }) {
  return (
    <Row
      pad={10}
      lead={<span className="hid-ico">{icon}</span>}
      title={<Text>{name}</Text>}
      subtitle={<Text className="hid-sub">{meta}</Text>}
    >
      {button}
    </Row>
  )
}

// 房间成员行里的「名字块」：点 + 名 + Agent 小牌。飞行克隆的是同一整块，
// 落地后真实成员行里的同一块接棒显示（data-landed 才出现）。
function MemberId({ name, target, landed }: { name: string; target?: string; landed?: boolean }) {
  return (
    <span className="hid-mid" data-target={target} data-landed={target === undefined || landed || undefined}>
      <i className="hid-dot" data-kind={target === undefined ? 'human' : 'agent'} />
      <b>{name}</b>
      {target !== undefined && <i className="hid-tag">Agent</i>}
    </span>
  )
}

export function HelperIntroDemo({ accent = '#0071e3' }: { accent?: string } = {}) {
  return (
    <div className="helper-intro">
      <Stage<S>
        width={660}
        height={340}
        compact={{ below: 560, width: 340, height: 470 }}
        initial={INITIAL}
        poster={POSTER}
        script={script}
        accent={accent}
        tokens={{ '--ss-success': '#1d8348', '--ss-surface': '#ffffff' }}
        cursor={{ at: { wide: GEO.wide.rest, compact: GEO.compact.rest }, style: 'real', ripple: true }}
        className="hid"
      >
        {(s, _rect, layout: Layout) => {
          const g = layout === 'compact' ? GEO.compact : GEO.wide
          return (
            <>
              {/* 本机助手窗口：探测到的 Agent 列表 */}
              <Window title="本机助手" className="hid-agents" style={{ left: g.agents.left, top: g.agents.top, width: g.agents.width, height: g.agents.height }}>
                <div className="hid-agents__head">
                  <Text className="hid-sec">这台电脑上的 Agent</Text>
                  <Badge tone="success" dot>
                    在线
                  </Badge>
                </div>
                <div className="hid-agents__list">
                  <AgentRow
                    icon={<SquareTerminal size={14} strokeWidth={1.75} />}
                    name="Claude Code"
                    meta="2.1.325 · claude-code"
                    button={<JoinButton target="join-a" state={s.joinA} />}
                  />
                  <AgentRow
                    icon={<SquareTerminal size={14} strokeWidth={1.75} />}
                    name="Codex"
                    meta="0.166.0 · codex"
                    button={<JoinButton target="join-b" state={s.joinB} />}
                  />
                  <AgentRow
                    icon={<Cloud size={14} strokeWidth={1.75} />}
                    name="Grok"
                    meta="云端接口 · grok"
                    button={
                      <Button variant="secondary" size="small">
                        加入
                      </Button>
                    }
                  />
                  <Row pad={10} lead={<Bar w={26} h={26} r={7} shrink={false} tone={2} />} title={<Bar w={96} />} subtitle={<Bar w={140} />} />
                  <Row pad={10} lead={<Bar w={26} h={26} r={7} shrink={false} tone={2} />} title={<Bar w={118} />} subtitle={<Bar w={104} />} />
                  <Row pad={10} lead={<Bar w={26} h={26} r={7} shrink={false} tone={2} />} title={<Bar w={84} />} subtitle={<Bar w={128} />} />
                </div>
              </Window>

              {/* 加密房间的成员列表：加入的 Agent 落在这里 */}
              <div className="hid-card" style={{ left: g.room.left, top: g.room.top, width: g.room.width }}>
                <div className="hid-card__head">
                  <Lock size={11} strokeWidth={2} className="hid-lock" />
                  <Text className="hid-room-name">项目讨论</Text>
                  <span className="hid-room-side">成员</span>
                </div>
                <div className="hid-card__list">
                  <Collapse open={s.inRoomB}>
                    <Row pad={7} title={<MemberId name="Codex" target="mid-b" landed={s.landedB} />} />
                  </Collapse>
                  <Collapse open={s.inRoomA}>
                    <Row pad={7} title={<MemberId name="Claude Code" target="mid-a" landed={s.landedA} />} />
                  </Collapse>
                  <Row pad={7} title={<MemberId name="我" />} />
                  <Row pad={7} title={<MemberId name="林蔚" />} />
                  <Row pad={7} title={<MemberId name="周舟" />} />
                  <Row pad={7} title={<Bar w={72} />} />
                </div>
              </div>

              {/* 飞行中的「名字块」：从被按下的按钮上长出来，飞进成员行 */}
              {s.fly && (
                <Fly from={s.fly.from} to={s.fly.to} go={s.fly.go} held duration={760}>
                  <span className="hid-mid hid-mid--fly" data-landed>
                    <i className="hid-dot" data-kind="agent" />
                    <b>{s.fly.which === 'a' ? 'Claude Code' : 'Codex'}</b>
                    <i className="hid-tag">Agent</i>
                  </span>
                </Fly>
              )}
            </>
          )
        }}
      </Stage>
    </div>
  )
}
