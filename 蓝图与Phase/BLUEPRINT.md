# RouteDev — 项目共识与架构蓝图 V1.0

> 日期：2026-06-17 | 状态：待用户确认
> 角色：架构师（QoderWork）+ 执行人（另一个大模型）
> 配套文档：design-routedev.md, design-routedev-spec.md, design-routedev-spec2.md, design-routedev-spec3.md, DEEP_RESEARCH_competitive_analysis.md

---

## 一、产品定位

**一句话**：按任务复杂度自动路由模型的 CLI 开发助手，支持从对话到自主完成开发目标的全流程。

**核心价值**：省钱（智能路由）+ 自主（/goal 目标驱动）+ 安全（进程隔离）+ 可扩展（MCP 工具生态）

**目标用户**：个人开发者，日常多类型项目开发，希望 AI 助手智能节省 token 并具备自主完成开发任务的能力。

**与 PilotDeck 的关系**：
- 提取范围：仅提取 Router/tokenSaver 核心逻辑（模型选择 + Token 追踪），不提取 Agent/Bash/UI 模块
- 独立代码库：新建项目 `routedev/`，不依赖 PilotDeck 源码
- 许可证：AGPL-3.0（PilotDeck 许可证要求衍生作品同样开源）

---

## 二、MVP 范围界定

**做什么**：
- 智能模型路由：用户选偏好级别，规则引擎 + LLM 兜底自动匹配具体模型
- CLI 对话：流式输出（SSE），ReAct Agent Loop
- 7 个内置工具 + MCP 客户端
- 自主模式：/goal 目标分解 + 三步自主度（auto/semi/manual）
- 两套检查点：基于 git 的代码快照（回滚用）+ MiMo Code 风格的增量 Checkpoint（记忆用）
- 单 Agent 为主，接口预留多 Agent 扩展
- 分支对话（编辑消息生成新分支）
- 操作审计日志

**不做什么（MVP 排除）**：
- Docker 容器沙箱（用进程级安全 + OS 级沙箱替代）
- Tauri 桌面 UI（Phase 5+，但 Phase 1-4 的 CLI 阶段要为后续 UI 留好抽象边界）
- 插件系统（Phase 6+）
- 多端协同（手机 Remote、Bot 集成）
- 语音输入
- 自动费用计算（只统计 token 数量，不计算金额）
- Evaluator-Optimizer 高级模式（远期）
- 漂移检测与评估体系（远期）

---

## 三、技术栈

| 层 | 技术 | 理由 |
|----|------|------|
| 语言 | TypeScript 5.x | 与 PilotDeck 同源，生态丰富 |
| 运行时 | Node.js 20+ | CLI 工具的标准选择 |
| CLI 框架 | Ink（React for CLI） | Claude Code 验证过的方案，组件化 UI；但要注意组件拆分，避免 Claude Code 875KB 单组件的反面教材 |
| 构建 | tsup | 快速打包 |
| 包管理 | pnpm | 轻量、快速 |
| Git | simple-git（包装系统 git） | 检查点管理；参考 Aider 的自动 git commit 思路 |
| MCP | @modelcontextprotocol/sdk | 官方 SDK，JSON-RPC 2.0 协议 |
| LLM 客户端 | openai SDK + @anthropic-ai/sdk | 双协议支持 |
| 配置 | YAML（config.yaml） | 人类可读；参考 Reasonix 的 TOML 配置驱动设计（零硬编码） |
| 进程管理 | Node.js child_process | 工具子进程隔离（"老板+打工"模式） |
| 测试 | vitest | 快速、TypeScript 原生支持 |
| 代码搜索 | ripgrep 包装 | code_search 工具的底层实现 |

---

## 四、文件结构

