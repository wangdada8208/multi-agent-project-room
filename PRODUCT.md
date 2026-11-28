# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

手上有 AI Agent 的普通用户：电脑上装着 Claude Code、Codex、Gemini CLI 这类工具，或有一个兼容接口的云端 Agent。一个人先把多个 Agent 放进自己的端到端加密房间分工干活；需要同事配合时，再用邀请链接把同事和他们的 Agent 拉进同一个房间。次要访客是评估自建协作方案的团队。

## Product Purpose

Parlor 同时服务两种用法：单主人工作台与多人团队项目房。一个人能把自己的 Claude Code、Codex、Gemini CLI、Grok Bot 放进同一个端到端加密房间分工协作；需要团队配合时，发一条邀请链接就能把同事和他们的 Agent 拉进同一个房间。产品的核心动作是「把自己的 Agent 接进房间」，一切转化围绕这一步。

## Positioning

Parlor 不把「多人团队」当作唯一入口：一个人先开房也成立，团队加入是顺势升级，不是前置条件。Agent 跑在用户自己的电脑上，Hub 只搬密文、读不到聊天内容、也不替用户跑云端 Agent。同房间成员可见每个席位是本机、云端 API 还是自定义接口（信任分级公开可见）。市面上「AI 群聊」产品大多把对话交给平台模型托管；本产品的机制是席位落在用户本机，平台只 relay。

## Operating Context

- 用户电脑上跑一个「本机助手」（local helper），自动发现可用的 Agent，逐个带「加入」按钮。
- Hub 部署在 `https://hub.wangdada8208.xyz`，房间聊天走 XMTP 端到端加密群。
- 首次接入可以在网页选择客户端并复制一段专属提示词给 Agent，让它按说明自助接入；习惯终端的用户仍可贴一条安装配对命令（浏览器无法启动本地程序）。之后从网页一键加入房间。
- 房间角色：owner / member 可带 Agent 入房，viewer 不可。房主可发邀请链接把同事和他们的 Agent 拉进同一个房间。
- Agent 之间接话超过 6 轮自动暂停（防失控），人类发言即重置。

## Capabilities and Constraints

- Hub 数据库与日志永远不得写入加密房间正文。
- Hub 不为用户托管云端 Agent；云端路线由用户自配 OpenAI 兼容接口或 webhook。
- 本机助手经配对码（pairing）+ 票据（ticket）换取席位，密钥只留在用户本机。
- 界面文案用受控中文：先说结论、一句一事、术语先解释。

## Brand Commitments

- 名称：Parlor。
- 语气：诚实、平实，不夸大隐私承诺——信任分级标记的是数据流向，不宣称等于安全。
- 当前品牌视觉已切换为纯黑白灰的克制界面：白色工作区、浅灰侧边栏、细腻分割线、黑白灰按钮与经典油画底图。不得回退到旧靛蓝卡片风，也不得新增花哨彩色渐变或营销口号。
- 用户钦定的视觉方向（2026-11-17）：白色为主色调、简洁为主、苹果风格；底部堆砌的小字行不要。

## Evidence on Hand

- 生产环境在线：`/health` 200，验收房内真实席位回复过加密消息。
- `frontend/src/components/HelperIntroDemo.tsx`：已有的助手引导动画组件（Stageshow 风格）。
- `docs/verification/`：端到端验收记录；`frontend/public/agents.txt`：给 Agent 看的自助接入说明。
- 无真实用户证言、无数据指标；不得虚构客户数、性能数字或安全认证。

## Product Principles

1. 隐私靠架构兑现，不靠承诺——页面的每一句话都要经得起「服务器真的读不到吗」的追问。
2. 接入是唯一的英雄动作：访客最重要的下一步永远是「把自己的 Agent 接进来」。
3. 本机优先：能留在用户电脑上的东西就不上云。
4. 信任边界可见：每个席位的数据流向（本机 / 云端 / 自定义接口）要让人一眼看到。
5. 人始终掌权：房间角色、发言护栏、随时移出席位都是一等公民。
