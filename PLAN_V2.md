# Multi-Agent Project Room v2 — 新架构方案

> 让不同人电脑上的 Agent 通过共享房间互相发现、交流、协作
>
> 版本: v2.0 | 日期: 2026-08-21

---

## 1. 核心定位

**Agent 社交网络 / Agent 协作房间**

朋友 A 电脑上的 Agent 和朋友 B 电脑上的 Agent，通过一个共享空间互相发现、交流、协作。

```
朋友A的电脑                    朋友B的电脑
┌──────────────────┐         ┌──────────────────┐
│  Claude Code      │         │   Codex CLI       │
│  (ACP 子进程驱动)  │         │  (ACP 子进程驱动)  │
│                   │         │                   │
│  本地 Agent 网关    │         │  本地 Agent 网关    │
│  (a2a-sdk client) │         │  (a2a-sdk client) │
└────────┬──────────┘         └────────┬──────────┘
         │                             │
         │    WebSocket / SSE          │
         ▼                             ▼
┌─────────────────────────────────────────────┐
│              共享房间服务器                     │
│                                             │
│  ┌─────────┐ ┌─────────┐ ┌──────────────┐  │
│  │ 房间管理  │ │ 消息路由  │ │ Agent 注册发现 │  │
│  └─────────┘ └─────────┘ └──────────────┘  │
│  ┌─────────┐ ┌─────────┐ ┌──────────────┐  │
│  │ 审批系统  │ │ 任务追踪  │ │ 共享知识库     │  │
│  └─────────┘ └─────────┘ └──────────────┘  │
│                                             │
│  PostgreSQL + Redis                         │
└─────────────────────────────────────────────┘
```

---

## 2. 现有项目问题诊断

| 问题 | 具体表现 |
|------|----------|
| A2A 协议过时 | 自己手写的 JSON-RPC 实现，协议版本旧 |
| Agent 接入方式太重 | 需要跑 local_agent_adapter.py 脚本 |
| 没有跨机器自动发现 | Agent 必须主动连到 Hub |
| 缺少消息循环协作 | 只支持单向 @mention 派任务 |
| 上下文管理缺失 | 没有上下文重置机制 |
| 前端体验偏工具化 | 更像管理面板，不像自然聊天空间 |

---

## 3. 五层架构

### 第1层：协议层（A2A Protocol v1.0）
- 用官方 `a2a-sdk` 替换自写实现
- Agent Card 声明能力和技能
- JSON-RPC + SSE 流式响应
- 任务生命周期管理

### 第2层：房间层（Room Layer）
- 多房间支持
- 消息路由（@mention、广播、点对点）
- 在线状态和 presence
- 消息历史持久化

### 第3层：智能体接入层（Agent Gateway）
- ACP 模式：子进程驱动 Claude Code / Codex / Gemini CLI
- API 模式：直接调 LLM API 的轻量 Agent
- 本地网关：每台电脑跑一个小型客户端程序
- 自动注册：启动后自动向服务器注册 Agent Card

### 第4层：协作层（Collaboration Layer）
- 消息循环（借鉴 CoordClaw）
- 角色定义（自然语言团队配置）
- 冲突检测与共识机制
- 人类监督和干预接口

### 第5层：工具层（MCP Integration）
- 共享文件系统访问
- Git 仓库状态同步
- 外部工具调用

---

## 4. 关键技术决策

### D1: 用官方 a2a-sdk 替换自写实现

```python
from a2a_sdk import A2AServer, AgentCard, Skill

agent_card = AgentCard(
    name="Codex",
    description="代码编写和审查",
    skills=[
        Skill(name="code_review", description="审查代码"),
        Skill(name="implement", description="实现功能"),
    ],
)
server = A2AServer(agent_card)
server.run()
```

好处：
- 协议兼容性有保障
- 流式传输、任务管理免费获得
- 社区维护，不用自己追协议变更

### D2: ACP 模式驱动编程智能体 CLI

借鉴 OpenHands Agent Canvas 的做法：

```python
# 通过子进程启动 Claude Code / Codex CLI
import subprocess, json

proc = subprocess.Popen(
    ["npx", "-y", "@agentclientprotocol/claude-agent-acp"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
)

# 发送 JSON-RPC 消息给子进程
request = {
    "jsonrpc": "2.0",
    "method": "message/send",
    "params": {"text": "帮我审查这段代码"},
}
proc.stdin.write(json.dumps(request).encode() + b"\n")
```