```
routedev/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── config.example.yaml              # 配置模板
├── src/
│   ├── cli/                         # CLI 界面层（Ink）
│   │   ├── App.tsx                  # 主组件（拆分：不做巨型单文件）
│   │   ├── ChatView.tsx             # 对话界面（流式渲染 + 分支切换）
│   │   ├── StatusBar.tsx            # 状态栏（模型、token、路由等级、降级状态）
│   │   ├── StepCard.tsx             # 执行卡片（Notion 风格）
│   │   ├── InputBox.tsx             # 输入框（支持 /命令、@引用、$技能）
│   │   ├── TracePanel.tsx           # Trace 可视化面板
│   │   └── components/              # 通用 UI 组件
│   │       ├── BranchSwitcher.tsx   # 分支切换标签
│   │       ├── DiffView.tsx         # 代码变更视图（默认 +12 -3，可切换）
│   │       └── ConfirmDialog.tsx    # 确认对话框（权限确认、安全确认）
│   ├── router/                      # Router 层
│   │   ├── types.ts                 # ScenarioTier, ModelConfig, ProviderConfig, RouterRule, TokenBudget
│   │   ├── config.ts                # 路由配置加载
│   │   ├── classifier.ts            # 混合场景分类器（规则优先 + LLM 兜底）
│   │   ├── router.ts                # 模型路由器（选模型、降级、手动覆盖）
│   │   ├── tracker.ts               # Token 追踪器（按 Agent/步骤/模型/任务 归因）
│   │   └── llm/                     # LLM 客户端
│   │       ├── base.ts              # 统一接口抽象
│   │       ├── openai.ts            # OpenAI 协议（含流式 SSE）
│   │       └── anthropic.ts         # Anthropic 协议（含流式 SSE）
│   ├── agent/                       # Agent 层
│   │   ├── types.ts                 # AgentRole, AgentStatus, AgentMessage, StepPlan, PlanStep 等
│   │   ├── loop.ts                  # ReAct Agent Loop（AsyncGenerator）
│   │   ├── executor.ts              # StepExecutor（执行单步，调用 Tool Layer）
│   │   ├── orchestrator.ts          # OrchestratorAgent（动态分解、冲突检测、结果汇总）
│   │   ├── worker.ts                # WorkerAgent（执行具体步骤）
│   │   ├── goal-parser.ts           # /goal 命令解析 + 目标分解
│   │   ├── verifier.ts              # GoalVerifier（独立审查任务完成度）
│   │   ├── conflict.ts              # ConflictDetector（文件访问冲突检测）
│   │   ├── autonomy.ts              # AutonomyController（auto/semi/manual）
│   │   ├── durable.ts               # DurableExecutor（持久化执行，断点恢复）
│   │   ├── branch.ts                # BranchManager（对话分支管理）
│   │   └── memory/                  # 记忆系统
│   │       ├── blackboard.ts        # 公共黑板（共享共识信息）
│   │       ├── checkpoint.ts        # 增量 Checkpoint（CheckpointWriter）
│   │       ├── notes.ts             # notes.md 临时记事本
│   │       └── context.ts           # 上下文管理（压缩、裁剪、保留策略）
│   ├── tools/                       # Tool 层
│   │   ├── registry.ts              # ToolRegistry（注册、注销、查询、生成 function schema）
│   │   ├── executor.ts              # ToolExecutor（权限检查→安全检查→执行→记录 Trace）
│   │   ├── types.ts                 # ToolSource, ToolPermission, ToolResult, ToolDefinition 等
│   │   ├── builtin/                 # 内置工具
│   │   │   ├── file-read.ts         # permission: auto
│   │   │   ├── file-write.ts        # permission: confirm
│   │   │   ├── file-search.ts       # permission: auto
│   │   │   ├── shell-exec.ts        # permission: confirm，子进程执行
│   │   │   ├── git-op.ts            # permission: auto(读)/confirm(写)
│   │   │   ├── web-search.ts        # permission: auto
│   │   │   └── code-search.ts       # permission: auto，可选 CodeGraph 增强
│   │   └── mcp/                     # MCP 客户端
│   │       └── client.ts            # 连接/断开/发现工具/调用工具/导入导出配置
│   ├── harness/                     # Harness 层
│   │   ├── security.ts              # SecurityPolicy（目录边界、命令控制、敏感文件、网络确认）
│   │   ├── checkpoint.ts            # CheckpointManager（git commit 快照、回滚、diff、清理）
│   │   ├── hooks.ts                 # HookRunner（pre-step, post-step, on-error, on-complete）
│   │   ├── audit.ts                 # AuditLogger（操作审计日志，JSONL 格式）
│   │   └── sandbox/                 # OS 级沙箱（Phase 4+）
│   │       ├── types.ts
│   │       └── windows.ts           # Windows AppContainer 实现
│   ├── config/                      # 配置管理
│   │   ├── loader.ts                # YAML 加载（全局 + 项目级合并）
│   │   ├── schema.ts                # 配置 schema 验证
│   │   └── defaults.ts              # 默认配置值
│   ├── prompts/                     # Prompt 模板
│   │   ├── manager.ts               # PromptTemplateManager（获取、注册、渲染变量）
│   │   ├── orchestrator.ts          # Orchestrator system prompt
│   │   ├── workers/                 # 各角色 Worker prompt
│   │   │   ├── coder.ts
│   │   │   ├── searcher.ts
│   │   │   ├── tester.ts
│   │   │   └── reviewer.ts
│   │   ├── classifier.ts            # 场景分类 prompt
│   │   ├── evaluator.ts             # 评估员 prompt
│   │   ├── checkpoint.ts            # CheckpointWriter prompt
│   │   ├── verifier.ts              # GoalVerifier prompt
│   │   ├── init-analyzer.ts         # /init 项目分析 prompt
│   │   └── summary.ts              # 摘要生成 prompt
│   └── utils/                       # 工具函数
│       ├── logger.ts                # 日志（调试日志写到 logs/）
│       ├── git.ts                   # Git 操作封装（simple-git）
│       ├── token-counter.ts         # Token 计数
│       └── paths.ts                 # 路径解析（AppData 目录管理）
├── tests/                           # 测试
│   ├── router/
│   ├── agent/
│   ├── tools/
│   ├── harness/
│   └── integration/
├── docs/
│   ├── plans/                       # Phase 实现计划
│   └── specs/                       # 规格文档
└── bin/
    └── routedev.ts                  # CLI 入口
```

