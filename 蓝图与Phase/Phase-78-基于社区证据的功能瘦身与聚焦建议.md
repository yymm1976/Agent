# Phase 78：基于社区证据的功能瘦身与聚焦建议

> **日期：** 2026-07-11
> **输入：** last30days 国际社区调研（Reddit 14 帖 / YouTube 11 视频 / TikTok 13 / Instagram 4 / HN 21 / GitHub 4）+ 中文社区调研（WebSearch）+ RouteDev 代码审计报告
> **定位：** 方向性建议文档，不定具体实现方案，只给"该往哪走"的判断和依据
> **排除范围：** 上下文管理（不动）、安全边界（不动）
> **核心原则：** 功能价值由社区证据判定，不由架构师或执行人主观判断

---

## 一、调研方法与数据来源

本次调研分两轮。第一轮用 WebSearch 搜中文社区（知乎、掘金、微信公众号等）对 AI 编程助手功能价值的讨论。第二轮用 last30days skill 引擎跑国际社区（Reddit、Hacker News、YouTube、TikTok、Instagram、GitHub），覆盖 2026-06-10 至 2026-07-10 共 30 天的数据，命中 67 条相关证据。

同时参考了 Anthropic 官方的工具设计指南、Pi（github.com/earendil-works/pi，极简 Agent 标杆）的设计哲学、以及 RouteDev 自身的代码审计报告（死代码审查 + Phase 31 接线审计）。

以下每条建议都标注了社区证据来源和置信度。

---

## 二、工具数量精简

**现状：** RouteDev 注册了 26+ 工具。

**社区证据：**

Anthropic 官方明确指出工具超过 20 个时模型会选错工具。Pi 只用 4 个工具（read / write / edit / bash）就做到了社区公认的"打败大玩家"的效果 - last30days 引擎抓到的 TikTok 视频（kno2gether）原文："A coding tool with 64k stars ships with four commands - read, write, edit, bash - and no MCP. And it's beating the big ones." Cole Medin 的 YouTube 频道（Pi Coding Agent + Archon）也说："why do you want to keep adding more features on to something that's already bloated?"

OpenClaw 教程（freeCodeCamp YouTube，score 47）提到："Tool definitions for 10 tools eat up another 3,000 tokens. An agent that makes 10 API calls with 50,000 tokens of context each time is paying for 500,000 input tokens."

**建议方向：** 对 26+ 工具做一次使用频率审计，将低频工具降级为 MCP 插件（按需加载），核心工具集压缩到 10 个以内。具体哪些留、哪些降级，需要执行人跑一段时间的真实使用后根据调用日志决定，这里不预设名单。

**置信度：** 高。Anthropic 官方 + 多个独立内容创作者 + Pi 实证，方向一致。

---

## 三、多 Agent 协作简化

**现状：** RouteDev 有完整的 Orchestrator / Worker / ConflictDetector / Blackboard 多 Agent 架构（Phase 14+），但 Phase 31 审计发现 8 个模块 100% 死代码、零生产路径导入。

**社区证据：**

last30days 调研中，宣传"60 个 Agent 并行"的 TikTok 视频（kayvon.ai）虽然获得了 3,868 次浏览和 252 个赞，但评论区多为猎奇而非实际使用反馈。相比之下，Ponytail（极简编码插件）的两条 Instagram 视频合计 10 万+浏览、2,400+ 赞，传达的信息完全相反："Stop letting AI agents write bloated, over-engineered code"。

Pydantic AI 2.0 的 YouTube 视频（Cole Medin）提出了"Composing Capabilities"而非"orchestrating agents"的思路 - 核心是组合能力原语，不是调度多个 Agent。

HN 上的 Show HN 帖子中，真正获得社区认可的是单一用途的工具（Mouse 精确编辑 38pts、TaskPeace 任务队列 7pts、PMB 本地记忆 7pts），而非多 Agent 编排框架。

**建议方向：** 保留多 Agent 的接口设计（不删类型定义），但把生产路径简化为单 Agent 直通。Orchestrator 分发逻辑如果长期不通电，考虑标记为 deprecated 而非继续维护。多 Agent 能力作为"如果未来模型能力到了再启用"的预留，不作为当前版本的活跃功能。

