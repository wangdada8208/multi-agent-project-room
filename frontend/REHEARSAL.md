# HelperIntroDemo 彩排记录（REHEARSAL）

演示：`frontend/src/components/HelperIntroDemo.tsx`
用途：「我的 Agent」页里，本机助手没装 / 被浏览器拦住两个空状态的假产品动画。
日期：2026-11-17（在后台子代理环境中完成，未能跑构建与胶片工具）

## 故事板（loop，约 13 秒）

1. 开场（0–0.9s）：静止帧。左边「本机助手」窗口列出 Claude Code、Codex、Grok，每行一个「加入」按钮；右边加密房间「项目讨论」的成员卡只有我/林蔚/周舟和一条占位行。光标停在窗口内的休息点。
2. 加入 Claude Code（0.9–3.5s）：光标移到「加入」，按下（涟漪），按钮变「加入中…」，停顿后名字块（点+名+Agent 牌）从按钮处长出来（held），飞进成员列表第一行；行位同时用 Collapse 展开。落地帧真实成员行显示、飞块卸载、按钮变绿「已加入」。
3. 加入 Codex（5–7.6s）：同样流程，落在新开出的第一行（后进的在上面）。
4. 收获帧（7.6–9.8s）：两个 Agent 都在成员列表里，两个按钮都是「已加入」。
5. 收口（9.8–13s）：光标移回休息点；Codex 行先合、按钮退回「加入」，140ms 后 Claude Code 同样退回；静 0.9s 后循环。结束态与初始态完全一致（checkSeam 通过所需条件已按代码确认）。

海报帧（reduced motion / 截图）：`POSTER` = Claude Code 已在成员列表里、按钮「已加入」。结果一眼即懂。

## 布局

- 宽：660×340。左「本机助手」窗口 368×388（下缘流出画面下载切），右成员卡 230 宽悬在右上方。面板可用宽约 608–700px，Stage 按比例缩小到容器。
- 窄（容器 <560px）：340×470，上下叠放；窗口在上，成员卡在下，成员行从顶部往下裁切。
- 两个布局共用一套 data-target 名（join-a/join-b/mid-a/mid-b），飞行起终点由脚本实时量取。

## 已完成的核对（静态审查）

- kit 拷贝完整性：30 个文件，act/stage/measure/util/reduced-motion/looks/ease/clock/keys/cursor(s)/window/Row/Avatar/Button/Badge/Collapse/Fly/Roll 及配套 CSS；index.ts 只导出用到的子集。
- 导入/导出逐项对齐：stage.tsx、act.ts、index.ts、各部件的 import 均能在拷入文件中找到导出（逐文件对照过）。
- 组件 API 核对：Button(variant/size/icon/data-*)、Badge(tone/dot)、Row(lead/title/subtitle/pad/children)、Bar(w/h/r/tone/shrink)、Text(children:string)、Fly(from/to/go/held/duration)、Collapse(open)、Window(title/className/style)、Stage(全部 props) 均按拷入的源码签名使用。
- Fly 尺寸约束：飞块与落地 `mid-*` 是同一整块标记（点+名+Agent 牌），from 取按钮中心的同名块尺寸、to 取合起状态下 mid 的布局位（layout:true），无 padding/背景，避免尺寸警告与落地跳位。
- 收口缝：脚本结束状态 = INITIAL；光标回到 cursor.at 的同一坐标对象。
- 空闲淡出：首次移动约发生在 1.3s（wait 900 + move ≈300-500），低于默认 idle 4000ms。
- reduced-motion：data-still 下无过渡动画，poster 直接呈现加入完成态。

## 无法在本环境验证（需要前台执行）

- `npm run build` / `npx tsc --noEmit`：命令被后台权限拒绝，未跑。静态审查替代。
- `npm test`：同上，未跑。
- stageshow preview / film --gate / --at：依赖 npm 与浏览器，未跑。
- 实际视觉帧：未出图。以下风险只能靠真跑确认：
  - Collapse 合起时 `layoutRectOf` 量到的 mid 位置是否正好是展开后的落点（预期是，因为它在列表第一项，展开不改变自己的位置）。
  - 宽布局下成员卡高度、窄布局裁切位置是否合适。
  - 光标的「真实指针」在 indigo 主题下是否清楚；必要时改 `cursor.style: 'arrow'`。
  - `.hid` 地台的边框/投影在 `.agent-panel` 白底上是否太弱/太重。

## 已知简化

- `cursors.tsx` 的 `MacGrab` 用了简化闭合路径（原文件单行超长无法完整读出）；本演示不会出现 grab 光标，无影响。
- 未拷贝 brand/phone/chart 等无关部件（kit 100+ 文件中只取依赖闭包 30 个）。
- 第三个 Agent（Grok，云端接口）的「加入」按钮是静态的，脚本只点前两个。

## 前台验证清单（建议）

```bash
cd frontend
npm run build          # 编译检查
npm test               # 现有测试不回归
# 视觉彩排：
npm run dev            # 打开 /agents（未装本机助手的状态）看两处空状态里的演示
# 若装了 stageshow CLI：preview + film --gate，重点看 fly 落点与循环缝
```