---

## 五、核心架构决策

### 决策 1：ReAct Agent Loop 作为核心循环

自我辩论：
- 路径 A：简单 request-response（每次输入一次输出）。优点：简单。缺点：不支持多步工具调用，Agent 无法自主完成复杂任务。
- 路径 B：ReAct 循环（think → tool → observe → think...）。优点：支持多步推理，行业标准模式。缺点：实现复杂度更高，需要处理循环终止和错误恢复。
- **选择 B**：ReAct 循环是 Agent 的基础能力，request-response 无法支撑 /goal 自主模式。Codex CLI 的"Ralph Loop"（四步迭代：生成→验证→收集错误→调整）和 Claude Code 的连续循环（用户目标→模型判断→工具执行→环境反馈→模型再判断→验证完成）都验证了这一模式。

**实现细节**：
- 用 TypeScript AsyncGenerator 实现，每轮迭代 yield 出流式事件
- 防御性设计：可配置的最大迭代次数防止死循环
- 工作记忆（working memory）追踪已失败的尝试，避免重复
- 中间件 hook 点：`before_agent`、`wrap_tool_call`，允许拦截和自定义

### 决策 2：主进程 + 工具子进程分离

自我辩论：
- 路径 A：所有代码在同一进程。优点：简单。缺点：工具崩溃导致 Agent 崩溃。
- 路径 B：工具在 child_process 中执行。优点：隔离性好。缺点：IPC 开销。
- 路径 C：worker_threads。优点：共享内存更轻量。缺点：thread 崩溃仍影响主进程。
- **选择 B**：用户选择了"老板+打工"模式。shell-exec 天然需要 child_process，其他工具统一用这个模式。主进程只负责对话和调度，工具执行在独立子进程中。

**并发规则**（参考竞品调研）：
- 并发安全的工具（file_read、file_search、code_search）可以并行执行
- 有副作用的工具（file_write、shell_exec、git_op）必须串行执行
- 工具结果通过 IPC 返回主进程，注入到模型的上下文窗口供下一轮推理

### 决策 3：混合场景分类器

自我辩论：
- 路径 A：纯 LLM 分类。优点：准确。缺点：每条消息 +0.5-1s 延迟 + 额外 token。
- 路径 B：纯规则引擎。优点：零延迟。缺点：分类粗糙。
- 路径 C：用户选偏好级别 + 规则优先 + LLM 兜底。优点：用户有掌控感，简单请求零延迟，复杂请求才调 LLM。
- **选择 C**：用户明确选择。

**规则引擎设计**：
- 命令匹配：`/goal` → complex，`/status` → simple，`/config` → simple
- 关键词匹配：「解释」「什么是」→ simple；「修改」「重构」→ medium/complex
- 消息长度：超长消息（>500字）倾向 medium+
- 文件引用数：@引用 >3 个文件 → medium+
- 不确定时（置信度 <0.6）才调用 LLM 分类器（用最便宜的模型 + few-shot prompt）
- 用户偏好级别（省钱/平衡/极致）决定路由的 baseline tier

### 决策 4：进程级安全替代 Docker

自我辩论：
- 路径 A：Docker 容器。优点：最强隔离。缺点：用户门槛高（需预装，Windows Home 不支持）。
- 路径 B：目录边界 + 命令黑名单 + 敏感文件保护。优点：零依赖。缺点：隔离弱。
- 路径 C：OS 级沙箱（Windows AppContainer）。优点：内核级隔离。缺点：实现复杂。
- **选择 B（Phase 1-2）→ 增强到 B+C 混合（Phase 4+）**：MVP 先用基础安全层，后续加入 OS 级隔离。参考 Claude Code 的做法——7 层安全架构中，OS 沙箱只是其中一层。

**纵深防御策略**（参考 Claude Code 的 7 层安全模型）：
1. **权限层**：工具的 auto/confirm/deny 权限（deny > confirm > auto，最严格规则永远胜出）
2. **目录边界**：限制 Agent 只能操作项目目录内文件
3. **命令黑名单**：禁止 `rm -rf`、`format`、`del /s` 等危险命令
4. **敏感文件保护**：`.env`、`credentials.json`、`*.key` 等只读或禁止访问
5. **网络确认**：Agent 发起网络请求前需确认
6. **子进程隔离**：工具在子进程中执行，主进程不受影响
7. **审计日志**：所有操作留痕，可追溯

**关键原则**：权限在会话恢复时不自动恢复，必须重新建立信任（参考 Claude Code）。

### 决策 5：单 Agent 先行，接口预留多 Agent