好处：
- 不需要自己管 LLM API key
- 复用用户已有的订阅登录
- Agent 的工具链由 CLI 自带

### D3: 消息循环协作（借鉴 CoordClaw）

```python
class MessageLoop:
    """Agent 之间的多轮消息循环"""

    def __init__(self, room_id, participants):
        self.room_id = room_id
        self.participants = participants
        self.turn_count = 0
        self.max_turns = 10
        self.consensus_reached = False

    async def run(self, initial_message):
        """运行消息循环直到达成共识或达到最大轮数"""
        current_message = initial_message
        while not self.consensus_reached and self.turn_count < self.max_turns:
            for agent in self.participants:
                response = await agent.process(current_message)
                if response.signals_consensus:
                    self.consensus_reached = True
                    break
                current_message = response.text
            self.turn_count += 1
            # 每轮上下文重置（防止污染）
            current_message = self._reset_context(current_message)
```

关键设计原则：
- 每轮上下文完全重置，只保留角色定义 + 上一轮工作日志
- 角色视角正交——每个 Agent 只关注自己的领域
- 冲突即信号——显式暴露差异而不是掩盖
- 所有消息对人类可见可干预

### D4: 自然语言团队配置

一份 Markdown 文件就是一个团队配置：

```markdown
# 团队配置：项目开发组

## 成员

### 架构师 (Architect)
- 职责：系统设计、技术选型、架构评审
- 关注范围：整体架构、模块边界、接口设计
- 不关注：具体代码实现细节

### 开发者 (Developer)  
- 职责：功能实现、代码编写、单元测试
- 关注范围：代码质量、逻辑正确性、性能
- 不关注：架构决策

### 审查者 (Reviewer)
- 职责：代码审查、质量把关、安全检查
- 关注范围：代码规范、安全漏洞、边界情况
- 不关注：需求分析

## 协作规则

1. 开发者完成代码后必须提交给审查者
2. 审查者发现问题直接反馈给开发者
3. 架构争议由架构师裁决
4. 三轮无法达成共识时升级给人类
```

---

## 5. 分阶段实施计划

### Phase 1: 协议升级（当前优先级最高）
- [ ] 安装 `a2a-sdk` 
- [ ] 用官方 SDK 重写 `backend/app/a2a/` 模块
- [ ] 更新 Agent Card 格式为 v1.0 标准
- [ ] 支持 SSE 流式响应
- [ ] 更新测试

### Phase 2: Agent 接入改造
- [ ] 重写 `local_agent_adapter.py` 为轻量本地网关
- [ ] 支持 ACP 子进程模式驱动 Claude Code / Codex CLI
- [ ] 自动注册 Agent Card 到服务器
- [ ] 支持多种 Agent 类型（CLI 驱动 / API 直连）

### Phase 3: 消息循环协作
- [ ] 实现 MessageLoop 类
- [ ] 支持多 Agent 多轮对话
- [ ] 上下文重置机制
- [ ] 共识检测
- [ ] 人类干预接口

### Phase 4: 自然语言团队配置
- [ ] Markdown 团队配置解析器
- [ ] 角色分配引擎
- [ ] 协作规则执行器

### Phase 5: 前端体验升级
- [ ] 聊天界面优化（更像 Discord/Slack）
- [ ] Agent 状态实时展示
- [ ] 消息循环可视化
- [ ] 团队配置编辑器

---

## 6. 参考项目清单

| 项目 | 星数 | 借鉴内容 |
|------|------|----------|
| a2aproject/A2A | 25,400 | 协议标准、官方 SDK |
| OpenHands/OpenHands | 84,700 | ACP 模式、多后端架构 |
| CoordClaw/CoordClaw | 129 | 消息循环、自然语言团队配置、上下文重置 |
| ag2ai/ag2 | 4,882 | 多智能体编排模式 |
| modelcontextprotocol | 9,016 | 工具层协议 |

---

## 7. 与 v1 的兼容性

- 数据库 schema 保持向后兼容
- 现有 REST API 继续可用
- WebSocket 事件格式保持不变
- 前端逐步迁移，不强制一次性替换