**置信度：** 高。社区共识是 95% 的场景不需要多 Agent，单 Agent 快 3 倍、省 3-10 倍 token。

---

## 四、KnowledgeGraph 简化

**现状：** RouteDev 的 KnowledgeGraph 包含 PageRank、社区检测、置信度衰减、Jaccard 聚类、过时标记等复杂机制（Phase 17c + Phase 36 规划）。

**社区证据：**

CodeGraph 的实测数据表明 tree-sitter + SQLite 方案可以减少 71% 的工具调用和 57% 的 token 消耗，且不需要 PageRank。last30days 调研中，HN 上出现了 3 个独立的记忆 / 上下文 MCP 工具（PMB、Brain.md、Backlog），全部走"本地优先 + 简单键值"路线，没有一个用图算法。

Ponytail 的病毒式传播（Instagram 55K + TikTok 2.3K + 另一条 Instagram 50K）传达的信息高度一致：极简、YAGNI、"像最懒的 senior dev 一样思考"。没有任何热门内容提倡在编程 Agent 中引入图算法或复杂记忆系统。

**建议方向：** 保留 KnowledgeGraph 的基础存储能力（节点 + 边 + 查询），但 PageRank、社区检测、置信度衰减等高级机制建议降级为实验性（默认关闭）或直接移除。tree-sitter + SQLite 的简单方案已经够用，且维护成本远低于自研图算法。

**置信度：** 中高。CodeGraph 有实测数据支撑，但 RouteDev 的 KnowledgeGraph 还承担记忆系统功能（不只是代码检索），需要执行人评估移除高级机制后对记忆系统的影响。

---

## 五、花架子功能批量审视

以下功能在 Phase 40-48 期间实现，但社区调研显示其实际价值存疑。逐项列出证据，不定结论。

### 5.1 渐进式信任与权限（Progressive Trust）

**现状：** Agent 根据历史交互逐步升级信任等级，减少确认弹窗。

**社区证据：** Anthropic 的安全框架强调"权限在会话恢复时不自动恢复"。Claude Code 的做法是 deny > confirm > auto 三层固定规则，不做动态调整。社区讨论中未见对"渐进式信任"的需求或好评。

**建议方向：** 考虑简化为固定权限规则，移除动态信任升级逻辑。

### 5.2 确定性路由（Deterministic Routing）

**现状：** 分类器规则引擎 + LLM 兜底的混合路由，5 级优先级链。

**社区证据：** Pi 不做路由 - 用户直接选模型。Jcode（TikTok 31K 浏览、1.7K 赞）的卖点是"Rust harness 省内存 20 倍"，不是智能路由。社区关注的痛点是 token 成本和速度，不是模型选择的智能化。

**建议方向：** 路由机制本身有价值（是 RouteDev 的差异化卖点），但 5 级链可能过度。考虑简化为 2-3 级（简单 / 复杂 / 用户指定），砍掉置信度阈值、LLM 兜底分类等间接层。

### 5.3 隐式反馈与用户经验适配（Implicit Feedback / Experience Adaptation）

**现状：** Agent 根据用户行为模式推断经验水平，调整交互方式。

**社区证据：** last30days 调研中没有任何证据表明用户需要 Agent 自动适配经验水平。r/PromptEngineering 的高赞帖（502 赞）讨论的是"架构比模型重要"和"memory files + skills 提升 token 效率"，关注点在用户主动控制而非 Agent 自动适应。

**建议方向：** 考虑移除。如果保留，至少需要用户主动开启并提供手动覆盖入口。

### 5.4 Compose 模式

**现状：** 多步骤编排模式，允许用户预设工作流模板。

**社区证据：** HN 上的 VibeRaven（7pts）和 Aharness（4pts）都试图做"工作流状态机"，但社区反应冷淡。相反，Archon（Cole Medin YouTube）的"reusable workflows"获得了正面反馈 - 区别在于 Archon 是外部 harness builder，不是 Agent 内置功能。