自我辩论：
- 路径 A：从第一天实现多 Agent。优点：架构完整。缺点：开发时间翻倍，过早引入复杂度。文档自己写了"单 Agent + 好工具 > 多 Agent + 烂协调"。
- 路径 B：只做单 Agent，不考虑多 Agent。优点：最简单。缺点：后续加多 Agent 需要大规模重构。
- 路径 C：单 Agent 实现，接口按多 Agent 设计。优点：当前简单，未来扩展无需重构。
- **选择 C**：具体做法——AgentMessage 消息协议、Blackboard 公共黑板、WorkerAgent 接口从 Day 1 就定义好。Phase 1-3 只有一个"默认 Worker"执行所有任务。Phase 14 再实现 Orchestrator 调度和并行。

### 决策 6：CLI 先行，UI 后补

自我辩论：
- 路径 A：CLI 和 UI 同步开发。优点：早期有图形界面。缺点：两头兼顾拖慢进度。
- 路径 B：先完成 CLI（Phase 1-4），再套 Tauri UI（Phase 5）。优点：Agent 逻辑先稳定。缺点：几个月没有图形界面。
- **选择 B**：用户明确选择。但 CLI 阶段要注意组件化（Ink/React 组件），为后续 Tauri UI 复用组件逻辑。

### 决策 7：配置驱动，零硬编码

自我辩论：
- 路径 A：硬编码模型列表和路由规则。优点：简单。缺点：每次改模型都要改代码。
- 路径 B：配置驱动（参考 Reasonix 的 TOML 设计），所有模型、路由规则、安全策略都从配置文件加载。优点：灵活。缺点：配置加载逻辑更复杂。
- **选择 B**：参考 Reasonix "内核无硬编码模型"的设计。config.yaml 支持环境变量引用（`${ENV_VAR}`），支持全局配置 + 项目级 `.routedev.yaml` 覆盖。

---

## 六、Router 层详细规格

### 6.1 场景分类器（ScenarioClassifier）

分类器采用混合模式（规则优先 + LLM 兜底）：

**规则引擎**（零延迟）：
- `/goal` 命令 → complex
- `/status`、`/config`、`/memory` → simple
- 关键词「解释」「什么是」「查看」 → simple
- 关键词「修改」「添加」「实现」 → medium
- 关键词「重构」「架构」「设计」 → complex
- 关键词「调试」「优化」「性能」 → reasoning
- @引用文件数 >3 → 至少 medium
- 消息长度 >500 字 → 至少 medium

**LLM 兜底**（仅在规则引擎置信度 <0.6 时调用）：
- 使用最便宜的快速模型（如 deepseek-v4-flash）
- few-shot prompt，输出 JSON `{tier, confidence, reasoning}`
- 预算上限：200 tokens / 次分类
- 延迟目标：<1s

### 6.2 模型路由器（ModelRouter）

**路由流程**：
```
用户输入 → 检查用户偏好级别 → 规则引擎分类 → [置信度低?] → LLM 分类 → 场景等级
  → 查路由规则表 → 选中模型 → [模型不可用?] → 降级到 fallback → 路由决策
  → TokenTracker 检查预算 → [超预算?] → 强制降级到最低 tier → 最终路由决策
```

**降级策略**：
- 单次请求超 token 上限 → 降级到下一 tier
- 累计消耗超日预算 → 全部降级到最低 tier
- 模型调用失败 → 通知用户手动处理（不自动熔断）

**路由可见性**：
- 路由决策完全可见，状态栏显示：当前模型、路由等级、是否已降级
- 用户可用 `/model <name>` 手动覆盖路由
- 静默切换 + 状态栏更新（不弹提示打断对话）

### 6.3 Token 追踪器（TokenTracker）

**追踪维度**（成本归因）：
- 按 Agent：Orchestrator / Worker 各消耗多少
- 按步骤：分析 / 编码 / 测试 各消耗多少
- 按模型：flash / pro / kimi 各消耗多少
- 按任务：每个 /goal 的总消耗

**预算配置**：
- mode: `track_only`（仅统计显示）或 `enforce`（强制限制 + 降级）
- dailyLimit: 日 token 上限（默认 500k）
- 每日 0 点自动重置

**性能预算**（元操作 token 上限）：

| 操作 | 预算上限 | 计入总预算 |
|------|---------|-----------|
| ScenarioClassifier | 200 tokens | 是 |
| CheckpointWriter（单次） | 500 tokens | 是 |
| GoalVerifier（单次） | 1000 tokens | 是 |
| /init 项目分析 | 2000 tokens | 是 |
| /dream 记忆整理 | 1500 tokens | 是 |

**延迟预算**：

| 操作 | 目标延迟 |
|------|---------|
| 场景分类 | < 1s |
| Checkpoint 生成 | < 2s（后台异步） |
| GoalVerifier | < 3s |
| 工具调用 | < 10s |
| 端到端（简单任务） | < 5s |

---

## 七、Agent 层详细规格

### 7.1 Agent Loop（ReAct 循环）

核心循环实现为 AsyncGenerator，每轮迭代产出流式事件：

```
用户消息 → [分类] → 选择模型 → 发送给 LLM
  → LLM 返回 tool_call → 权限检查 → 安全检查 → 子进程执行工具 → 结果注入上下文 → 再次调用 LLM
  → LLM 返回 tool_call → ...（循环）
  → LLM 返回最终文本 → 流式输出给用户
```

**循环终止条件**：
- LLM 返回最终文本（非 tool_call）
- 达到最大迭代次数（可配置，防止死循环）
- 用户按 Ctrl+C 中断
- 发生不可恢复的错误

**错误处理**：
- 工具执行失败 → 错误信息注入上下文，LLM 可以决定重试或换策略
- LLM API 调用失败 → 通知用户，不自动重试（避免静默失败）
- 子进程崩溃 → 主进程捕获，记录错误，通知用户

### 7.2 自主度控制（AutonomyController）

| 模式 | 行为 | 代码修改审查 |
|------|------|-------------|
| auto（全自动） | 完全自主执行，完成后报告 | 先改后查，可回滚 |
| semi（半自动） | 关键步骤前暂停确认 | 修改前确认 |
| manual（手动） | 每步都需用户确认 | 修改前确认 |

默认模式：semi。可通过 `/auto`、`/semi`、`/manual` 切换。

**权限确认 UX**（参考 Claude Code）：
- deny > confirm > auto，最严格规则永远胜出
- 权限在会话恢复时不自动恢复
- 确认对话框显示：操作内容、影响范围、风险等级

### 7.3 /goal 命令与目标分解

**命令格式**：`/goal "重构 Entry.java" --verify "所有测试通过且无编译错误"`

**目标分解流程**：
```
/goal 输入 → GoalParser 解析 → LLM 分解为步骤列表（StepPlan）
  → 为每步分配 agentRole + tier + 预估文件访问
  → ConflictDetector 检测文件冲突 → 规划并行/串行顺序
  → 展示 Notion 风格步骤卡片列表（可编辑、删除、重排）
  → 用户确认 → 开始执行
```

**StepPlan 数据结构**：
- 每个 PlanStep 包含：id、description、agentRole、tier、fileAccess（路径+操作类型）、dependencies、status、result
- 冲突组（ConflictGroup）：冲突的步骤 ID + 冲突的文件路径 + 执行策略（parallel/sequential）

### 7.4 GoalVerifier（独立验证）

- 独立模型调用，不参与实际工作，避免认知偏差
- 审查执行结果是否真正满足 --verify 条件
- 检查实际产出（文件修改、测试结果），而非 Agent 的声明
- 输出 JSON：`{passed, confidence, reasoning, missingItems, suggestions}`
- 不通过 → 返回 Agent Loop 继续修复
- 预算：单次验证最大 1000 tokens

### 7.5 信息传递规则（防幻觉传染）

- Worker 间不传完整历史，只传对方需要的关键信息
- Orchestrator 做上下文裁剪：提取结论，丢弃推理过程
- 公共黑板存共识信息（任务目标、已完成步骤），私有笔记存工作细节
- 从 Worker 私有笔记提取结论，写入公共黑板时才共享

### 7.6 持久化执行（DurableExecutor）

- 每完成一步都持久化状态到磁盘（progress.json）
- 失败后从上次成功的位置恢复，而非从头再来
- 适用场景：任务超过 5 分钟、涉及人工审批、需要跨天执行
- 参考 Temporal 的 Checkpoint 机制

---

## 八、Tool 层详细规格

### 8.1 工具注册表（ToolRegistry）

**分级架构**（参考 Claude Code，上下文开销递增）：
1. **内置工具**（零开销）：file_read, file_write, file_search, shell_exec, git_op, web_search, code_search
2. **Hook**（低开销）：生命周期回调（pre-step, post-step, on-error, on-complete）
3. **MCP Server**（中等开销）：通过 MCP 协议加载的外部工具

**注册表接口**：
- register(tool) / unregister(toolId)
- listTools() / getBySource(source) / getByPermission(permission)
- getFunctionSchemas()：生成给模型 function calling 用的 JSON Schema

### 8.2 工具执行器（ToolExecutor）

**执行流程**：
```
ToolCall 请求 → 权限检查（auto→直接执行 / confirm→弹确认 / deny→拒绝）
  → 安全策略检查（目录边界、命令黑名单、敏感文件保护）
  → 子进程执行 handler
  → 记录 Trace（输入/输出/耗时/token）
  → 记录审计日志
  → 返回 ToolResult
```

**并发规则**：
- 并发安全工具（file_read, file_search, code_search）→ 并行执行
- 有副作用工具（file_write, shell_exec, git_op）→ 串行执行
- executeBatch() 自动分析依赖，并行无冲突的工具

### 8.3 内置工具列表

| 工具 | 权限 | 子进程 | 说明 |
|------|------|--------|------|
| file_read | auto | 否 | 读取文件，支持行号范围、编码选择 |
| file_write | confirm | 否 | 写入/创建文件 |
| file_search | auto | 否 | 按内容/名称/glob 搜索，可限结果数 |
| shell_exec | confirm | 是 | 执行 Shell 命令，有超时控制 |
| git_op | auto(读)/confirm(写) | 是 | diff/log/status/add/commit/push/branch/checkout/stash |
| web_search | auto | 是 | 网络搜索（MVP 用 Bing 抓取，备选 Brave Search API） |
| code_search | auto | 否 | 语义/文本/符号搜索，可选 CodeGraph MCP 增强 |