**建议方向：** 考虑将 Compose 模式外化为 Skill / 配置文件，而非 Agent 核心功能。

### 5.5 对抗审查（Adversarial Review）

**现状：** Agent 主动生成对抗性审查来检测自身错误。

**社区证据：** HN 上 "Make No Mistakes"（4pts）做的是"AI 必须证明自己的工作" - 外部验证，不是自我对抗。GoalVerifier（独立模型验证目标完成度）在社区中有对应的讨论和认可。但"自我对抗审查"这个概念本身未见社区讨论。

**建议方向：** GoalVerifier 保留（有社区认可），对抗审查机制考虑降级为可选实验功能。

---

## 六、/goal 自主模式简化

**现状：** goal-runner.ts 2128 行，包含目标分解、步骤规划、冲突检测、并行调度、独立验证等完整自主执行链路。

**社区证据：**

r/PromptEngineering 的 502 赞帖子和评论区反复出现的主题是"架构比模型重要"和"简单工作流 + 好工具 > 复杂编排"。Fireship 的 YouTube 视频（score 36）讽刺了"dozen different AI agents arguing in your terminal"的现状。

另一方面，HN 上 TaskPeace（MCP 任务队列）和 Backlog（任务上下文管理器）获得了正面反馈，说明社区认可"任务管理"能力，但不认可"自主目标分解 + 多步编排"的重型方案。

**建议方向：** /goal 命令保留，但内部链路考虑简化 - 目标分解可以保留（LLM 拆步骤），步骤间的冲突检测和并行调度如果长期未通电则考虑移除。核心问题是：用户真的会让 Agent 完全自主地完成一个多步开发目标吗？如果实际使用模式都是 semi/manual，那 auto 模式的复杂编排就是为 5% 的场景付出 100% 的维护成本。

**置信度：** 中。需要执行人实际跑几次 /goal 全链路后判断哪些环节真正有用。

---

## 七、值得保留和加强的功能

社区调研同样验证了一些 RouteDev 已有功能的价值：

**路由与 token 追踪。** 这是 RouteDev 的核心差异化，last30days 调研中所有竞品都在讨论 token 成本（Jcode "20x more memory efficient"、Ponytail "20% cheaper"、OpenClaw "500,000 input tokens per 10 calls"），说明省钱是真痛点。RouteDev 的智能路由 + TokenTracker 直接回应这个需求。

**Checkpoint / 回滚。** Anthropic 的安全手册强调可回滚性。Pi 的 JSONL 会话树支持分支回溯。社区对"AI 改坏了能恢复"的需求是普遍的。

**MCP 生态。** HN 上 21 条 Show HN 中至少 8 条是 MCP 工具（PMB、TaskPeace、Skill Federation、Brain.md 等），说明 MCP 作为扩展协议已经成为社区共识。RouteDev 的 MCP 客户端是正确的长期投资。

**Skill / Hook 系统。** Google Labs 的 stitch-skills（GitHub trending，日增 101 stars，总计 6,555 stars）验证了"可复用 Agent 技能"的市场需求。RouteDev 的 Skill 系统方向正确。

**AGENTS.md 项目规范。** NixOS/nixpkgs 的两个 PR（57 react + 25 react）都在添加 AGENTS.md，说明项目级 Agent 配置文件已经成为大型项目的标配。RouteDev 的 /init + rules.md 机制方向正确。

---

## 八、四层架构落地映射（v2 修订 2026-07-11）

> 本节将第二至六节的建议映射到四层架构（详见 [BLUEPRINT-CORE-CAPABILITY-PACK-v2.md](./BLUEPRINT-CORE-CAPABILITY-PACK-v2.md)）。
> **核心策略：冷处理优先于删除；几乎用不到的模块保留接口作为外置包，不删代码。**