### 8.4 MCP 客户端

- 兼容 MCP 协议（JSON-RPC 2.0），支持 stdio 和 HTTP+SSE 传输
- 连接/断开 MCP Server
- 自动发现 Server 提供的工具，注册到 ToolRegistry
- 导入/导出 MCP 配置（mcp-config.json）
- UI 管理界面（CLI 阶段用配置文件管理，UI 阶段加图形界面）

---

## 九、Harness 层详细规格

### 9.1 安全策略（SecurityPolicy）

**目录边界**：
- enabled: true/false
- allowedPaths: 默认只有项目目录
- deniedPaths: 可配置额外禁止路径

**命令控制**：
- blacklist: `["rm -rf", "format", "del /s"]` 等危险命令
- whitelist: 空表示不限制白名单
- mode: blacklist / whitelist / both

**敏感文件保护**：
- patterns: `[".env", "credentials.json", "*.key"]`
- policy: readonly（只读）或 deny（禁止访问）

**网络请求确认**：
- enabled: true → Agent 发起网络请求前需确认
- allowedDomains: 免确认域名白名单
- deniedDomains: 禁止域名黑名单

### 9.2 检查点管理（CheckpointManager）

**基于 Git 的代码快照**：
- 每个步骤执行前自动创建 git commit 快照
- 支持回滚到任意检查点
- 检查点列表可在 UI 中可视化展示
- 保留最近 10 个检查点，超出自动清理最旧的

**数据结构**：
- Checkpoint: `{id, stepId, goalId, gitCommitHash, timestamp, description, filesSnapshot, isAutoCreated}`
- CheckpointDiff: `{filesAdded, filesModified, filesDeleted, patch}`

### 9.3 生命周期 Hook（HookRunner）

```
pre-step    → 执行前（锁定关键文件、备份）
post-step   → 执行后（格式化、lint）
on-error    → 出错时（自动回滚、通知）
on-complete → 目标完成时（运行全量测试、生成报告）
```

Hook 结果可返回：continue / abort / retry / skip

### 9.4 审计日志（AuditLogger）

**审计内容**：
- 时间戳、Agent ID、操作类型、目标文件/命令
- 操作前后的状态对比（文件修改前后的 diff）
- 用户确认记录（谁、何时、是否批准）
- 模型路由决策（哪个模型、为什么选它）

**存储格式**：
```
AppData/RouteDev/audit/
└── {date}/
    └── {session-id}.audit.jsonl
```

保留期限：30 天，超出自动清理。

---

## 十、Memory 层详细规格

### 10.1 记忆类型与存储

**混合记忆模式**：
- 共享记忆（公共黑板）：所有 Agent 共享的任务共识信息
- 独立记忆（私有笔记）：每个 Agent 的工作细节、中间推理
- 项目级记忆：规则、约定、架构决策（跨会话持久）
- 会话级记忆：当前对话上下文、任务进度（会话内有效）

**存储结构**：
```
AppData/RouteDev/
├── config.yaml              # 全局配置
├── providers.json           # API 提供商配置
├── plugins/                 # 插件目录
├── mcp-config.json          # MCP Server 配置
├── logs/                    # 调试日志
├── audit/                   # 操作审计日志
└── projects/
    └── {project-hash}/
        ├── rules.md             # 项目规则（/init 生成）
        ├── context.json         # 项目上下文
        ├── decisions.jsonl      # 历史决策记录
        ├── blackboard.json      # 公共黑板
        ├── MEMORY.md            # 项目记忆（跨会话）
        └── sessions/
            └── {session-id}/
                ├── checkpoint.md    # 增量检查点
                ├── notes.md         # 临时记事本
                ├── summary.md       # 会话摘要
                ├── progress.json    # 任务进度
                └── workers/
                    └── {worker-id}/
                        └── notes.json  # Worker 私有笔记
```

### 10.2 公共黑板（Blackboard）

- currentGoal: 当前目标信息 `{goalId, description, status, startedAt, useMultiAgent}`
- completedSteps: 已完成步骤摘要 `{stepId, description, conclusion, filesModified, workerId}`（只存结论，不存推理过程）
- projectFacts: 项目共识 `{key, value, source(user/inferred), confidence}`
- version: 乐观锁，防止并发冲突

### 10.3 增量 Checkpoint（MiMo Code 风格）

**CheckpointWriter**：独立的子 Agent，专门负责记忆维护。主 Agent 只管写代码，记忆维护完全外包。

**三档触发机制**（按 token 消耗百分比）：
- **20%**：首次 checkpoint，建立基础快照
- **45%**：中期 checkpoint，增量更新
- **70%**：晚期 checkpoint，准备压缩
- 每次 checkpoint 是对前一次的增量更新，不是全量重写
- 阈值可配置

**11 个结构化字段**：
1. currentIntent（当前意图）
2. nextAction（下一步动作）
3. workingConstraints（工作约束）
4. taskTree（任务树：主任务 + 子任务状态）
5. currentWorkingFiles（当前正在操作的文件）
6. involvedFiles（涉及的所有文件）
7. crossTaskDiscoveries（跨任务发现）
8. errorsAndFixes（错误与修复方案）
9. runtimeState（运行时状态）
10. designDecisions（设计决策及理由）
11. miscNotes（杂项笔记）

**主 Agent 唯一写入通道**：notes.md（自由格式临时记事本），Writer 在 checkpoint 时读取、归类、清空。

### 10.4 上下文压缩策略

**触发条件**：当前消息 token 数超过模型窗口的 80%

**保留策略**（优先级从高到低）：
1. 系统 prompt（始终保留）
2. 当前 /goal 上下文（始终保留）
3. 公共黑板快照（始终保留）
4. 最近 N 条完整消息（可配置）
5. 包含决策的消息（优先保留）
6. 历史消息 → 压缩为摘要

**压缩方式**：优先从结构化 checkpoint 重建上下文，而非从零拼接历史。

---

## 十一、命令系统

### 11.1 核心命令

| 命令 | 功能 |
|------|------|
| `/goal <desc> [--verify <cond>]` | 设定目标，自动分解并执行。可选 --verify 指定完成条件 |
| `/auto` | 切换到全自动模式 |
| `/semi` | 切换到半自动模式 |
| `/manual` | 切换到手动模式 |
| `/build` | 切换到 Build 工作模式（读写执行，默认） |
| `/plan` | 切换到 Plan 工作模式（只读分析） |
| `/compose` | 切换到 Compose 工作模式（自动编排全流程） |
| `/rollback [step]` | 回滚到指定检查点 |
| `/status` | 查看当前任务进度和 token 消耗 |
| `/model <name>` | 手动切换模型（覆盖路由） |
| `/config` | 打开配置（CLI 阶段用编辑器打开 config.yaml） |
| `/memory` | 查看/编辑项目记忆 |
| `/init` | 分析项目结构，自动生成 rules.md |
| `/dream` | 整理项目记忆，合并去重（手动或每 7 天自动） |
| `/undo` | 撤销上一步操作 |
| `/retry` | 重新执行上一步 |
| `/pause` | 暂停当前任务 |
| `/skip` | 跳过当前步骤 |

### 11.2 快捷引用系统（参考 ZCode）

| 快捷方式 | 功能 |
|----------|------|
| `@<filename>` | 引用指定文件，自动注入文件内容到上下文 |
| `@<symbol>` | 引用代码符号（函数/类/变量），自动定位定义 |
| `#<conversation>` | 关联历史对话，注入相关上下文 |
| `$<skill>` | 调用预设专业技能（如 $tdd、$refactor） |

---

## 十二、工作模式（参考 MiMo Code）

| 模式 | 权限 | 用途 |
|------|------|------|
| Build | 读写执行 | 默认开发模式，全权限 |
| Plan | 只读 | 只读分析模式，安全探索代码 |
| Compose | 编排 | 自动编排需求→编码→测试→审查全流程 |

工作模式与自主度模式正交：Build + auto = 最高权限自主开发；Plan + manual = 安全探索每步确认。

---

## 十三、后台任务

- 后台搜索：代码/文件搜索，结果推送到主任务上下文
- 后台项目分析：分析项目结构，生成上下文摘要
- 后台测试/构建：运行测试或构建，结果通知主任务
- 文件监控：外部修改文件后自动感知更新上下文
- 并发限制：最多 3 个后台任务同时运行

---

## 十四、配置设计

### 14.1 全局配置（config.yaml）

```yaml
version: 1

general:
  language: zh-CN
  theme: dark
  startupBehavior: restore       # restore / project_select

providers:
  - id: opencode-go
    name: OpenCode Go
    protocol: openai
    baseUrl: https://opencode.ai/zen/go/v1
    apiKey: ${OPENCODE_API_KEY}

  - id: opencode-go-anthropic
    name: OpenCode Go (Anthropic)
    protocol: anthropic
    baseUrl: https://opencode.ai/zen/go/v1
    apiKey: ${OPENCODE_API_KEY}

router:
  rules:
    - tier: simple
      modelId: deepseek-v4-flash
    - tier: medium
      modelId: minimax-m3
    - tier: complex
      modelId: qwen3.7-plus
    - tier: reasoning
      modelId: kimi-k2.7
      fallbackModelId: deepseek-v4-pro
  budget:
    mode: track_only
    dailyLimit: 500000
  classifierModel: deepseek-v4-flash
  userPreference: balanced       # saving / balanced / premium

checkpoint:
  enabled: true
  triggers:
    - level: 20
      action: initial
    - level: 45
      action: incremental
    - level: 70
      action: compress
  modelId: deepseek-v4-flash
  maxTokensPerCheckpoint: 500

goalVerifier:
  enabled: true
  modelId: kimi-k2.7
  maxTokensPerVerification: 1000
  autoVerify: true

security:
  directoryBoundary: true
  commandBlacklist: ["rm -rf", "format", "del /s"]
  commandWhitelist: []
  sensitiveFiles: [".env", "credentials.json", "*.key"]
  sensitiveFilePolicy: readonly
  networkConfirm: true

autonomy:
  defaultMode: semi

sounds:
  enabled: true
  completion: default
  error: warning
  approval: notification

updates:
  checkOnStartup: true
  autoUpdate: false
```