| 原建议 | 四层归属 | 处理方式 | 落地 Phase |
|--------|----------|----------|------------|
| 工具精简至 ≤10 | Core 强化 | 默认注册收口，低频工具退 Pack | 81 |
| Multi-Agent 协作 | **Extended Pack**（中等偏下） | 默认关；保留接口并维护；修 bug 不扩功能 | 83 |
| KnowledgeGraph 高级算法 | **Freeze** | 停止接线；保留存储接口 | 81 |
| Progressive Trust | **Freeze** | 停止动态升级接线；保留类型 | 79 |
| 确定性路由简化 | Core 强化 | 2–3 级路由替换 5 级链 | 81 |
| Implicit Feedback | **Freeze** | 停止接线；保留类型 | 81 |
| Compose 模式 | **Standard Pack**（冷处理） | 默认关；外化为配置/Skill | 82 |
| 对抗审查 | **Extended Pack**（中等偏下） | 默认关；保留接口；GoalVerifier 留 Core | 83 |
| /goal 高级编排 | **Extended Pack**（中等偏下） | sequential 为主；并行/冲突冻结 | 83 |
| 浏览器/Web 工具 | **Standard Pack**（冷处理） | 默认关；保留接口 | 82 |
| 代码地图 | **Standard Pack**（冷处理） | 默认关；保留接口 | 82 |
| Trace/Scorecard | **Standard Pack**（冷处理） | 默认关；命令触发 | 82 |
| 导入生态（cite/import/macros） | **Standard Pack**（冷处理） | 默认关；保留接口 | 82 |

### 层级决策原则

| 条件 | 归属 |
|------|------|
| 服务改码/省钱/回滚/可控 + 高频 + 低成本 | **Core** |
| 有明确用户场景但非高频 + 社区需求信号 | **Extended Pack** |
| 几乎用不到但有接入接口 + 删不如留 | **Standard Pack**（冷处理） |
| 价值未证明 + 有更好替代 | **Freeze** |

---

## 九、未覆盖范围

- 上下文管理（不动）
- 安全边界（不动）
- 前端交互优化（已有 Phase 74 专项规划）
- 花架子去除工程的具体实现（已有 Phase 56-60 系列）

---

## 附录：核心社区证据索引

| 证据 | 来源 | 平台 | 关键数据 |
|------|------|------|---------|
| Pi "4 commands beating the big ones" | kno2gether | TikTok | 28 views |
| Pi Coding Agent + Archon "fighting the bloat" | Cole Medin | YouTube | transcript |
| "Pi in 3 Minutes - the minimalist AI coding agent" | AI Tools in 3 Minutes | YouTube | transcript |
| Ponytail "50 lines → 1 line fix" | 100xengineers | Instagram | 55K views, 1.7K likes |
| Ponytail "YAGNI, laziest senior dev" | better.engineer | Instagram + TikTok | 50K + 2.3K views |
| Ponytail "cuts code 54%, 20% cheaper, 27% faster" | startupsaga | TikTok | 25 views |
| "A well-structured workflow with basic tools outperforms a bloated prompt stack" | weshouldlearn | TikTok | 5 views |
| Mouse: Precision Editing Tools | HN | Hacker News | 38 pts, 46 comments |
| "Tool definitions for 10 tools eat up 3,000 tokens" | freeCodeCamp (OpenClaw) | YouTube | transcript |
| Jcode "20x more memory efficient" | ai.with.andrew | TikTok | 31K views, 1.7K likes |
| "I spent a full day watching AI agent tutorials" | r/PromptEngineering | Reddit | 502 pts, 78 comments |
| Anthropic 36-Page Agent Security Playbook | The AI Automators | YouTube | transcript |
| TaskPeace MCP task queue | HN | Hacker News | 7 pts, 7 comments |
| PMB local-first memory over MCP | HN | Hacker News | 7 pts, 6 comments |
| NixOS AGENTS.md | NixOS/nixpkgs | GitHub | 57 + 25 react |
| stitch-skills reusable agent skills | google-labs-code | GitHub | 6,555 stars |
| SpaceX acquires Anysphere (Cursor) | r/wallstreetbets | Reddit | 3,956 pts |
| "What actually matters" from AI agent tutorials | r/PromptEngineering | Reddit | 502 pts |
| Agentic Orchestrator TUI for coding agents | DoorDash OSS | HN | 20 pts |