### 14.2 项目配置（.routedev.yaml）

项目根目录下，覆盖全局配置：
```yaml
version: 1
rules:
  - "使用中文注释"
  - "所有注册通过 DeferredRegister"
router:
  rules:
    - tier: reasoning
      modelId: deepseek-v4-pro
security:
  sensitiveFiles: [".env", "src/main/resources/*.properties"]
tools:
  mcpServers:
    - name: codegraph
      command: npx
      args: ["-y", "@anthropic/codegraph-mcp"]
```

---

## 十五、Prompt 模板管理

**模板管理器（PromptTemplateManager）**：
- 优先级：项目覆盖 > 用户自定义 > 内置默认
- 支持变量替换（`{{projectContext}}`、`{{blackboardSnapshot}}`、`{{availableTools}}` 等）
- 模板有版本号，升级时记录变更

**内置模板列表**：
- orchestrator.system — Orchestrator system prompt
- worker.coder.system — Coder Worker prompt
- worker.searcher.system — Searcher Worker prompt
- worker.tester.system — Tester Worker prompt
- worker.reviewer.system — Reviewer Worker prompt
- router.scenario_classifier — 场景分类 prompt
- advanced.evaluator — 评估员 prompt
- memory.checkpoint_writer — CheckpointWriter prompt
- memory.summary_generator — 摘要生成 prompt
- command.init_analyzer — /init 项目分析 prompt
- goal.verifier — GoalVerifier prompt

---

## 十六、Phase 概览与依赖关系

```
Phase 1: 项目骨架 + 配置系统
  └→ Phase 2: 核心类型 + LLM 客户端（双协议 + 流式）
      └→ Phase 3: Router 层（分类器 + 路由 + Token追踪）
          └→ Phase 4: 基础 CLI 对话（Ink + 流式 + 状态栏）
              └→ Phase 5: Agent Loop 核心（ReAct 循环）
                  ├→ Phase 6: 工具框架 + 基础工具（file_read/write/search）
                  │   └→ Phase 7: 进阶工具（shell_exec/git_op/web_search/code_search）
                  │       └→ Phase 8: MCP 客户端
                  ├→ Phase 9: 自主模式 + /goal 命令
                  │   ├→ Phase 10: 检查点系统（Git 快照 + 回滚）
                  │   ├→ Phase 11: 增量 Checkpoint（MiMo Code 风格）
                  │   └→ Phase 12: 分支对话 + /init + /dream
                  └→ Phase 13: 安全层增强 + 审计日志
                      └→ Phase 14: 多 Agent 基础
                          └→ Phase 15: 可观测性
```

Phase 6-8（工具链）和 Phase 9-12（自主模式）和 Phase 13（安全）可在 Phase 5 完成后**并行**推进。

---

## 十七、Phase 执行格式

每个 Phase 以独立 .md 文件分发，格式如下：

---
**Phase [N]：[简短标题]**

**回应**：对上一次 CONCERN 逐条裁决（首个 Phase 无此项）

**目标**：一句话说清本 Phase 要完成什么

**蓝图参考**：本 Phase 对应蓝图的哪些章节

**具体任务**：
- [ ] 任务 1（含文件路径、关键代码逻辑）
- [ ] 任务 2
- ...

**完成标准**：
- 标准 1
- 标准 2（必须包含 `pnpm build` 通过）

**注意事项**：
- 来自上一 Phase 的 CONCERN 裁决
- 来自蓝图的约束
---

**审核结论**：
- **Accept**：验收通过 + 蓝图版本更新说明 + 下一 Phase 完整内容
- **Refuse**：需修改 + 问题说明 + 修复 Prompt。FATAL 级 CONCERN 单独说明

---

## 十八、开放问题

1. **Windows 进程沙箱**：Phase 13 时需调研 Windows AppContainer API 的具体实现。保守替代：先用目录边界 + 命令黑名单
2. **web_search 稳定性**：Bing 网页抓取可能不稳定，备选 Brave Search API（免费 2000 次/月）
3. **Ink 复杂度管理**：从 Phase 4 开始就做好组件拆分，避免 Claude Code 的巨型组件问题
4. **DeepSeek 前缀缓存**：Phase 3 的 Router 可考虑利用前缀缓存优化，需实际测试命中率
5. **插件系统**：Phase 6+ 再实现，但工具注册表的接口设计要从 Day 1 支持插件扩展

---

*蓝图版本：V1.0 | 下次更新时机：用户确认后 / 首个 Phase CONCERN 触发时*
