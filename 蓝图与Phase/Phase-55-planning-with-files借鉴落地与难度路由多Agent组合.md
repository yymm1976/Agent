# Phase 55 — planning-with-files 借鉴落地 + 难度路由多 Agent 组合 + headroom 压缩层借鉴

> **版本目标：** v4.4.0
> **前置依赖：** Phase 54（多 Agent 协作剧场与参赛演示闭环）已完成
> **后继依赖：** 无（轻量借鉴 + 难度路由 + 压缩层借鉴 Phase，独立交付）
> **新增测试要求：** ≥ 55 个
> **研究依据：**
> 1. **planning-with-files**（`github.com/OthmanAdi/planning-with-files`，v2.43.0，245 commits）精读源码与 README。该项目是 Claude Code / Cursor / Codex 的 Skill 插件，核心思想"Context Window = RAM，Filesystem = Disk"。整体对 RouteDev 是降级参考（RouteDev 已有结构化 JSONL + IPC 事件 + 多 Agent 编排），但有三个轻量技巧值得吸收：**2-Action Rule**（防止探索阶段 context 塞爆）、**5-Question Reboot Test**（compact 后快速重建 situational awareness）、**Plan Attestation**（SHA-256 锁定计划，防篡改 + 版本可追溯）。
> 2. **难度梯度 × Agent 组合**（基于 L1-L5 五级分级与 Solo/DAG/CompositionalRouter 三路径映射）。核心命题：RouteDev 的 `/goal` 目前走 GoalRunner 单 Agent 串行路径，缺乏"按任务复杂度自动选择调度路径和 Agent 组合"的能力。Phase 55 引入 LLM 驱动的难度判定 + 三路径直接映射 + 动态升降级，让 `/goal` 命令根据任务复杂度自动走 Solo（L1-L2）/ DAG（L3）/ CompositionalRouter（L4-L5）路径，并在执行中发现复杂度与预判不符时动态切换路径。
> 3. **headroom**（`github.com/headroomlabs-ai/headroom`，Apache 2.0）精读 README + architecture + CCR 文档。该项目是 AI Agent 的上下文压缩层（60-95% token 节省，库/proxy/MCP 多种接入，本地优先，可逆）。核心创新：**CCR 可逆压缩**（压缩后原始数据本地缓存，LLM 按需 retrieve）、**CacheAligner 前缀稳定化**（提取动态内容移到末尾，稳定前缀命中 KV cache）、**IntelligentContext 6 维评分**（recency/语义相似/TOIN重要性/错误指示/前向引用/token密度 决定丢弃哪些消息）、**Output token reduction**（effort routing + verbosity steering，不光压输入也压输出）、**headroom learn 失败挖掘**（从失败会话挖掘模式自动写入修正文件）。RouteDev 不复刻 SmartCrusher/CodeCompressor/Kompress 模型（那是 headroom 的核心壁垒，复刻成本极高），只吸收上述 5 个机制层面的借鉴点。
> **核心约束（继承 Phase 51 反写死原则，本 Phase 强化）：** 每个 Task 必须包含三要素：① 配置接入（Zod schema 字段 + 默认值 + 校验范围）② 设置页面接入（TabId + 控件类型）③ 代码接线点（文件级操作表格，含文件路径 + 函数/方法名 + 接入动作）。**杜绝"写了但不接入"的孤立代码——任何没有接线点表的 Task 视为未完成。每个新工具函数必须有调用方，每个新 schema 字段必须有设置页控件，每个新 hook 必须有触发点。**

---

## Part A：planning-with-files 借鉴落地

### A.1 三个借鉴点与 RouteDev 缺口的映射

| # | planning-with-files 机制 | RouteDev 现状缺口 | Phase 55 Task |
|---|--------------------------|-------------------|---------------|
| 1 | 2-Action Rule（每 2 次 view/browser 后强制写 findings.md） | L4/L5 的 Researcher 角色在探索阶段无强制 flush 机制，Read/SearchCodebase 高频调用导致 context 塞爆 | Task 1 |
| 2 | 5-Question Reboot Test（compact 后回答 5 个问题重建上下文） | PreCompact hook 只 reminder flush progress；compact 后 Agent 丢失 goal/已完成步骤/阻塞/下一步/约束 | Task 2 |
| 3 | Plan Attestation（SHA-256 锁定 task_plan.md，hooks 检测篡改） | goalId 聚合是软关联；plan 修订后旧 step 结果无归档；无 plan 版本控制 | Task 3 |

### A.2 Part A 源码接线点速查

| 接线点 | 文件 | 关键位置 | 备注 |
|--------|------|----------|------|
| Researcher AgentProfile | `src/agents/profiles/` | researcher profile | systemPrompt 注入 2-Action Rule |
| 工具调用事件 | `src/agent/loop.ts` | 工具调用后回调 | 计数器 + flush 触发 |
| session_memory 写入 | `src/storage/session-memory.ts` | 已有机制 | 复用 appendSessionMemory |
| PreCompact hook | `src/hooks/precompact.ts` | Phase 54 已引入 | 扩展为 Reboot Test |
| compact 完成事件 | `src/agent/loop.ts` 或事件系统 | compact 后回调 | 注入 5 问 system message |
| GoalPlan 类型 | `src/agent/goal-types.ts` | GoalPlan 接口 | 新增 attestation 字段 |
| plan 确认环节 | `src/cli/goal-runner.ts` | requestPlanEdit | 插入 attest 点 |
| plan 执行入口 | `src/cli/goal-runner.ts` | executeGoalPlan | 校验 attestation |
| 旧版本归档 | `src/storage/` | 新建 plan-archive | 修订时归档旧版本 |

---

## Part B：难度路由多 Agent 组合

### B.1 决策汇总（基于头脑风暴确认）

| # | 决策项 | 选择 | 理由 |
|---|--------|------|------|
| 1 | **判定机制** | 完全由 LLM 判定，不用规则预筛 | 任务复杂度难以用简单规则捕捉，LLM 能理解规则无法表达的细微差别 |
| 2 | **LLM 判定输入** | 需求描述 + L1-L5 级别定义 + 项目摘要（轻量） | 轻量上下文即可，不需要完整 codegraph 索引 |
| 3 | **判定时机** | 解析时初判 + 执行时修正 | GoalParser 输出初步 level，executeGoalPlan 根据实际 plan 修正 |
| 4 | **路径映射** | 三路径直接映射：L1-L2→Solo，L3→DAG，L4-L5→CompositionalRouter | 复用现有路径，L5 的 Researcher/Critic 作为 CompositionalRouter 前后置阶段 |
| 5 | **模型选择** | 复用现有 AgentProfile 模型配置，按级别扩展 | 不新建配置机制，改造现有的 |
| 6 | **动态升降级** | 允许升降级 | 执行中发现复杂度与预判不符可切换路径 |
| 7 | **状态迁移** | 保留已完成步骤（Blackboard 快照带入新路径），未完成步骤重规划 | 不浪费已完成工作 |
| 8 | **角色配置** | 预置默认角色组合 + 用户可调整 | 复用 AgentProfile 体系 |

### B.2 架构总览

```
用户输入 /goal
    │
    ▼
GoalParser.parse() ── LLM 判定 level（输入：需求+级别定义+项目摘要）
    │                 输出：GoalPlan { level: L1-L5, steps, ... }
    ▼
requestPlanEdit() ── 用户确认计划（UI 显示 level + 路径）
    │
    ▼
executeGoalPlan() ── 执行时修正 level（基于实际 plan 的步骤数/依赖图/领域）
    │
    ├── L1-L2 → executePlanSequential()    [Solo 路径]
    ├── L3   → executePlanWithDAG()        [DAG 路径]
    └── L4-L5→ executePlanWithRouter()     [CompositionalRouter 路径]
                    ├── L5 前置：Researcher 调研
                    ├── L4/L5 主体：多 Executor + Reviewer + Tester
                    └── L5 后置：Critic 红队审查
    │
    ▼
动态升降级检测 ── GoalAuditor/BoundedRecovery 触发
    │   升级：保留已完成步骤 Blackboard 快照 → 重规划未完成 → 切换路径
    │   降级：同上
    ▼
verifyPlan() + runCompletionGate() ── 验收
```

### B.3 难度梯度 × Agent 组合总表

| 级别 | 典型任务 | 调度路径 | Agent 组合（默认） | 验证机制 |
|------|----------|----------|-------------------|----------|
| **L1 极简** | 改常量、修 typo、调样式值 | Solo | executor | 构建 / lint |
| **L2 简单** | 独立小函数、明确 bug 修复 | Solo | executor（+ self-check） | 构建 + 单测 |
| **L3 中等** | 完整功能模块、单类重构 | DAG | architect + executor + reviewer | DualLoop（异模型验证） |
| **L4 复杂** | 跨模块新功能、框架迁移 | CompositionalRouter | architect + executor×N + reviewer + tester | DualLoop + 独立 Tester + Phase Review |
| **L5 极难** | 架构级迁移、跨未知领域探索 | CompositionalRouter + 前后置 | researcher + architect + executor×N + reviewer + tester + critic | 多轮对抗审查 + 实跑 + 用户终审 |

### B.4 Part B 源码接线点速查

| 接线点 | 文件 | 关键位置 | 备注 |
|--------|------|----------|------|
| GoalParser | `src/agent/goal-parser.ts` | parse 方法 | 调用 DifficultyAssessor |
| GoalPlan 类型 | `src/agent/goal-types.ts` | GoalPlan 接口 | 新增 level 字段 |
| 路径选择 | `src/cli/goal-runner.ts` | executeGoalPlan | 根据 level 分支 |
| DAG 路径 | `src/cli/goal-runner.ts` | executePlanWithDAG | Phase 54 已引入 |
| Router 路径 | `src/cli/goal-runner.ts` | executePlanWithRouter | 新增，复用 ExecutionOrchestrator |
| 升降级检测 | `src/cli/goal-runner.ts` | 动态升降级钩子 | BoundedRecovery 触发 |
| 状态迁移 | `src/agent/state-migration.ts` | 新建 | Blackboard 快照 + 重规划 |
| AgentProfile | `src/agents/profiles/types.ts` | 已有 | 复用，不新建角色体系 |
| 根 schema | `src/config/schema.ts` | AppConfigSchema | 新增 DifficultyRoutingSchema |
| 设置页 Tab | `desktop/renderer/src/pages/SettingsPage.tsx` | Tab 注册 | 新增 'difficulty-routing' tab |

---

## Part C：headroom 压缩层借鉴落地

### C.1 五个借鉴点与 RouteDev 缺口的映射

| # | headroom 机制 | RouteDev 现状缺口 | Phase 55 Task |
|---|---------------|-------------------|---------------|
| 9 | CCR 可逆压缩（Compress-Cache-Retrieve，压缩后原始数据本地缓存，LLM 按需 retrieve） | RouteDev 的 compact 是破坏性的，被压缩/丢弃的 context 永久丢失，无法恢复 | Task 9 |
| 10 | CacheAligner 前缀稳定化（提取 system prompt 动态内容移到末尾，稳定前缀命中 KV cache） | Phase 51 的 WorkerExecutor fixed prefix caching 受 system prompt 中动态字段（日期/session id/用户名）影响导致缓存失效 | Task 10 |
| 11 | IntelligentContext 6 维评分（recency/语义相似/重要性/错误指示/前向引用/token密度 决定丢弃哪些消息） | RouteDev 的 compact 按 rolling window 丢最旧消息，不区分重要性，可能丢掉关键错误信息 | Task 11 |
| 12 | Output token reduction（effort routing + verbosity steering，routine 步骤降 thinking effort） | RouteDev 模型输出全保留，包括 "Let me..." 前言和 routine 步骤的深度 thinking，浪费 output token | Task 12 |
| 13 | headroom learn 失败挖掘（从失败会话挖掘模式自动写入修正文件） | RouteDev 的 SelfEvolution 框架是 Phase 54 设计但未落地；失败会话的经验没有自动沉淀到 project_memory | Task 13 |

### C.2 不借鉴的部分（明确排除，避免执行者误建空壳）

| headroom 组件 | 排除原因 |
|---------------|----------|
| SmartCrusher（JSON 统计采样压缩） | headroom 核心壁垒，复刻成本极高；RouteDev 的工具输出量级不需要 JSON 字段级压缩 |
| CodeCompressor（AST 感知代码压缩） | 同上；RouteDev 的代码读取走 rtk read 已有压缩，不复刻 AST 压缩 |
| Kompress-base（HuggingFace ML 模型） | 需要训练数据和 GPU 推理，RouteDev 是本地优先的轻量应用，不适合引入 ML 推理依赖 |
| Proxy 模式（拦截 LLM 请求） | RouteDev 是独立 app，不走 proxy 拦截模式 |
| 13 个 agent wrap adapter | 与 planning-with-files 同理，对 RouteDev 无价值 |
| Image compression | RouteDev 不处理图片 |
| Cross-agent memory 跨 agent 共享存储 | RouteDev 已有 Blackboard 机制，不需要额外的跨 agent 内存层 |
| TOIN 跨会话学习 | 中价值，记录为未来 Phase 展望，不在 Phase 55 落地 |

### C.3 Part C 源码接线点速查

| 接线点 | 文件 | 关键位置 | 备注 |
|--------|------|----------|------|
| compact 触发点 | `src/agent/loop.ts` | compact 调用前 | Task 9：compact 前缓存原始消息 |
| retrieve 工具 | `src/tools/builtin/` | 新建 ccr-retrieve.ts | Task 9：LLM 按需取回 |
| CCR 缓存存储 | `src/storage/ccr-cache.ts` | 新建 | Task 9：LRU + hash 索引 |
| LLM 请求构造 | `src/agent/loop.ts` | 构造 messages 前 | Task 10：CacheAligner 提取动态字段 |
| WorkerExecutor | `src/agent/multi/worker-executor.ts` | splitSystemPrompt | Task 10：接入 CacheAligner |
| compact 消息选择 | `src/agent/loop.ts` | compact 丢弃逻辑 | Task 11：IntelligentContext 评分替换 rolling window |
| 消息评分器 | `src/agent/context-scorer.ts` | 新建 | Task 11：6 维评分 |
| LLM 调用参数 | `src/agent/loop.ts` | llmClient.complete 调用 | Task 12：effort routing 注入 thinking budget |
| 输出后处理 | `src/agent/loop.ts` | 响应处理后 | Task 12：verbosity steering 裁剪 |
| 失败会话检测 | `src/cli/goal-runner.ts` | runCompletionGate 失败分支 | Task 13：触发 learn |
| project_memory 写入 | `src/storage/project-memory.ts` | appendToProjectMemory | Task 13：复用已有机制 |
| 根 schema | `src/config/schema.ts` | AppConfigSchema | Task 9-13：新增 5 个 Schema |
| 设置页 Tab | `desktop/renderer/src/pages/SettingsPage.tsx` | execution tab 扩展 | Task 9-13：5 组控件 |

---

## 核心设计原则

### 原则 1：轻量借鉴，不引入新框架（Part A）

planning-with-files 是 markdown 文件 + bash 脚本的轻量实现。RouteDev 已有结构化 JSONL + IPC 事件 + 多 Agent 编排。Part A 只吸收三个 prompt/hook 层面的技巧，不倒退回裸 markdown，不引入新的存储引擎。

### 原则 2：LLM 驱动的难度判定，不用规则预筛（Part B）

任务复杂度难以用简单规则捕捉（如"步骤数=4"可能是 L2 也可能是 L3，取决于领域和破坏性）。完全由 LLM 判定，输入需求描述 + L1-L5 级别定义 + 项目摘要（轻量），输出 level + reasoning。这比规则预筛更准确，且可解释。

### 原则 3：三路径直接映射，复用现有引擎（Part B）

L1-L2→Solo（GoalRunner 串行），L3→DAG（Orchestrator + WorkerExecutor），L4-L5→CompositionalRouter（ExecutionOrchestrator）。L5 的 Researcher/Critic 作为 CompositionalRouter 的前置/后置阶段插入，不新建路径。这与 Phase 54 的架构统一层对齐。

### 原则 4：允许动态升降级，状态迁移保留已完成工作（Part B）

执行中发现复杂度与预判不符时允许切换路径。升降级时保留已完成步骤的 Blackboard 快照，未完成步骤交给新路径重新规划。不浪费已完成工作。

### 原则 5：配置驱动 + 默认关闭（Part A + B）

所有新能力都通过配置开关控制，默认关闭（避免破坏现有测试）。开启后才生效，关闭时退回原行为。Phase 54 的 DEMO_MODE_CONFIG_OVERRIDE 叠加开启所有新能力。

### 原则 6：反写死（继承 Phase 51 约束，本 Phase 强化）

每个 Task 必须包含三要素：① 配置接入（Zod schema 字段）② 设置页面接入（TabId + 控件）③ 代码接线点（文件级操作表格）。**本 Phase 强化：每个新工具函数必须列出调用方，每个新 schema 字段必须列出设置页控件，每个新 hook 必须列出触发点。没有接线点表的 Task 视为未完成，执行者不得提交。**

### 原则 7：机制层借鉴，不复刻壁垒（Part C）

headroom 的 SmartCrusher/CodeCompressor/Kompress 模型是其核心壁垒，复刻成本极高且偏离 RouteDev 定位。Part C 只吸收 5 个机制层面的借鉴点（CCR/CacheAligner/IntelligentContext/Output reduction/learn），每个都适配 RouteDev 的现有架构（compact/WorkerExecutor/loop.ts/goal-runner），不引入 ML 推理依赖，不引入 proxy 模式。明确排除的部分见 C.2 表格。

### 原则 8：CCR 让 compact 从破坏性变可逆（Part C）

RouteDev 现有的 compact 是破坏性操作——被压缩/丢弃的 context 永久丢失。Part C Task 9 的 CCR 机制让 compact 变可逆：compact 前把原始消息存入本地 LRU cache，注入 `ccr_retrieve` 工具，LLM 按需取回。这与 Part A Task 2 的 Reboot Test 协同——Reboot Test 重建上下文时，Agent 可通过 retrieve 工具取回被 compact 的关键信息。

---

## Task 1：2-Action Rule for Researcher——探索阶段强制 flush（≥ 5 测试）

### 1.1 借鉴来源

**planning-with-files 2-Action Rule**（`skills/planning-with-files/SKILL.md`）：
> Save findings after every 2 view/browser operations

- 每完成 2 次 view/browser 操作，强制把发现写入 `findings.md`
- 目的：防止 Agent 在探索阶段把 context 塞满，重要的发现写盘而非留在 volatile context
- 触发条件：view/browser 操作计数器达到 2 的倍数

### 1.2 RouteDev 缺口

- L4/L5 的 Researcher 角色在探索阶段调用 Read/SearchCodebase/Grep 高频，无强制 flush 机制
- 探索发现全留在 conversation history，context 膨胀后触发 compact，发现可能丢失
- 现有 session_memory 是被动写入（Agent 自行决定何时写），无主动触发机制

### 1.3 落地设计

```typescript
// src/agents/profiles/researcher.ts（修改 Researcher AgentProfile 的 systemPrompt）

/**
 * 2-Action Rule 注入 Researcher systemPrompt
 * 借鉴 planning-with-files 的 2-Action Rule
 *
 * 核心规则：每完成 N 次探索性工具调用（Read/SearchCodebase/Grep/Glob），
 * 必须调用 write_memory 工具把关键发现写入 session_memory。
 * N 默认为 3（RouteDev 的探索工具比 view/browser 更重，3 比 2 更合理）。
 */
export const RESEARCHER_2ACTION_RULE_PROMPT = `
## 探索阶段强制 flush 规则（2-Action Rule）

你在探索阶段会高频调用 Read/SearchCodebase/Grep/Glob 等工具。
为防止 context 膨胀导致发现丢失，你必须遵守以下规则：

**每完成 {{flushInterval}} 次探索性工具调用，必须调用 write_memory 工具写入一条 session_memory 记录。**

写入内容要求：
- topic: 当前探索主题（如"代码地图引擎的索引结构"）
- detail: 关键发现摘要（3-5 句话，含 file:line 证据）
- confidence: high/medium/low
- sources: 相关文件路径或符号路径

**禁止**把发现只留在对话历史中——context window 是易失的 RAM，session_memory 是持久的 Disk。

当配置 explorationFlushEnabled=false 时，此规则不生效。
`;

export function buildResearcherSystemPrompt(config: ResearcherConfig): string {
  const basePrompt = RESEARCHER_BASE_PROMPT;
  if (config.explorationFlushEnabled) {
    return basePrompt + RESEARCHER_2ACTION_RULE_PROMPT.replace(
      '{{flushInterval}}',
      String(config.flushInterval),
    );
  }
  return basePrompt;
}
```

```typescript
// src/agent/loop.ts（修改工具调用后回调，新增探索计数器 + flush 触发）

/**
 * 探索性工具调用计数器
 * 借鉴 planning-with-files 的 2-Action 计数
 *
 * 当连续探索性工具调用达到 flushInterval 时，注入提醒消息
 */
const EXPLORATION_TOOLS = ['read', 'search_codebase', 'grep', 'glob', 'web_search', 'web_fetch'];

export class ExplorationFlushTracker {
  private explorationCount = 0;
  private lastFlushCount = 0;

  constructor(
    private flushInterval: number = 3,
    private onFlushDue: () => void,
  ) {}

  /** 工具调用后调用此方法 */
  recordToolCall(toolName: string): void {
    if (!EXPLORATION_TOOLS.includes(toolName)) return;
    this.explorationCount++;
    if (this.explorationCount - this.lastFlushCount >= this.flushInterval) {
      this.onFlushDue();
      this.lastFlushCount = this.explorationCount;
    }
  }

  /** write_memory 调用后重置计数器 */
  resetAfterFlush(): void {
    this.lastFlushCount = this.explorationCount;
  }

  get currentCount(): number {
    return this.explorationCount;
  }
}
```

### 1.4 配置接入

```typescript
// src/config/schema.ts 扩展（在 AgentProfileSchema 或 ResearcherConfigSchema 附近）

export const ExplorationFlushSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用探索阶段强制 flush（2-Action Rule） */
  explorationFlushEnabled: z.boolean().default(false),
  /** 触发 flush 的探索性工具调用次数（默认 3） */
  flushInterval: z.number().int().min(2).max(10).default(3),
  /** 哪些角色启用此规则（默认仅 researcher） */
  enabledRoles: z.array(z.enum(['researcher', 'executor', 'reviewer', 'custom'])).default(['researcher']),
  /** flush 提醒方式：'system_message'（注入 system 消息）或 'tool_hint'（工具调用提示） */
  flushReminderMode: z.enum(['system_message', 'tool_hint']).default('system_message'),
}));
```

| 字段 | schema 位置 | 类型 | 默认值 | 校验 |
|------|-------------|------|--------|------|
| `explorationFlush.explorationFlushEnabled` | schema.ts 新增 | boolean | false | — |
| `explorationFlush.flushInterval` | 同上 | number | 3 | 2-10 |
| `explorationFlush.enabledRoles` | 同上 | array | ['researcher'] | role 枚举 |
| `explorationFlush.flushReminderMode` | 同上 | enum | 'system_message' | — |

**根 schema 接入点**：在 `AppConfigSchema` 中新增 `explorationFlush: ExplorationFlushSchema`。

### 1.5 设置页面接入

- **TabId**：扩展 `'subagents'` tab（已存在）
- **控件**：
  - `explorationFlushEnabled`：Toggle 开关 + 说明"开启后 Researcher 每完成 N 次探索工具调用强制写入 session_memory"
  - `flushInterval`：NumberInput（2-10）+ 说明"推荐 3，过小会频繁打断，过大会失去 flush 意义"
  - `enabledRoles`：Checkbox 组（researcher/executor/reviewer/custom）
  - `flushReminderMode`：RadioGroup（system_message/tool_hint）
- **组件**：扩展 `SettingsSubAgentsTab`

### 1.6 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新增 ExplorationFlushSchema | `src/config/schema.ts` | AgentProfileSchema 附近 | 新字段 |
| 接入根 schema | `src/config/schema.ts` | AppConfigSchema | 新增字段 |
| 修改 Researcher systemPrompt | `src/agents/profiles/researcher.ts` | buildResearcherSystemPrompt | 注入 2-Action Rule |
| 新增 ExplorationFlushTracker | `src/agent/loop.ts` | 工具调用后回调 | 计数器 + flush 触发 |
| 接入工具调用事件 | `src/agent/loop.ts` | 工具执行后 | recordToolCall |
| 接入 write_memory 重置 | `src/tools/builtin/write-memory.ts` | 工具执行后 | resetAfterFlush |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | subagents tab | 扩展组件 |

### 1.7 测试要求

- `explorationFlushEnabled=false` 时 Researcher systemPrompt 不含 2-Action Rule
- `explorationFlushEnabled=true` 时 systemPrompt 含 2-Action Rule 且 flushInterval 正确替换
- `ExplorationFlushTracker` 探索性工具计数正确
- 计数达到 flushInterval 时触发 onFlushDue
- write_memory 调用后 lastFlushCount 更新（不重复触发）

---

## Task 2：5-Question Reboot Test——compact 后上下文重建（≥ 5 测试）

### 2.1 借鉴来源

**planning-with-files 5-Question Reboot Test**（v2.0.0 文档）：
- 上下文被 compact 后，Agent 用 5 个问题快速重建 situational awareness
- 5 个问题覆盖：当前 goal / 已完成步骤 / 当前阻塞 / 下一步 / 关键约束
- 目的：compact 是破坏性操作，直接继续会导致 Agent "失忆"，Reboot Test 强制重建上下文

### 2.2 RouteDev 缺口

- PreCompact hook（Phase 54 借鉴 v2.38.0 引入）目前只 reminder flush progress + 打印 Plan-SHA256
- compact 完成后 Agent 直接继续，无 situational awareness 重建机制
- L4/L5 长任务经历多次 compact 后，Agent 逐渐丢失原始 goal 和约束

### 2.3 落地设计

```typescript
// src/hooks/reboot-test.ts（新建文件）

/**
 * 5-Question Reboot Test
 * 借鉴 planning-with-files 的 5-Question Reboot Test
 *
 * compact 完成后，向 Agent 注入 5 个问题作为 system message，
 * 强制 Agent 重建 situational awareness 后再继续。
 *
 * 5 个问题：
 * 1. 当前 goal 是什么？（从 active plan 提取）
 * 2. 已完成哪些步骤？（从 progress 提取）
 * 3. 当前阻塞是什么？（从最近 error/failed 事件提取）
 * 4. 下一步应该做什么？（从 plan 的 pending 步骤提取）
 * 5. 关键约束有哪些？（从 project_memory 的 Hard Constraints 提取）
 */
export const REBOOT_TEST_QUESTIONS = [
  '当前 goal 是什么？请用一句话描述你正在完成的目标。',
  '已完成哪些步骤？请列出已完成的 stepId 和简要总结。',
  '当前阻塞是什么？如果没有阻塞，回答"无阻塞"。',
  '下一步应该做什么？请指出下一个 pending 的 stepId 和计划动作。',
  '关键约束有哪些？请列出当前任务必须遵守的 2-3 条硬约束。',
];

export interface RebootTestContext {
  goalDescription: string;
  completedSteps: Array<{ stepId: number; summary: string }>;
  currentBlocker?: string;
  nextPendingStep?: { stepId: number; description: string };
  hardConstraints: string[];
}

/**
 * 构建 Reboot Test 的 system message
 * 包含上下文摘要 + 5 个问题
 */
export function buildRebootTestMessage(ctx: RebootTestContext): string {
  const contextSummary = `
## Compact 后上下文重建（5-Question Reboot Test）

你刚刚经历了 context compact，部分历史上下文已被压缩。在继续工作前，请先回答以下 5 个问题重建 situational awareness。

### 上下文摘要（系统自动提取）

**当前 goal：** ${ctx.goalDescription}

**已完成步骤：**
${ctx.completedSteps.length > 0
  ? ctx.completedSteps.map(s => `- Step ${s.stepId}: ${s.summary}`).join('\n')
  : '- （无已完成步骤）'}

**当前阻塞：** ${ctx.currentBlocker ?? '无阻塞'}

**下一步：** ${ctx.nextPendingStep
  ? `Step ${ctx.nextPendingStep.stepId}: ${ctx.nextPendingStep.description}`
  : '（无 pending 步骤，任务可能已完成）'}

**关键约束：**
${ctx.hardConstraints.length > 0
  ? ctx.hardConstraints.map(c => `- ${c}`).join('\n')
  : '- （无特定约束）'}

### 请回答以下 5 个问题（回答后继续工作）

${REBOOT_TEST_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n')}
`;

  return contextSummary;
}

/**
 * 从当前会话状态提取 Reboot Test 上下文
 */
export function extractRebootTestContext(
  activePlan: GoalPlan | undefined,
  progressLog: ProgressEntry[],
  recentErrors: ErrorEntry[],
  projectMemory: { hardConstraints: string[] } | undefined,
): RebootTestContext {
  const completedSteps = activePlan?.steps
    .filter(s => s.status === 'completed')
    .map(s => ({ stepId: s.id, summary: s.description })) ?? [];

  const nextPendingStep = activePlan?.steps
    .find(s => s.status === 'pending' || s.status === 'in_progress');

  return {
    goalDescription: activePlan?.description ?? '（无 active plan）',
    completedSteps,
    currentBlocker: recentErrors.length > 0
      ? recentErrors[recentErrors.length - 1]?.message
      : undefined,
    nextPendingStep: nextPendingStep
      ? { stepId: nextPendingStep.id, description: nextPendingStep.description }
      : undefined,
    hardConstraints: projectMemory?.hardConstraints ?? [],
  };
}
```

```typescript
// src/hooks/precompact.ts（修改现有 PreCompact hook）

/**
 * 扩展 PreCompact hook：compact 完成后注入 Reboot Test
 * 借鉴 planning-with-files 的 5-Question Reboot Test
 */
export class PreCompactHook {
  constructor(
    private config: RebootTestConfig,
    private activePlanProvider: () => GoalPlan | undefined,
    private progressProvider: () => ProgressEntry[],
    private errorProvider: () => ErrorEntry[],
    private projectMemoryProvider: () => { hardConstraints: string[] } | undefined,
    private messageInjector: (msg: { role: 'system'; content: string }) => void,
  ) {}

  /** compact 前的回调（原有逻辑：reminder flush progress） */
  onPreCompact(): void {
    // 原有逻辑：reminder flush progress + 打印 Plan-SHA256
    this.remindFlushProgress();
  }

  /** compact 完成后的回调（新增：注入 Reboot Test） */
  onPostCompact(): void {
    if (!this.config.rebootTestEnabled) return;

    const ctx = extractRebootTestContext(
      this.activePlanProvider(),
      this.progressProvider(),
      this.errorProvider(),
      this.projectMemoryProvider(),
    );
    const message = buildRebootTestMessage(ctx);
    this.messageInjector({ role: 'system', content: message });
  }
}
```

### 2.4 配置接入

```typescript
// src/config/schema.ts 扩展

export const RebootTestSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 compact 后 Reboot Test */
  rebootTestEnabled: z.boolean().default(false),
  /** Reboot Test 注入时机：'immediate'（compact 后立即）或 'next_turn'（下一轮对话开始） */
  injectionTiming: z.enum(['immediate', 'next_turn']).default('immediate'),
  /** 是否在 Reboot Test 中包含 project_memory 的 Hard Constraints */
  includeHardConstraints: z.boolean().default(true),
  /** Hard Constraints 最大显示数量（防止过长） */
  maxHardConstraintsDisplay: z.number().int().min(1).max(10).default(5),
  /** 是否要求 Agent 显式回答 5 问（false 时只注入上下文摘要，不强制回答） */
  requireExplicitAnswers: z.boolean().default(true),
}));
```

| 字段 | schema 位置 | 类型 | 默认值 | 校验 |
|------|-------------|------|--------|------|
| `rebootTest.rebootTestEnabled` | schema.ts 新增 | boolean | false | — |
| `rebootTest.injectionTiming` | 同上 | enum | 'immediate' | — |
| `rebootTest.includeHardConstraints` | 同上 | boolean | true | — |
| `rebootTest.maxHardConstraintsDisplay` | 同上 | number | 5 | 1-10 |
| `rebootTest.requireExplicitAnswers` | 同上 | boolean | true | — |

### 2.5 设置页面接入

- **TabId**：扩展 `'execution'` tab（已存在）
- **控件**：
  - `rebootTestEnabled`：Toggle 开关 + 说明"compact 后注入 5 问上下文重建"
  - `injectionTiming`：RadioGroup（immediate/next_turn）+ 说明
  - `includeHardConstraints`：Toggle 开关
  - `maxHardConstraintsDisplay`：NumberInput（1-10）
  - `requireExplicitAnswers`：Toggle 开关 + 说明"开启后 Agent 必须显式回答 5 问才能继续"
- **组件**：扩展 `SettingsExecutionTab`

### 2.6 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新增 RebootTestSchema | `src/config/schema.ts` | PreCompact 配置附近 | 新字段 |
| 接入根 schema | `src/config/schema.ts` | AppConfigSchema | 新增字段 |
| 新建 reboot-test.ts | `src/hooks/reboot-test.ts` | — | 新文件 |
| 修改 PreCompact hook | `src/hooks/precompact.ts` | onPostCompact | 注入 Reboot Test |
| 接入 compact 完成事件 | `src/agent/loop.ts` 或事件系统 | compact 后回调 | 调用 onPostCompact |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | execution tab | 扩展组件 |

### 2.7 测试要求

- `rebootTestEnabled=false` 时 compact 后不注入消息
- `buildRebootTestMessage` 包含 5 个问题
- `extractRebootTestContext` 正确提取 goal/completedSteps/blocker/nextStep/constraints
- `includeHardConstraints=false` 时上下文摘要不含约束
- `injectionTiming='next_turn'` 时延迟到下一轮对话注入

---

## Task 3：Plan Attestation——SHA-256 锁定与版本归档（≥ 5 测试）

### 3.1 借鉴来源

**planning-with-files Plan Attestation**（v2.37.0）：
- `/plan-attest` 命令用 SHA-256 锁定 `task_plan.md`
- hooks 在 plan 被篡改时阻止注入
- 目的：计划确认后不可被擅自修改，修订必须重新 attest
- 借鉴价值：RouteDev 的 goalId 聚合是软关联，plan 修订后旧 step 结果无归档

### 3.2 RouteDev 缺口

- goalId 聚合是软关联——消息通过 `[[goal:{goalId}]]` marker 关联，但 plan 本身无 hash 锁定
- plan 修订（用户在 `requestPlanEdit` 修改步骤）后，旧版本丢失，无法追溯
- 无"plan 被擅自修改"检测——执行中途 plan 被改会导致 step 结果与 plan 不匹配

### 3.3 落地设计

```typescript
// src/agent/plan-attestation.ts（新建文件）

/**
 * Plan Attestation——SHA-256 锁定与版本归档
 * 借鉴 planning-with-files v2.37.0 的 Plan Attestation
 *
 * 核心机制：
 * 1. plan 确认后计算 SHA-256 hash，存入 attestation 字段
 * 2. 执行前校验 hash——不匹配则拒绝执行（防篡改）
 * 3. plan 修订时归档旧版本（带 hash + 时间戳），重新 attest 新版本
 * 4. 归档版本可用于追溯"plan 修订历史"
 */

import { createHash } from 'crypto';

export interface PlanAttestation {
  /** plan 内容的 SHA-256 hash */
  hash: string;
  /** attest 时间戳 */
  attestedAt: number;
  /** attest 时的 plan 版本号（从 1 递增） */
  version: number;
  /** attest 触发者：'user_confirm' / 'auto' / 'revision' */
  attestedBy: string;
}

export interface ArchivedPlanVersion {
  /** 归档版本的 attestation */
  attestation: PlanAttestation;
  /** 归档时的完整 plan 快照 */
  planSnapshot: GoalPlan;
  /** 归档原因：'revision' / 'execution_start' */
  archiveReason: string;
}

/**
 * 计算 plan 的 SHA-256 hash
 * 借鉴 planning-with-files 的 attest-plan.sh
 *
 * 只对 plan 的核心字段计算 hash（steps + dependencies + verificationCriteria），
 * 不包含 status 等运行时字段（否则 step 状态变化会导致 hash 不匹配）
 */
export function computePlanHash(plan: GoalPlan): string {
  const hashableContent = {
    description: plan.description,
    steps: plan.steps.map(s => ({
      id: s.id,
      description: s.description,
      dependsOn: s.dependsOn,
      acceptanceCriteria: s.acceptanceCriteria,
    })),
    verificationCriteria: plan.verificationCriteria,
  };
  const json = JSON.stringify(hashableContent);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * 锁定 plan——计算 hash 并写入 attestation 字段
 */
export function attestPlan(
  plan: GoalPlan,
  attestedBy: string = 'user_confirm',
): GoalPlan {
  const version = (plan.attestation?.version ?? 0) + 1;
  const hash = computePlanHash(plan);
  return {
    ...plan,
    attestation: {
      hash,
      attestedAt: Date.now(),
      version,
      attestedBy,
    },
  };
}

/**
 * 校验 plan 的 attestation——执行前调用
 * 返回 { valid, reason }
 */
export function verifyPlanAttestation(plan: GoalPlan): {
  valid: boolean;
  reason?: string;
} {
  if (!plan.attestation) {
    return { valid: false, reason: 'plan 未被 attest（无 attestation 字段）' };
  }
  const currentHash = computePlanHash(plan);
  if (currentHash !== plan.attestation.hash) {
    return {
      valid: false,
      reason: `plan hash 不匹配（attested: ${plan.attestation.hash.slice(0, 8)}..., current: ${currentHash.slice(0, 8)}...），plan 可能被篡改`,
    };
  }
  return { valid: true };
}

/**
 * 归档当前 plan 版本（修订前调用）
 * 借鉴 planning-with-files 的"修订必须重新 attest"理念
 */
export function archiveCurrentPlan(
  currentPlan: GoalPlan,
  archiveReason: string,
): ArchivedPlanVersion {
  return {
    attestation: currentPlan.attestation!,
    planSnapshot: { ...currentPlan },
    archiveReason,
  };
}
```

```typescript
// src/agent/goal-types.ts（修改 GoalPlan 接口）

export interface GoalPlan {
  // ... 原有字段
  /** Phase 55 新增：plan attestation（SHA-256 锁定） */
  attestation?: PlanAttestation;
  /** Phase 55 新增：归档的历史版本（修订时归档） */
  archivedVersions?: ArchivedPlanVersion[];
}
```

```typescript
// src/cli/goal-runner.ts（修改 requestPlanEdit 和 executeGoalPlan）

/**
 * 在 requestPlanEdit 中插入 attest 点
 * 用户确认 plan 后，计算 hash 并锁定
 */
private async requestPlanEdit(plan: GoalPlan): Promise<boolean> {
  // 原有：用户编辑 plan
  const confirmed = await this.showStepEditor(plan);
  if (!confirmed) return false;

  // 新增：attest plan（若启用）
  if (this.config.planAttestation?.attestationEnabled) {
    const attestedPlan = attestPlan(plan, 'user_confirm');
    Object.assign(plan, attestedPlan);
    this.logger.info(`Plan attested: hash=${plan.attestation!.hash.slice(0, 8)}..., version=${plan.attestation!.version}`);
  }
  return true;
}

/**
 * 在 executeGoalPlan 中插入校验点
 * 执行前校验 attestation，防篡改
 */
private async executeGoalPlan(plan: GoalPlan): Promise<void> {
  // 新增：校验 attestation
  if (this.config.planAttestation?.attestationEnabled) {
    const verification = verifyPlanAttestation(plan);
    if (!verification.valid) {
      throw new Error(`Plan attestation 校验失败：${verification.reason}`);
    }
  }

  // 原有：执行逻辑
  // ...
}

/**
 * plan 修订时归档旧版本 + 重新 attest
 * 在 plan 被修改时调用（如迭代闭环中 GoalAuditor 要求修改 plan）
 */
private async revisePlan(
  currentPlan: GoalPlan,
  revisedPlan: GoalPlan,
): Promise<GoalPlan> {
  if (this.config.planAttestation?.attestationEnabled && currentPlan.attestation) {
    // 归档旧版本
    const archived = archiveCurrentPlan(currentPlan, 'revision');
    revisedPlan.archivedVersions = [
      ...(currentPlan.archivedVersions ?? []),
      archived,
    ];
    // 重新 attest 新版本
    return attestPlan(revisedPlan, 'revision');
  }
  return revisedPlan;
}
```

### 3.4 配置接入

```typescript
// src/config/schema.ts 扩展

export const PlanAttestationSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 plan attestation（SHA-256 锁定） */
  attestationEnabled: z.boolean().default(false),
  /** 是否在执行前强制校验 attestation（false 时只记录不阻止） */
  enforceVerification: z.boolean().default(true),
  /** 是否归档修订前的旧版本 */
  archiveRevisions: z.boolean().default(true),
  /** 最大归档版本数（防止无限膨胀） */
  maxArchivedVersions: z.number().int().min(0).max(50).default(10),
  /** hash 计算时是否包含 acceptanceCriteria（false 时只 hash steps + dependencies） */
  includeAcceptanceCriteriaInHash: z.boolean().default(true),
}));
```

| 字段 | schema 位置 | 类型 | 默认值 | 校验 |
|------|-------------|------|--------|------|
| `planAttestation.attestationEnabled` | schema.ts 新增 | boolean | false | — |
| `planAttestation.enforceVerification` | 同上 | boolean | true | — |
| `planAttestation.archiveRevisions` | 同上 | boolean | true | — |
| `planAttestation.maxArchivedVersions` | 同上 | number | 10 | 0-50 |
| `planAttestation.includeAcceptanceCriteriaInHash` | 同上 | boolean | true | — |

### 3.5 设置页面接入

- **TabId**：扩展 `'goal'` tab（已存在）
- **控件**：
  - `attestationEnabled`：Toggle 开关 + 说明"开启后 plan 确认时计算 SHA-256 锁定"
  - `enforceVerification`：Toggle 开关 + 说明"开启后执行前校验 hash，不匹配则拒绝执行"
  - `archiveRevisions`：Toggle 开关 + 说明"开启后 plan 修订时归档旧版本"
  - `maxArchivedVersions`：NumberInput（0-50）
  - `includeAcceptanceCriteriaInHash`：Toggle 开关
- **UI 显示**：在 GoalExecutionCard 的 Header 显示当前 plan 的 `hash#version`（如 `a1b2c3d4#v3`）
- **组件**：扩展 `SettingsGoalTab`

### 3.6 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新增 PlanAttestationSchema | `src/config/schema.ts` | GoalConfigSchema 附近 | 新字段 |
| 接入根 schema | `src/config/schema.ts` | AppConfigSchema | 新增字段 |
| 新建 plan-attestation.ts | `src/agent/plan-attestation.ts` | — | 新文件 |
| 修改 GoalPlan 类型 | `src/agent/goal-types.ts` | GoalPlan 接口 | 新增 attestation + archivedVersions |
| 修改 requestPlanEdit | `src/cli/goal-runner.ts` | requestPlanEdit | 插入 attest 点 |
| 修改 executeGoalPlan | `src/cli/goal-runner.ts` | executeGoalPlan 开头 | 插入校验点 |
| 新增 revisePlan | `src/cli/goal-runner.ts` | 新增方法 | 归档 + 重新 attest |
| GoalExecutionCard 显示 hash | `desktop/renderer/src/components/GoalExecutionCard.tsx` | Header | 显示 hash#version |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | goal tab | 扩展组件 |

### 3.7 测试要求

- `computePlanHash` 对相同 plan 内容返回相同 hash
- `computePlanHash` 对不同 plan 内容返回不同 hash
- `attestPlan` 写入 attestation 字段且 version 递增
- `verifyPlanAttestation` 未 attest 时返回 invalid
- `verifyPlanAttestation` hash 不匹配时返回 invalid + reason
- `archiveCurrentPlan` 归档旧版本快照
- `attestationEnabled=false` 时 requestPlanEdit/executeGoalPlan 不触发 attest/校验

---

## Task 4：DifficultyAssessor——LLM 驱动的难度判定（≥ 6 测试）

### 4.1 设计依据

基于头脑风暴决策：完全由 LLM 判定难度级别，不用规则预筛。LLM 输入为需求描述 + L1-L5 级别定义 + 项目摘要（轻量）。

### 4.2 落地设计

```typescript
// src/agent/difficulty-assessor.ts（新建文件）

/**
 * DifficultyAssessor——LLM 驱动的难度判定
 *
 * 核心机制：
 * 1. 接收需求描述 + 项目摘要
 * 2. 注入 L1-L5 级别定义作为 prompt
 * 3. LLM 输出 { level, reasoning, confidence }
 * 4. 解析时初判，执行时可根据实际 plan 修正
 *
 * 不用规则预筛——任务复杂度难以用简单规则捕捉
 */

/** L1-L5 难度级别定义（注入 LLM prompt） */
export const DIFFICULTY_LEVEL_DEFINITIONS = `
## 难度级别定义（L1-L5）

**L1 极简（Trivial）**
- 典型任务：改常量、修 typo、调样式值
- 步骤数：1
- 跨领域数：0
- 配套项数：0
- 是否破坏性：否
- 方案是否已知：已知
- 调度路径：Solo（单 Agent 串行）
- Agent 组合：executor
- 验证机制：构建 / lint

**L2 简单（Simple）**
- 典型任务：独立小函数、明确 bug 修复
- 步骤数：1-2
- 跨领域数：0
- 配套项数：1-2
- 是否破坏性：否
- 方案是否已知：已知
- 调度路径：Solo
- Agent 组合：executor（+ self-check）
- 验证机制：构建 + 单测

**L3 中等（Moderate）**
- 典型任务：完整功能模块（含配套项）、单类重构
- 步骤数：3-5
- 跨领域数：0（单领域）
- 配套项数：3-5
- 是否破坏性：否
- 方案是否已知：已知
- 调度路径：DAG（多步骤单领域并行）
- Agent 组合：architect + executor + reviewer
- 验证机制：DualLoop（异模型验证）

**L4 复杂（Complex）**
- 典型任务：跨模块新功能、框架小版本迁移、性能+重构
- 步骤数：5-10
- 跨领域数：2-4
- 配套项数：5+
- 是否破坏性：部分
- 方案是否已知：大部分已知
- 调度路径：CompositionalRouter（跨领域路由）
- Agent 组合：architect + executor×N + reviewer + tester
- 验证机制：DualLoop + 独立 Tester + Phase Review

**L5 极难（Hard）**
- 典型任务：架构级迁移、跨未知领域探索、新框架集成
- 步骤数：10+ 或未知
- 跨领域数：4+ 或未知
- 配套项数：全套 + 迁移
- 是否破坏性：是
- 方案是否已知：未知
- 调度路径：CompositionalRouter + 前后置阶段
- Agent 组合：researcher + architect + executor×N + reviewer + tester + critic
- 验证机制：多轮对抗审查 + 实跑 + 用户终审
`;

export interface DifficultyAssessment {
  /** 难度级别 L1-L5 */
  level: 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  /** LLM 判定理由（可追溯） */
  reasoning: string;
  /** 置信度 0-1（低于阈值时建议人工确认） */
  confidence: number;
  /** 评估的 6 个维度（LLM 输出，用于可追溯） */
  dimensions: {
    stepCount: '1' | '1-2' | '3-5' | '5-10' | '10+';
    crossDomainCount: '0' | '0(单领域)' | '2-4' | '4+';
    companionItemCount: '0' | '1-2' | '3-5' | '5+';
    isDestructive: boolean;
    solutionKnown: 'known' | 'mostly-known' | 'unknown';
    estimatedTokens: '<2k' | '<8k' | '<30k' | '<100k' | 'unestimable';
  };
}

export class DifficultyAssessor {
  constructor(
    private llmClient: ILLMClient,
    private config: DifficultyRoutingConfig,
    private projectSummaryProvider: () => string,
  ) {}

  /**
   * LLM 判定难度级别
   * @param requirement 用户需求描述
   * @returns DifficultyAssessment
   */
  async assess(requirement: string): Promise<DifficultyAssessment> {
    const projectSummary = this.config.projectSummarySource === 'manual'
      ? this.config.manualProjectSummary
      : this.projectSummaryProvider();

    const prompt = `${DIFFICULTY_LEVEL_DEFINITIONS}

## 项目摘要

${projectSummary}

## 用户需求

${requirement}

## 任务

请评估上述需求的难度级别（L1-L5），输出 JSON 格式：

\`\`\`json
{
  "level": "L1" | "L2" | "L3" | "L4" | "L5",
  "reasoning": "判定理由（2-3 句话）",
  "confidence": 0.0-1.0,
  "dimensions": {
    "stepCount": "1" | "1-2" | "3-5" | "5-10" | "10+",
    "crossDomainCount": "0" | "0(单领域)" | "2-4" | "4+",
    "companionItemCount": "0" | "1-2" | "3-5" | "5+",
    "isDestructive": true | false,
    "solutionKnown": "known" | "mostly-known" | "unknown",
    "estimatedTokens": "<2k" | "<8k" | "<30k" | "<100k" | "unestimable"
  }
}
\`\`\`

注意：
- 方案未知（solutionKnown=unknown）时强制升级到 L5
- 跨领域数 ≥ 2 时至少 L4
- 步骤数 ≥ 3 且单领域时为 L3
- 步骤数 ≤ 2 且配套项 ≤ 2 时为 L2
- 单点改动时为 L1
`;

    const response = await this.llmClient.complete(prompt);
    return this.parseAssessmentResponse(response);
  }

  /** 执行时修正 level（基于实际 plan） */
  refineAssessment(
    initialAssessment: DifficultyAssessment,
    actualPlan: GoalPlan,
  ): DifficultyAssessment {
    // 基于实际 plan 的步骤数/依赖图/领域修正
    const actualStepCount = actualPlan.steps.length;
    const hasCrossDomain = this.detectCrossDomain(actualPlan);

    let refinedLevel = initialAssessment.level;

    // 保守降级原则：信号不足时往低级别走
    if (actualStepCount <= 2 && !hasCrossDomain && this.levelValue(refinedLevel) > 2) {
      refinedLevel = 'L2';
    }
    // 跨领域强制至少 L4
    if (hasCrossDomain && this.levelValue(refinedLevel) < 4) {
      refinedLevel = 'L4';
    }

    return {
      ...initialAssessment,
      level: refinedLevel,
      reasoning: `${initialAssessment.reasoning}（执行时修正：实际步骤数=${actualStepCount}, 跨领域=${hasCrossDomain}）`,
    };
  }

  private levelValue(level: string): number {
    return parseInt(level.slice(1), 10);
  }

  private detectCrossDomain(plan: GoalPlan): boolean {
    // 简化判定：步骤涉及多个不同领域标签
    // 实际实现可基于 StepDependency.assignedRole 或领域分类
    return plan.steps.length > 0 && new Set(plan.steps.map(s => s.domain)).size > 1;
  }

  private parseAssessmentResponse(response: string): DifficultyAssessment {
    // 解析 LLM 返回的 JSON
    const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
    const json = jsonMatch ? jsonMatch[1] : response;
    return JSON.parse(json);
  }
}
```

### 4.3 配置接入

```typescript
// src/config/schema.ts 扩展

export const DifficultyRoutingSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用难度路由（false 时退回原 GoalRunner 串行路径） */
  difficultyRoutingEnabled: z.boolean().default(false),
  /** 是否允许动态升降级 */
  dynamicLevelSwitchEnabled: z.boolean().default(true),
  /** LLM 判定时的项目摘要来源：'auto'（自动生成）或 'manual'（用户配置） */
  projectSummarySource: z.enum(['auto', 'manual']).default('auto'),
  /** 用户手动配置的项目摘要（projectSummarySource='manual' 时使用） */
  manualProjectSummary: z.string().default(''),
  /** 置信度阈值——低于此值时建议人工确认级别 */
  confidenceThreshold: z.number().min(0).max(1).default(0.7),
  /** 是否在执行时修正 level */
  refineLevelAtExecution: z.boolean().default(true),
  /** 各级别角色配置（预置默认 + 用户可调整） */
  levelRolePresets: z.record(
    z.enum(['L1', 'L2', 'L3', 'L4', 'L5']),
    z.array(z.enum(['researcher', 'architect', 'executor', 'reviewer', 'tester', 'critic'])),
  ).default({
    L1: ['executor'],
    L2: ['executor'],
    L3: ['architect', 'executor', 'reviewer'],
    L4: ['architect', 'executor', 'reviewer', 'tester'],
    L5: ['researcher', 'architect', 'executor', 'reviewer', 'tester', 'critic'],
  }),
}));
```

| 字段 | schema 位置 | 类型 | 默认值 | 校验 |
|------|-------------|------|--------|------|
| `difficultyRouting.difficultyRoutingEnabled` | schema.ts 新增 | boolean | false | — |
| `difficultyRouting.dynamicLevelSwitchEnabled` | 同上 | boolean | true | — |
| `difficultyRouting.projectSummarySource` | 同上 | enum | 'auto' | — |
| `difficultyRouting.manualProjectSummary` | 同上 | string | '' | — |
| `difficultyRouting.confidenceThreshold` | 同上 | number | 0.7 | 0-1 |
| `difficultyRouting.refineLevelAtExecution` | 同上 | boolean | true | — |
| `difficultyRouting.levelRolePresets` | 同上 | Record | 见代码 | L1-L5 × 角色枚举 |

### 4.4 设置页面接入

- **TabId**：新建 `'difficulty-routing'` tab（或扩展 `'goal'` tab）
- **控件**：
  - `difficultyRoutingEnabled`：Toggle 开关 + 说明"开启后 /goal 根据 LLM 判定难度自动选择调度路径"
  - `dynamicLevelSwitchEnabled`：Toggle 开关 + 说明"执行中允许升降级"
  - `projectSummarySource`：RadioGroup（auto/manual）+ 说明
  - `manualProjectSummary`：TextArea（当 source=manual 时）
  - `confidenceThreshold`：Slider（0-1）+ 说明"低于此值时建议人工确认级别"
  - `refineLevelAtExecution`：Toggle 开关
  - `levelRolePresets`：5 行角色编辑器（每级别一行，Checkbox 组可选 researcher/architect/executor/reviewer/tester/critic）
- **组件**：新建 `SettingsDifficultyRoutingTab.tsx`

### 4.5 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新增 DifficultyRoutingSchema | `src/config/schema.ts` | GoalConfigSchema 附近 | 新字段 |
| 接入根 schema | `src/config/schema.ts` | AppConfigSchema | 新增字段 |
| 新建 difficulty-assessor.ts | `src/agent/difficulty-assessor.ts` | — | 新文件 |
| 修改 GoalPlan 类型 | `src/agent/goal-types.ts` | GoalPlan 接口 | 新增 level + difficultyAssessment 字段 |
| 接入 GoalParser | `src/agent/goal-parser.ts` | parse 方法 | 调用 DifficultyAssessor.assess |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | 新建 tab | 新建 SettingsDifficultyRoutingTab |

### 4.6 测试要求

- `assess` 返回合法的 DifficultyAssessment（level ∈ L1-L5）
- `assess` reasoning 非空且可追溯
- `assess` confidence 在 0-1 范围内
- `refineLevelAtExecution=true` 时 refineAssessment 被调用
- `refineAssessment` 跨领域检测正确
- `refineAssessment` 保守降级（信号不足时往低级别走）
- `difficultyRoutingEnabled=false` 时 GoalParser 不调用 DifficultyAssessor

---

## Task 5：LevelPathRouter——三路径直接映射与动态升降级（≥ 7 测试）

### 5.1 设计依据

基于头脑风暴决策：L1-L2→Solo，L3→DAG，L4-L5→CompositionalRouter。允许动态升降级，状态迁移保留已完成步骤的 Blackboard 快照。

### 5.2 落地设计

```typescript
// src/agent/level-path-router.ts（新建文件）

/**
 * LevelPathRouter——level → 路径映射 + 动态升降级
 *
 * 三路径直接映射：
 * - L1-L2 → 'sequential'（Solo，GoalRunner 串行）
 * - L3   → 'dag'（DAG，Orchestrator + WorkerExecutor）
 * - L4-L5→ 'router'（CompositionalRouter，ExecutionOrchestrator）
 *
 * L5 的 Researcher/Critic 作为 CompositionalRouter 的前后置阶段
 */

export type ExecutionPath = 'sequential' | 'dag' | 'router';

export interface PathSelection {
  path: ExecutionPath;
  level: DifficultyLevel;
  roles: AgentRole[];
  /** L5 前置阶段：Researcher 调研 */
  preStages: AgentRole[];
  /** L5 后置阶段：Critic 红队审查 */
  postStages: AgentRole[];
}

export class LevelPathRouter {
  constructor(
    private config: DifficultyRoutingConfig,
  ) {}

  /**
   * level → 路径映射
   */
  selectPath(level: DifficultyLevel): PathSelection {
    const roles = this.config.levelRolePresets[level] ?? ['executor'];

    switch (level) {
      case 'L1':
      case 'L2':
        return {
          path: 'sequential',
          level,
          roles,
          preStages: [],
          postStages: [],
        };

      case 'L3':
        return {
          path: 'dag',
          level,
          roles,
          preStages: [],
          postStages: [],
        };

      case 'L4':
        return {
          path: 'router',
          level,
          roles,
          preStages: [],
          postStages: [],
        };

      case 'L5':
        // L5 的 Researcher 作为前置，Critic 作为后置
        return {
          path: 'router',
          level,
          roles: roles.filter(r => r !== 'researcher' && r !== 'critic'),
          preStages: roles.includes('researcher') ? ['researcher'] : [],
          postStages: roles.includes('critic') ? ['critic'] : [],
        };
    }
  }

  /**
   * 动态升降级检测
   * 由 GoalAuditor 或 BoundedRecovery 触发
   *
   * @param currentLevel 当前级别
   * @param executionContext 执行上下文（失败次数/上下文 token/复杂度评分）
   * @returns 升降级建议（null 表示不调整）
   */
  detectLevelSwitch(
    currentLevel: DifficultyLevel,
    executionContext: {
      failureCount: number;
      contextTokenRatio: number;  // 当前 context / 预算
      crossDomainDetected: boolean;
      stepsRemaining: number;
    },
  ): { newLevel: DifficultyLevel; reason: string } | null {
    if (!this.config.dynamicLevelSwitchEnabled) return null;

    const currentVal = this.levelValue(currentLevel);

    // 升级条件
    if (executionContext.failureCount >= 3 && currentVal < 5) {
      return {
        newLevel: this.intToLevel(currentVal + 1),
        reason: `连续失败 ${executionContext.failureCount} 次，升级到 ${this.intToLevel(currentVal + 1)}`,
      };
    }
    if (executionContext.crossDomainDetected && currentVal < 4) {
      return {
        newLevel: 'L4',
        reason: '检测到跨领域，升级到 L4（CompositionalRouter）',
      };
    }
    if (executionContext.contextTokenRatio > 0.9 && currentVal < 5) {
      return {
        newLevel: this.intToLevel(currentVal + 1),
        reason: `上下文 token 占用 ${executionContext.contextTokenRatio * 100}%，升级以启用更强大的调度`,
      };
    }

    // 降级条件（保守：仅当剩余步骤少且无失败时）
    if (
      executionContext.failureCount === 0 &&
      executionContext.stepsRemaining <= 2 &&
      currentVal > 2
    ) {
      return {
        newLevel: 'L2',
        reason: `剩余 ${executionContext.stepsRemaining} 步且无失败，降级到 L2（Solo）`,
      };
    }

    return null;
  }

  private levelValue(level: DifficultyLevel): number {
    return parseInt(level.slice(1), 10);
  }

  private intToLevel(val: number): DifficultyLevel {
    return `L${Math.min(Math.max(val, 1), 5)}` as DifficultyLevel;
  }
}
```

### 5.3 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新建 level-path-router.ts | `src/agent/level-path-router.ts` | — | 新文件 |
| 接入 GoalRunner | `src/cli/goal-runner.ts` | executeGoalPlan | 根据 level 分支选择路径 |
| 接入升降级检测 | `src/cli/goal-runner.ts` | 动态升降级钩子 | BoundedRecovery/GoalAuditor 触发 |
| 接入路径执行 | `src/cli/goal-runner.ts` | 新增 executePlanWithRouter | 复用 ExecutionOrchestrator |

### 5.4 测试要求

- `selectPath('L1')` / `selectPath('L2')` 返回 'sequential'
- `selectPath('L3')` 返回 'dag'
- `selectPath('L4')` / `selectPath('L5')` 返回 'router'
- `selectPath('L5')` 的 preStages 含 researcher，postStages 含 critic
- `detectLevelSwitch` 失败 3 次时升级
- `detectLevelSwitch` 跨领域检测时升级到 L4
- `detectLevelSwitch` 剩余步骤少且无失败时降级

---

## Task 6：StateMigration——升降级时的状态迁移（≥ 5 测试）

### 6.1 设计依据

基于头脑风暴决策：升降级时保留已完成步骤的 Blackboard 快照，未完成步骤交给新路径重新规划。

### 6.2 落地设计

```typescript
// src/agent/state-migration.ts（新建文件）

/**
 * StateMigration——升降级时的状态迁移
 *
 * 核心机制：
 * 1. 保留已完成步骤的 Blackboard 快照（facts + completed steps）
 * 2. 未完成步骤交给新路径重新规划
 * 3. 不浪费已完成工作
 */

export interface MigrationContext {
  /** 当前路径 */
  currentPath: ExecutionPath;
  /** 目标路径 */
  targetPath: ExecutionPath;
  /** 当前 plan */
  currentPlan: GoalPlan;
  /** Blackboard 快照（已完成步骤的 facts） */
  blackboardSnapshot: BlackboardSnapshot;
  /** 已完成步骤 ID 列表 */
  completedStepIds: number[];
  /** 未完成步骤 */
  remainingSteps: GoalStep[];
}

export interface MigrationResult {
  /** 迁移后的 plan（未完成步骤重新规划） */
  migratedPlan: GoalPlan;
  /** 迁移后的 Blackboard（保留已完成步骤的 facts） */
  migratedBlackboard: BlackboardSnapshot;
  /** 迁移摘要（可追溯） */
  migrationSummary: string;
}

export class StateMigration {
  constructor(
    private orchestrator: Orchestrator,
  ) {}

  /**
   * 执行状态迁移
   * 升降级时调用
   */
  async migrate(context: MigrationContext): Promise<MigrationResult> {
    // 1. 保留已完成步骤的 Blackboard 快照
    const migratedBlackboard = context.blackboardSnapshot;

    // 2. 未完成步骤交给新路径的 Orchestrator 重新规划
    const replannedSteps = await this.orchestrator.replanRemaining(
      context.remainingSteps,
      context.targetPath,
      migratedBlackboard,
    );

    // 3. 构建迁移后的 plan
    const migratedPlan: GoalPlan = {
      ...context.currentPlan,
      steps: [
        ...context.currentPlan.steps.filter(s =>
          context.completedStepIds.includes(s.id),
        ),
        ...replannedSteps,
      ],
    };

    const migrationSummary = `路径迁移：${context.currentPath} → ${context.targetPath}。
保留已完成步骤 ${context.completedStepIds.length} 个，重新规划未完成步骤 ${context.remainingSteps.length} 个。
Blackboard facts 完整保留。`;

    return {
      migratedPlan,
      migratedBlackboard,
      migrationSummary,
    };
  }
}
```

### 6.3 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新建 state-migration.ts | `src/agent/state-migration.ts` | — | 新文件 |
| 接入 GoalRunner | `src/cli/goal-runner.ts` | 动态升降级钩子 | 调用 StateMigration.migrate |
| Orchestrator 扩展 | `src/agent/multi/orchestrator.ts` | 新增 replanRemaining | 重新规划未完成步骤 |

### 6.4 测试要求

- `migrate` 保留已完成步骤的 Blackboard facts
- `migrate` 未完成步骤被重新规划
- `migrate` 迁移后的 plan 含已完成 + 重新规划的步骤
- `migrate` migrationSummary 非空且可追溯
- `migrate` 不丢弃 Blackboard 中的 facts

---

## Task 7：GoalRunner 接入难度路由与动态升降级（≥ 5 测试）

### 7.1 设计依据

GoalRunner 的 executeGoalPlan 根据 level 分支选择路径，执行中通过 BoundedRecovery/GoalAuditor 触发升降级检测。

### 7.2 落地设计

```typescript
// src/cli/goal-runner.ts（修改 executeGoalPlan）

private async executeGoalPlan(plan: GoalPlan): Promise<void> {
  // Phase 55 新增：难度路由
  if (this.config.difficultyRouting?.difficultyRoutingEnabled) {
    await this.executePlanWithDifficultyRouting(plan);
  } else {
    // 原有：串行执行（零回归）
    await this.executePlanSequential(plan);
  }

  // ... 原有 verifyPlan + runCompletionGate + 迭代闭环
}

/**
 * 难度路由执行
 */
private async executePlanWithDifficultyRouting(plan: GoalPlan): Promise<void> {
  // 1. 获取或修正 level
  let level = plan.difficultyAssessment?.level ?? 'L2';
  if (this.config.difficultyRouting.refineLevelAtExecution) {
    const refined = this.difficultyAssessor.refineAssessment(
      plan.difficultyAssessment!,
      plan,
    );
    level = refined.level;
  }

  // 2. 选择路径
  const pathSelection = this.levelPathRouter.selectPath(level);

  // 3. 执行 L5 前置阶段（Researcher 调研）
  if (pathSelection.preStages.includes('researcher')) {
    await this.executePreStage('researcher', plan);
  }

  // 4. 根据路径执行主体
  let executionResult;
  switch (pathSelection.path) {
    case 'sequential':
      executionResult = await this.executePlanSequential(plan);
      break;
    case 'dag':
      executionResult = await this.executePlanWithDAG(plan);  // Phase 54 已引入
      break;
    case 'router':
      executionResult = await this.executePlanWithRouter(plan);  // 新增
      break;
  }

  // 5. 动态升降级检测
  if (this.config.difficultyRouting.dynamicLevelSwitchEnabled) {
    const switchSuggestion = this.levelPathRouter.detectLevelSwitch(level, {
      failureCount: executionResult.failureCount,
      contextTokenRatio: executionResult.contextTokenRatio,
      crossDomainDetected: executionResult.crossDomainDetected,
      stepsRemaining: executionResult.stepsRemaining,
    });

    if (switchSuggestion) {
      // 状态迁移
      const migration = await this.stateMigration.migrate({
        currentPath: pathSelection.path,
        targetPath: this.levelPathRouter.selectPath(switchSuggestion.newLevel).path,
        currentPlan: plan,
        blackboardSnapshot: this.blackboard.getSnapshot(),
        completedStepIds: plan.steps.filter(s => s.status === 'completed').map(s => s.id),
        remainingSteps: plan.steps.filter(s => s.status !== 'completed'),
      });

      // 用迁移后的 plan 重新执行
      Object.assign(plan, migration.migratedPlan);
      this.logger.info(`难度升降级：${switchSuggestion.reason}`);

      // 递归调用（用新路径执行）
      return this.executePlanWithDifficultyRouting(plan);
    }
  }

  // 6. 执行 L5 后置阶段（Critic 红队审查）
  if (pathSelection.postStages.includes('critic')) {
    await this.executePostStage('critic', plan);
  }
}

/**
 * CompositionalRouter 路径执行（新增，复用 ExecutionOrchestrator）
 */
private async executePlanWithRouter(plan: GoalPlan): Promise<ExecutionResult> {
  // 复用 Phase 54 的 ExecutionOrchestrator.executeMultiAgent
  // CompositionalRouter 按领域路由子任务到专精 Executor
  return await this.executionOrchestrator.executeMultiAgent(plan);
}
```

### 7.3 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 修改 executeGoalPlan | `src/cli/goal-runner.ts` | executeGoalPlan | 增加难度路由分支 |
| 新增 executePlanWithDifficultyRouting | `src/cli/goal-runner.ts` | 新增方法 | 难度路由执行 |
| 新增 executePlanWithRouter | `src/cli/goal-runner.ts` | 新增方法 | CompositionalRouter 路径 |
| 新增 executePreStage/executePostStage | `src/cli/goal-runner.ts` | 新增方法 | L5 前后置阶段 |
| 接入 StateMigration | `src/cli/goal-runner.ts` | 升降级钩子 | 调用 migrate |
| app-init.ts 注入新依赖 | `src/cli/app-init.ts` | GoalRunner 构造 | 注入 DifficultyAssessor/LevelPathRouter/StateMigration |

### 7.4 测试要求

- `difficultyRoutingEnabled=false` 时走原串行路径（零回归）
- `difficultyRoutingEnabled=true` 时走 executePlanWithDifficultyRouting
- L1-L2 走 sequential 路径
- L3 走 dag 路径
- L4-L5 走 router 路径
- 升降级触发时调用 StateMigration.migrate
- L5 的前置 Researcher 和后置 Critic 被执行

---

## Task 8：集成测试与文档同步（≥ 4 测试）

### 8.1 集成测试范围

| 测试场景 | 涉及 Task | 验证点 |
|----------|-----------|--------|
| 端到端难度路由 | Task 4/5/7 | LLM 判定→路径选择→执行→验收 |
| 动态升降级 | Task 5/6/7 | 检测→状态迁移→重新执行 |
| 2-Action Rule + Reboot Test 联动 | Task 1/2 | 探索 flush→compact→Reboot Test |
| Plan Attestation 全流程 | Task 3 | attest→执行→修订→归档→重新 attest |

### 8.2 文档同步

- 更新 `BLUEPRINT.md`：补充 Phase 55 的 8 个 Task 概述
- 更新 `EXECUTION_STATUS.md`：Phase 55 状态
- 更新设置页面帮助文档：新增 difficulty-routing tab 说明
- 更新 `docs/ARCHITECTURE.md`：难度路由架构图

### 8.3 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新建集成测试 | `tests/integration/phase55-difficulty-routing-e2e.test.ts` | — | 新文件 |
| 更新 BLUEPRINT.md | `蓝图与Phase/BLUEPRINT.md` | — | 补充 Phase 55 |
| 更新 EXECUTION_STATUS.md | `蓝图与Phase/EXECUTION_STATUS.md` | — | Phase 55 状态 |

### 8.4 测试要求

- 端到端难度路由测试覆盖 L1-L5
- 动态升降级测试覆盖升级和降级场景
- 2-Action Rule + Reboot Test 联动测试
- Plan Attestation 全流程测试

---

## Task 9：CCR 可逆压缩——compact 前缓存原始消息 + retrieve 工具（≥ 6 测试）

### 9.1 借鉴来源

**headroom CCR (Compress-Cache-Retrieve)**（`docs/ccr`）：
- 压缩时把原始内容存入本地 LRU cache，生成 hash 索引
- 压缩后的输出末尾追加 marker：`[N items compressed to M. Retrieve more: hash=abc123]`
- 注入 `headroom_retrieve` 工具，LLM 按需调用取回原始数据
- BM25 搜索支持：LLM 可在缓存数据内搜索相关子集而非全量取回
- 核心价值：压缩不再是破坏性的，LLM 总能取回原始数据

### 9.2 RouteDev 缺口

- RouteDev 的 compact 是破坏性的——被压缩/丢弃的消息永久丢失
- Part A Task 2 的 Reboot Test 只注入上下文摘要，但摘要可能不够详细
- LLM 在 compact 后发现需要某条被丢弃的消息（如某个错误堆栈），无法取回

### 9.3 落地设计

```typescript
// src/storage/ccr-cache.ts（新建文件）

/**
 * CCR 缓存——compact 前缓存原始消息
 * 借鉴 headroom 的 CCR (Compress-Cache-Retrieve)
 *
 * 核心机制：
 * 1. compact 前，把即将被压缩/丢弃的消息存入 LRU cache
 * 2. 生成 SHA-256 hash 作为索引
 * 3. 在压缩后的消息末尾追加 marker（含 hash）
 * 4. 注入 ccr_retrieve 工具，LLM 按需取回
 */

import { createHash } from 'crypto';

export interface CCRCacheEntry {
  /** SHA-256 hash 索引 */
  hash: string;
  /** 原始消息数组 */
  originalMessages: Message[];
  /** 缓存时间戳 */
  cachedAt: number;
  /** 消息条数 */
  messageCount: number;
  /** 估算 token 数 */
  estimatedTokens: number;
}

export class CCRCache {
  private cache = new Map<string, CCRCacheEntry>();
  private accessOrder: string[] = [];

  constructor(
    private maxEntries: number = 1000,
    private ttlSeconds: number = 3600,
  ) {}

  /**
   * 缓存即将被 compact 的消息
   * @returns hash 索引
   */
  store(messages: Message[]): string {
    const content = JSON.stringify(messages);
    const hash = createHash('sha256').update(content, 'utf8').digest('hex');

    // 已存在则不重复存储
    if (this.cache.has(hash)) return hash;

    const entry: CCRCacheEntry = {
      hash,
      originalMessages: messages,
      cachedAt: Date.now(),
      messageCount: messages.length,
      estimatedTokens: this.estimateTokens(messages),
    };

    this.cache.set(hash, entry);
    this.accessOrder.push(hash);

    // LRU 淘汰
    while (this.cache.size > this.maxEntries) {
      const oldest = this.accessOrder.shift();
      if (oldest) this.cache.delete(oldest);
    }

    return hash;
  }

  /**
   * 取回缓存的消息
   */
  retrieve(hash: string): CCRCacheEntry | undefined {
    const entry = this.cache.get(hash);
    if (!entry) return undefined;

    // TTL 检查
    if (Date.now() - entry.cachedAt > this.ttlSeconds * 1000) {
      this.cache.delete(hash);
      return undefined;
    }

    return entry;
  }

  /**
   * BM25 搜索（简化版：关键词匹配）
   * 借鉴 headroom 的 query 参数搜索
   */
  search(hash: string, query: string): Message[] | undefined {
    const entry = this.retrieve(hash);
    if (!entry) return undefined;

    const queryLower = query.toLowerCase();
    const keywords = queryLower.split(/\s+/);

    return entry.originalMessages.filter(msg => {
      const content = JSON.stringify(msg).toLowerCase();
      return keywords.some(kw => content.includes(kw));
    });
  }

  /**
   * 生成压缩 marker
   * 借鉴 headroom 的 "[N items compressed to M. Retrieve more: hash=abc123]"
   */
  static buildMarker(hash: string, originalCount: number, compressedCount: number): string {
    return `[${originalCount} 条消息压缩为 ${compressedCount} 条摘要。如需原始数据，调用 ccr_retrieve 工具，hash=${hash.slice(0, 12)}]`;
  }

  private estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + Math.ceil(JSON.stringify(m).length / 4), 0);
  }

  get size(): number {
    return this.cache.size;
  }

  /** 清理过期条目 */
  cleanup(): number {
    let removed = 0;
    const now = Date.now();
    for (const [hash, entry] of this.cache) {
      if (now - entry.cachedAt > this.ttlSeconds * 1000) {
        this.cache.delete(hash);
        this.accessOrder = this.accessOrder.filter(h => h !== hash);
        removed++;
      }
    }
    return removed;
  }
}
```

```typescript
// src/tools/builtin/ccr-retrieve.ts（新建文件）

/**
 * ccr_retrieve 工具——LLM 按需取回被 compact 的原始消息
 * 借鉴 headroom 的 headroom_retrieve 工具
 *
 * LLM 看到此工具后，可在需要原始数据时调用
 */
export const ccrRetrieveTool: ToolDefinition = {
  name: 'ccr_retrieve',
  description: '取回被 compact 压缩的原始消息。当压缩摘要信息不足时调用此工具获取完整数据。',
  parameters: {
    type: 'object',
    properties: {
      hash: {
        type: 'string',
        description: '压缩 marker 中的 hash 值（12 位前缀即可）',
      },
      query: {
        type: 'string',
        description: '可选：在缓存数据中搜索关键词，只返回匹配的消息而非全量',
      },
    },
    required: ['hash'],
  },

  async execute(params: { hash: string; query?: string }, context: ToolContext): Promise<ToolResult> {
    const ccrCache = context.getCCRCache();
    const fullHash = ccrCache.findHashByPrefix(params.hash);

    if (!fullHash) {
      return {
        success: false,
        output: `未找到 hash 前缀为 ${params.hash} 的缓存条目。可能已过期或被 LRU 淘汰。`,
      };
    }

    if (params.query) {
      const results = ccrCache.search(fullHash, params.query);
      if (!results || results.length === 0) {
        return { success: true, output: `搜索 "${params.query}" 无匹配结果。` };
      }
      return {
        success: true,
        output: `搜索 "${params.query}" 匹配 ${results.length} 条消息：\n${JSON.stringify(results, null, 2)}`,
      };
    }

    const entry = ccrCache.retrieve(fullHash);
    if (!entry) {
      return { success: false, output: `hash=${params.hash} 的缓存已过期。` };
    }

    return {
      success: true,
      output: `取回 ${entry.messageCount} 条原始消息（约 ${entry.estimatedTokens} tokens）：\n${JSON.stringify(entry.originalMessages, null, 2)}`,
    };
  },
};
```

```typescript
// src/agent/loop.ts（修改 compact 逻辑，接入 CCR）

/**
 * compact 前缓存原始消息（CCR 机制）
 * 借鉴 headroom 的 Compress-Cache-Retrieve
 */
private async performCompact(messages: Message[]): Promise<Message[]> {
  // Phase 55 Task 9 新增：CCR 缓存
  if (this.config.ccr?.ccrEnabled) {
    const messagesToCache = messages.slice(0, -this.config.compact.keepRecentMessages);
    if (messagesToCache.length > 0) {
      const hash = this.ccrCache.store(messagesToCache);
      const marker = CCRCache.buildMarker(
        hash,
        messagesToCache.length,
        this.config.compact.keepRecentMessages,
      );

      // 注入 ccr_retrieve 工具（若未注入）
      if (this.config.ccr.injectTool) {
        this.toolRegistry.ensureRegistered(ccrRetrieveTool);
      }

      // 在保留的消息前插入 marker
      const compressedMessages = messages.slice(-this.config.compact.keepRecentMessages);
      return [
        { role: 'system', content: marker },
        ...compressedMessages,
      ];
    }
  }

  // 原有 compact 逻辑（零回归）
  return this.originalCompact(messages);
}
```

### 9.4 配置接入

```typescript
// src/config/schema.ts 扩展

export const CCRSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 CCR 可逆压缩 */
  ccrEnabled: z.boolean().default(false),
  /** 是否注入 ccr_retrieve 工具 */
  injectTool: z.boolean().default(true),
  /** 是否在压缩输出中追加 marker */
  injectRetrievalMarker: z.boolean().default(true),
  /** LRU cache 最大条目数 */
  storeMaxEntries: z.number().int().min(10).max(10000).default(1000),
  /** cache TTL（秒） */
  storeTtlSeconds: z.number().int().min(60).max(86400).default(3600),
  /** compact 时保留最近 N 条消息不压缩 */
  keepRecentMessages: z.number().int().min(2).max(50).default(10),
}));
```

| 字段 | schema 位置 | 类型 | 默认值 | 校验 |
|------|-------------|------|--------|------|
| `ccr.ccrEnabled` | schema.ts 新增 | boolean | false | — |
| `ccr.injectTool` | 同上 | boolean | true | — |
| `ccr.injectRetrievalMarker` | 同上 | boolean | true | — |
| `ccr.storeMaxEntries` | 同上 | number | 1000 | 10-10000 |
| `ccr.storeTtlSeconds` | 同上 | number | 3600 | 60-86400 |
| `ccr.keepRecentMessages` | 同上 | number | 10 | 2-50 |

**根 schema 接入点**：`AppConfigSchema` 新增 `ccr: CCRSchema`。

### 9.5 设置页面接入

- **TabId**：扩展 `'execution'` tab
- **控件**：
  - `ccrEnabled`：Toggle + 说明"开启后 compact 前缓存原始消息，LLM 可通过 ccr_retrieve 工具取回"
  - `injectTool`：Toggle + 说明"注入 ccr_retrieve 工具到 LLM 工具列表"
  - `injectRetrievalMarker`：Toggle + 说明"压缩后追加 hash marker"
  - `storeMaxEntries`：NumberInput（10-10000）
  - `storeTtlSeconds`：NumberInput（60-86400，单位秒，说明"3600=1小时"）
  - `keepRecentMessages`：NumberInput（2-50）
- **组件**：扩展 `SettingsExecutionTab`

### 9.6 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新增 CCRSchema | `src/config/schema.ts` | compact 配置附近 | 新字段 |
| 接入根 schema | `src/config/schema.ts` | AppConfigSchema | 新增 ccr 字段 |
| 新建 ccr-cache.ts | `src/storage/ccr-cache.ts` | CCRCache 类 | 新文件 |
| 新建 ccr-retrieve.ts | `src/tools/builtin/ccr-retrieve.ts` | ccrRetrieveTool | 新工具 |
| 注册 ccr_retrieve 工具 | `src/tools/registry.ts` | registerBuiltinTools | 确保 ccrEnabled 时注册 |
| 修改 compact 逻辑 | `src/agent/loop.ts` | performCompact 方法 | compact 前调用 ccrCache.store |
| 工具上下文注入 | `src/tools/tool-context.ts` | getCCRCache 方法 | LLM 工具可访问 CCRCache |
| app-init 注入 CCRCache | `src/cli/app-init.ts` | GoalRunner 构造 | 注入 CCRCache 实例 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | execution tab | 扩展组件 |

### 9.7 测试要求

- `CCRCache.store` 返回 hash 且可通过 hash retrieve
- `CCRCache.store` 相同内容返回相同 hash（不重复存储）
- `CCRCache.search` 关键词匹配正确
- `CCRCache` LRU 淘汰超限条目
- `CCRCache` TTL 过期后 retrieve 返回 undefined
- `ccrEnabled=false` 时 performCompact 走原逻辑（零回归）
- `ccr_retrieve` 工具正确取回缓存数据

---

## Task 10：CacheAligner——前缀稳定化命中 KV cache（≥ 5 测试）

### 10.1 借鉴来源

**headroom CacheAligner**（`docs/architecture` Stage 1）：
- 提取 system prompt 中的动态内容（日期、UUID、session token）移到末尾
- 稳定前缀以命中 provider 的 KV cache（Anthropic cache_control / OpenAI prefix caching）
- overhead：亚毫秒级
- 示例：`"You are helpful. Current Date: 2024-12-15"` → `"You are helpful." + "[Context: Current Date: 2024-12-15]"`

### 10.2 RouteDev 缺口

- Phase 51 的 WorkerExecutor 已有 fixed prefix caching（splitSystemPrompt 拆分固定前缀 + 变量后缀）
- 但 system prompt 中的动态字段（日期、session id、用户名、当前文件列表）仍在前缀中，导致每次调用前缀都变化，KV cache 命中率低
- RouteDev 没有自动检测和提取动态字段的机制

### 10.3 落地设计

```typescript
// src/agent/cache-aligner.ts（新建文件）

/**
 * CacheAligner——前缀稳定化
 * 借鉴 headroom 的 CacheAligner
 *
 * 提取 system prompt 中的动态内容移到末尾，稳定前缀命中 KV cache
 *
 * 动态字段检测规则：
 * 1. 日期时间（\d{4}-\d{2}-\d{2} 格式）
 * 2. UUID（xxxxxxxx-xxxx-xxxx 格式）
 * 3. session id（session_xxx 格式）
 * 4. 用户名（由配置指定动态字段名）
 * 5. 当前文件列表（由 {{currentFiles}} 标记）
 */

/** 动态字段提取规则 */
const DYNAMIC_PATTERNS: Array<{ name: string; regex: RegExp; template: string }> = [
  { name: 'date', regex: /\d{4}-\d{2}-\d{2}/g, template: '[Context: Date: {value}]' },
  { name: 'uuid', regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, template: '[Context: UUID: {value}]' },
  { name: 'sessionId', regex: /session_[a-zA-Z0-9]+/g, template: '[Context: Session: {value}]' },
];

export interface CacheAlignerResult {
  /** 稳定前缀（不含动态内容） */
  stablePrefix: string;
  /** 动态尾部（提取的动态内容） */
  dynamicTail: string;
  /** 是否发生了提取（false 表示无需对齐） */
  aligned: boolean;
  /** 提取的字段列表（可追溯） */
  extractedFields: Array<{ name: string; value: string }>;
}

export class CacheAligner {
  constructor(
    private config: CacheAlignerConfig,
  ) {}

  /**
   * 对齐 system prompt——提取动态内容移到末尾
   */
  align(systemPrompt: string): CacheAlignerResult {
    if (!this.config.cacheAlignerEnabled) {
      return { stablePrefix: systemPrompt, dynamicTail: '', aligned: false, extractedFields: [] };
    }

    const extractedFields: Array<{ name: string; value: string }> = [];
    let stablePrefix = systemPrompt;
    const dynamicParts: string[] = [];

    // 提取内置动态字段
    for (const pattern of DYNAMIC_PATTERNS) {
      const matches = stablePrefix.match(pattern.regex);
      if (matches) {
        for (const match of matches) {
          extractedFields.push({ name: pattern.name, value: match });
          dynamicParts.push(pattern.template.replace('{value}', match));
        }
        stablePrefix = stablePrefix.replace(pattern.regex, '');
      }
    }

    // 提取用户配置的自定义动态字段（如 {{currentFiles}} 标记）
    for (const customField of this.config.customDynamicFields) {
      const regex = new RegExp(`\\{\\{${customField}\\}\\}[\\s\\S]*?(?=\\{\\{|$)`, 'g');
      const matches = stablePrefix.match(regex);
      if (matches) {
        for (const match of matches) {
          extractedFields.push({ name: customField, value: match });
          dynamicParts.push(`[Context: ${customField}: ${match}]`);
        }
        stablePrefix = stablePrefix.replace(regex, '');
      }
    }

    if (extractedFields.length === 0) {
      return { stablePrefix, dynamicTail: '', aligned: false, extractedFields: [] };
    }

    const dynamicTail = dynamicParts.length > 0
      ? '\n\n## Dynamic Context\n' + dynamicParts.join('\n')
      : '';

    return {
      stablePrefix: stablePrefix.trimEnd(),
      dynamicTail,
      aligned: true,
      extractedFields,
    };
  }
}
```

```typescript
// src/agent/multi/worker-executor.ts（修改 splitSystemPrompt，接入 CacheAligner）

/**
 * 修改 WorkerExecutor 的 prompt 构造，接入 CacheAligner
 * 借鉴 headroom 的 CacheAligner 稳定前缀
 */
export class WorkerExecutor {
  constructor(
    private cacheAligner: CacheAligner,
  ) {}

  private buildMessages(systemPrompt: string, task: Task): Message[] {
    // Phase 55 Task 10 新增：CacheAligner 对齐前缀
    const aligned = this.cacheAligner.align(systemPrompt);

    // 固定前缀 = 对齐后的稳定前缀（命中 KV cache）
    // 变量后缀 = 动态尾部 + task 上下文
    const fixedPrefix = aligned.stablePrefix;
    const variableSuffix = aligned.dynamicTail + '\n\n## Current Task\n' + task.description;

    return [
      { role: 'system', content: fixedPrefix },
      { role: 'system', content: variableSuffix },
      ...task.messages,
    ];
  }
}
```

### 10.4 配置接入

```typescript
// src/config/schema.ts 扩展

export const CacheAlignerSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 CacheAligner 前缀稳定化 */
  cacheAlignerEnabled: z.boolean().default(false),
  /** 自定义动态字段名列表（如 ['currentFiles', 'userPreferences']） */
  customDynamicFields: z.array(z.string()).default([]),
  /** 是否在日志中记录提取的字段（调试用） */
  logExtractedFields: z.boolean().default(false),
}));
```

| 字段 | schema 位置 | 类型 | 默认值 | 校验 |
|------|-------------|------|--------|------|
| `cacheAligner.cacheAlignerEnabled` | schema.ts 新增 | boolean | false | — |
| `cacheAligner.customDynamicFields` | 同上 | array | [] | 字符串数组 |
| `cacheAligner.logExtractedFields` | 同上 | boolean | false | — |

**根 schema 接入点**：`AppConfigSchema` 新增 `cacheAligner: CacheAlignerSchema`。

### 10.5 设置页面接入

- **TabId**：扩展 `'execution'` tab
- **控件**：
  - `cacheAlignerEnabled`：Toggle + 说明"开启后自动提取 system prompt 动态字段移到末尾，提升 KV cache 命中率"
  - `customDynamicFields`：TagInput（可添加/删除字段名）+ 说明"用 {{字段名}} 标记的动态内容会被提取"
  - `logExtractedFields`：Toggle + 说明"调试模式：在日志中记录每次提取的字段"
- **组件**：扩展 `SettingsExecutionTab`

### 10.6 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新增 CacheAlignerSchema | `src/config/schema.ts` | WorkerExecutor 配置附近 | 新字段 |
| 接入根 schema | `src/config/schema.ts` | AppConfigSchema | 新增 cacheAligner 字段 |
| 新建 cache-aligner.ts | `src/agent/cache-aligner.ts` | CacheAligner 类 | 新文件 |
| 修改 WorkerExecutor | `src/agent/multi/worker-executor.ts` | buildMessages 方法 | 调用 cacheAligner.align |
| app-init 注入 CacheAligner | `src/cli/app-init.ts` | WorkerExecutor 构造 | 注入 CacheAligner 实例 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | execution tab | 扩展组件 |

### 10.7 测试要求

- `align` 提取日期字段并移到末尾
- `align` 提取 UUID 字段并移到末尾
- `align` 提取 sessionId 字段并移到末尾
- `align` 提取自定义 {{currentFiles}} 标记
- `cacheAlignerEnabled=false` 时返回原 prompt 不变（零回归）
- `align` 无动态字段时 aligned=false

---

## Task 11：IntelligentContext 6 维评分——compact 按重要性丢弃消息（≥ 6 测试）

### 11.1 借鉴来源

**headroom IntelligentContext**（`docs/architecture` Stage 3）：
- 对每条消息按 6 维评分：recency / 语义相似 / TOIN 重要性 / 错误指示 / 前向引用 / token 密度
- 丢弃最低分消息（而非最旧消息）
- 被丢弃的消息存入 CCR（与 Task 9 协同）
- 替代简单的 rolling window

### 11.2 RouteDev 缺口

- RouteDev 的 compact 按 rolling window 丢最旧消息，不区分重要性
- 可能丢掉关键错误信息（如某个失败的测试堆栈）或前向引用（如 "后面会用到这个函数"）
- 没有基于语义相关性的保留机制

### 11.3 落地设计

```typescript
// src/agent/context-scorer.ts（新建文件）

/**
 * IntelligentContext 6 维评分器
 * 借鉴 headroom 的 IntelligentContext
 *
 * 6 个评分维度：
 * 1. recency（时效性）：越近的消息分越高
 * 2. semanticSimilarity（语义相似）：与当前 query 的语义相似度
 * 3. importance（重要性）：system/user 消息 > assistant > tool
 * 4. errorIndicator（错误指示）：含 error/failed/exception 的消息分高
 * 5. forwardReference（前向引用）：含 "后面/稍后/将会" 的消息分高
 * 6. tokenDensity（token 密度）：信息密度高的消息分高
 */

export interface MessageScore {
  /** 消息索引 */
  index: number;
  /** 总分（0-1 加权和） */
  totalScore: number;
  /** 各维度得分 */
  dimensions: {
    recency: number;
    semanticSimilarity: number;
    importance: number;
    errorIndicator: number;
    forwardReference: number;
    tokenDensity: number;
  };
}

export class ContextScorer {
  constructor(
    private config: IntelligentContextConfig,
  ) {}

  /**
   * 对消息数组评分
   * @param messages 消息数组
   * @param currentQuery 当前用户 query（用于语义相似度）
   * @returns 每条消息的评分
   */
  score(messages: Message[], currentQuery: string): MessageScore[] {
    const totalMessages = messages.length;
    const queryKeywords = this.extractKeywords(currentQuery);

    return messages.map((msg, index) => {
      const recency = this.scoreRecency(index, totalMessages);
      const semanticSimilarity = this.scoreSemanticSimilarity(msg, queryKeywords);
      const importance = this.scoreImportance(msg);
      const errorIndicator = this.scoreErrorIndicator(msg);
      const forwardReference = this.scoreForwardReference(msg);
      const tokenDensity = this.scoreTokenDensity(msg);

      const totalScore =
        recency * this.config.weights.recency +
        semanticSimilarity * this.config.weights.semanticSimilarity +
        importance * this.config.weights.importance +
        errorIndicator * this.config.weights.errorIndicator +
        forwardReference * this.config.weights.forwardReference +
        tokenDensity * this.config.weights.tokenDensity;

      return {
        index,
        totalScore,
        dimensions: { recency, semanticSimilarity, importance, errorIndicator, forwardReference, tokenDensity },
      };
    });
  }

  /**
   * 选择要丢弃的消息（得分最低的 N 条）
   * 与 Task 9 的 CCR 协同：被丢弃的消息存入 CCR
   */
  selectForDropping(scores: MessageScore[], dropCount: number): number[] {
    const sorted = [...scores].sort((a, b) => a.totalScore - b.totalScore);
    return sorted.slice(0, dropCount).map(s => s.index);
  }

  private scoreRecency(index: number, total: number): number {
    // 越近的消息分越高（线性衰减）
    return total > 0 ? index / total : 0;
  }

  private scoreSemanticSimilarity(msg: Message, queryKeywords: string[]): number {
    if (queryKeywords.length === 0) return 0.5;
    const content = JSON.stringify(msg).toLowerCase();
    const matches = queryKeywords.filter(kw => content.includes(kw.toLowerCase()));
    return matches.length / queryKeywords.length;
  }

  private scoreImportance(msg: Message): number {
    // system 和 user 消息重要性最高
    if (msg.role === 'system') return 1.0;
    if (msg.role === 'user') return 0.9;
    if (msg.role === 'assistant') return 0.5;
    if (msg.role === 'tool') return 0.3;
    return 0.5;
  }

  private scoreErrorIndicator(msg: Message): number {
    const content = JSON.stringify(msg).toLowerCase();
    const errorKeywords = ['error', 'failed', 'exception', 'traceback', 'crash', 'fatal'];
    const matches = errorKeywords.filter(kw => content.includes(kw));
    return Math.min(matches.length / 3, 1.0);
  }

  private scoreForwardReference(msg: Message): number {
    const content = JSON.stringify(msg).toLowerCase();
    const forwardKeywords = ['后面', '稍后', '将会', 'later', 'will use', '下一步', '接下来'];
    const matches = forwardKeywords.filter(kw => content.includes(kw));
    return matches.length > 0 ? 1.0 : 0.0;
  }

  private scoreTokenDensity(msg: Message): number {
    // 信息密度 = 非空白字符 / 总字符
    const content = JSON.stringify(msg);
    const nonWhitespace = content.replace(/\s/g, '').length;
    return content.length > 0 ? nonWhitespace / content.length : 0;
  }

  private extractKeywords(query: string): string[] {
    // 简化版：按空格分词，过滤停用词
    const stopwords = ['的', '了', '是', '在', 'a', 'the', 'is', 'are', 'to', 'do'];
    return query.split(/\s+/).filter(w => w.length > 1 && !stopwords.includes(w.toLowerCase()));
  }
}
```

```typescript
// src/agent/loop.ts（修改 compact 丢弃逻辑，接入 IntelligentContext）

/**
 * 修改 compact 的消息选择策略
 * 借鉴 headroom 的 IntelligentContext 评分替换 rolling window
 */
private async performCompactWithScoring(messages: Message[], currentQuery: string): Promise<Message[]> {
  // Phase 55 Task 11 新增：IntelligentContext 评分
  if (this.config.intelligentContext?.intelligentCompactEnabled) {
    const scores = this.contextScorer.score(messages, currentQuery);
    const dropCount = Math.max(0, messages.length - this.config.ccr.keepRecentMessages);
    const dropIndices = new Set(this.contextScorer.selectForDropping(scores, dropCount));

    // 保留的消息
    const keptMessages = messages.filter((_, i) => !dropIndices.has(i));

    // 被丢弃的消息存入 CCR（与 Task 9 协同）
    if (this.config.ccr?.ccrEnabled) {
      const droppedMessages = messages.filter((_, i) => dropIndices.has(i));
      if (droppedMessages.length > 0) {
        const hash = this.ccrCache.store(droppedMessages);
        const marker = CCRCache.buildMarker(hash, droppedMessages.length, keptMessages.length);
        return [
          { role: 'system', content: marker },
          ...keptMessages,
        ];
      }
    }

    return keptMessages;
  }

  // 原有 rolling window 逻辑（零回归）
  return this.performCompact(messages);
}
```

### 11.4 配置接入

```typescript
// src/config/schema.ts 扩展

export const IntelligentContextSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 IntelligentContext 评分 compact */
  intelligentCompactEnabled: z.boolean().default(false),
  /** 6 维评分权重（总和应为 1.0） */
  weights: z.object({
    recency: z.number().min(0).max(1).default(0.15),
    semanticSimilarity: z.number().min(0).max(1).default(0.25),
    importance: z.number().min(0).max(1).default(0.20),
    errorIndicator: z.number().min(0).max(1).default(0.20),
    forwardReference: z.number().min(0).max(1).default(0.10),
    tokenDensity: z.number().min(0).max(1).default(0.10),
  }),
  /** 是否在日志中记录每条消息的评分（调试用） */
  logScores: z.boolean().default(false),
}));
```

| 字段 | schema 位置 | 类型 | 默认值 | 校验 |
|------|-------------|------|--------|------|
| `intelligentContext.intelligentCompactEnabled` | schema.ts 新增 | boolean | false | — |
| `intelligentContext.weights.recency` | 同上 | number | 0.15 | 0-1 |
| `intelligentContext.weights.semanticSimilarity` | 同上 | number | 0.25 | 0-1 |
| `intelligentContext.weights.importance` | 同上 | number | 0.20 | 0-1 |
| `intelligentContext.weights.errorIndicator` | 同上 | number | 0.20 | 0-1 |
| `intelligentContext.weights.forwardReference` | 同上 | number | 0.10 | 0-1 |
| `intelligentContext.weights.tokenDensity` | 同上 | number | 0.10 | 0-1 |
| `intelligentContext.logScores` | 同上 | boolean | false | — |

**根 schema 接入点**：`AppConfigSchema` 新增 `intelligentContext: IntelligentContextSchema`。

### 11.5 设置页面接入

- **TabId**：扩展 `'execution'` tab
- **控件**：
  - `intelligentCompactEnabled`：Toggle + 说明"开启后 compact 按 6 维评分丢弃低分消息，而非简单丢最旧"
  - 6 个 Slider（recency/semanticSimilarity/importance/errorIndicator/forwardReference/tokenDensity），各 0-1，实时显示总和
  - `logScores`：Toggle + 说明"调试模式：记录每条消息的评分到日志"
- **组件**：扩展 `SettingsExecutionTab`

### 11.6 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新增 IntelligentContextSchema | `src/config/schema.ts` | compact 配置附近 | 新字段 |
| 接入根 schema | `src/config/schema.ts` | AppConfigSchema | 新增 intelligentContext 字段 |
| 新建 context-scorer.ts | `src/agent/context-scorer.ts` | ContextScorer 类 | 新文件 |
| 修改 compact 逻辑 | `src/agent/loop.ts` | performCompact 调用点 | 改为调用 performCompactWithScoring |
| app-init 注入 ContextScorer | `src/cli/app-init.ts` | agent loop 构造 | 注入 ContextScorer 实例 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | execution tab | 扩展组件 |

### 11.7 测试要求

- `score` 返回每条消息的 6 维评分和总分
- `scoreRecency` 越近的消息分越高
- `scoreErrorIndicator` 含 error 的消息分高
- `scoreForwardReference` 含"后面/稍后"的消息分高
- `selectForDropping` 返回得分最低的 N 条索引
- `intelligentCompactEnabled=false` 时走原 rolling window（零回归）

---

## Task 12：Output Token Reduction——effort routing + verbosity steering（≥ 5 测试）

### 12.1 借鉴来源

**headroom Output token reduction**（README "Output token reduction"）：
- 不光压缩输入，也压缩输出（Opus 级模型 output 成本是 input 的 5 倍）
- **effort routing**：routine 步骤（读文件后、测试通过后）降低 thinking effort；新问题和错误保持 full effort
- **verbosity steering**：在 system prompt 末尾追加简短"be terse, don't restate context"提示（不影响 prompt cache）
- 输出节省是反事实的（看不到模型本来会写什么），headroom 报告带置信区间的估算

### 12.2 RouteDev 缺口

- RouteDev 模型输出全保留，包括 "Let me..." 前言和 routine 步骤的深度 thinking
- routine 步骤（如读文件后继续）不需要深度 thinking，但模型默认用 full effort
- 没有针对输出的 token 优化机制

### 12.3 落地设计

```typescript
// src/agent/output-reducer.ts（新建文件）

/**
 * Output Token Reduction
 * 借鉴 headroom 的 effort routing + verbosity steering
 *
 * 两种机制：
 * 1. effort routing：routine 步骤降 thinking effort，新问题/错误保持 full effort
 * 2. verbosity steering：system prompt 末尾追加 terseness 提示
 */

/** 步骤类型判定（决定 thinking effort） */
export type StepType = 'routine' | 'new_question' | 'error_recovery' | 'planning';

export interface EffortRoutingResult {
  /** 步骤类型 */
  stepType: StepType;
  /** thinking effort 等级 */
  thinkingEffort: 'low' | 'medium' | 'high';
  /** 判定理由 */
  reason: string;
}

/** routine 步骤的判定信号 */
const ROUTINE_SIGNALS = [
  '文件已读取', 'file read complete', '测试通过', 'test passed',
  '构建成功', 'build successful', '工具执行完成', 'tool executed',
];

/** 错误恢复的判定信号 */
const ERROR_SIGNALS = [
  'error', 'failed', 'exception', '测试失败', 'test failed',
  '构建失败', 'build failed', 'crash',
];

export class OutputReducer {
  constructor(
    private config: OutputReductionConfig,
  ) {}

  /**
   * effort routing——根据当前步骤类型决定 thinking effort
   * 借鉴 headroom 的 effort routing
   */
  routeEffort(
    lastToolResult: string | undefined,
    userMessage: string | undefined,
  ): EffortRoutingResult {
    if (!this.config.effortRoutingEnabled) {
      return { stepType: 'new_question', thinkingEffort: 'high', reason: 'effort routing 未启用' };
    }

    // 判定步骤类型
    const lastResultLower = (lastToolResult ?? '').toLowerCase();
    const userLower = (userMessage ?? '').toLowerCase();

    // 错误恢复——最高 effort
    if (ERROR_SIGNALS.some(s => lastResultLower.includes(s.toLowerCase()))) {
      return { stepType: 'error_recovery', thinkingEffort: 'high', reason: '检测到错误信号，保持 full effort' };
    }

    // 新问题——高 effort
    if (userMessage && !ROUTINE_SIGNALS.some(s => lastResultLower.includes(s.toLowerCase()))) {
      return { stepType: 'new_question', thinkingEffort: 'high', reason: '用户提出新问题，保持 high effort' };
    }

    // routine 步骤——低 effort
    if (ROUTINE_SIGNALS.some(s => lastResultLower.includes(s.toLowerCase()))) {
      return {
        stepType: 'routine',
        thinkingEffort: this.config.routineEffortLevel,
        reason: 'routine 步骤（文件读取/测试通过），降低 thinking effort',
      };
    }

    // 默认——中 effort
    return { stepType: 'new_question', thinkingEffort: 'medium', reason: '无法判定步骤类型，使用 medium effort' };
  }

  /**
   * verbosity steering——在 system prompt 末尾追加 terseness 提示
   * 借鉴 headroom 的 verbosity steering
   *
   * 追加到末尾而非开头，以保持 prompt cache 命中
   */
  applyVerbositySteering(systemPrompt: string): string {
    if (!this.config.verbositySteeringEnabled) return systemPrompt;

    const tersenessHint = this.config.verbosityHint || '\n\n## Output Style\nBe terse. Do not restate context. Do not use "Let me..." preambles. Skip deep thinking on routine steps.';

    return systemPrompt + tersenessHint;
  }

  /**
   * 估算输出节省（反事实估算）
   * 借鉴 headroom 的 output-savings 估算
   */
  estimateSavings(
    actualOutputTokens: number,
    stepType: StepType,
  ): { estimatedReduction: number; confidenceRange: [number, number] } {
    // routine 步骤的估算节省比例（基于 headroom 的经验数据）
    const reductionRates: Record<StepType, number> = {
      routine: 0.35,
      new_question: 0.10,
      error_recovery: 0.05,
      planning: 0.15,
    };

    const estimatedReduction = reductionRates[stepType];
    const estimatedSavedTokens = Math.round(actualOutputTokens * estimatedReduction / (1 - estimatedReduction));

    return {
      estimatedReduction,
      confidenceRange: [
        Math.max(0, estimatedReduction - 0.04),
        Math.min(1, estimatedReduction + 0.04),
      ],
    };
  }
}
```

```typescript
// src/agent/loop.ts（修改 LLM 调用，接入 effort routing + verbosity steering）

/**
 * 修改 LLM 调用参数，接入 OutputReducer
 * 借鉴 headroom 的 output token reduction
 */
private async callLLM(
  systemPrompt: string,
  messages: Message[],
  lastToolResult: string | undefined,
  userMessage: string | undefined,
): Promise<LLMResponse> {
  // Phase 55 Task 12 新增：effort routing + verbosity steering
  let adjustedSystemPrompt = systemPrompt;
  let thinkingBudget: number | undefined;

  if (this.config.outputReduction?.outputReductionEnabled) {
    // verbosity steering
    adjustedSystemPrompt = this.outputReducer.applyVerbositySteering(systemPrompt);

    // effort routing
    const effortRouting = this.outputReducer.routeEffort(lastToolResult, userMessage);
    thinkingBudget = this.thinkingEffortToBudget(effortRouting.thinkingEffort);
    this.logger.debug(`Effort routing: ${effortRouting.stepType} → ${effortRouting.thinkingEffort} (${effortRouting.reason})`);
  }

  return this.llmClient.complete({
    systemPrompt: adjustedSystemPrompt,
    messages,
    thinkingBudget,
  });
}

private thinkingEffortToBudget(effort: 'low' | 'medium' | 'high'): number | undefined {
  switch (effort) {
    case 'low': return this.config.outputReduction?.lowEffortBudget ?? 1024;
    case 'medium': return this.config.outputReduction?.mediumEffortBudget ?? 4096;
    case 'high': return undefined; // undefined = 不限制
  }
}
```

### 12.4 配置接入

```typescript
// src/config/schema.ts 扩展

export const OutputReductionSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 output token reduction */
  outputReductionEnabled: z.boolean().default(false),
  /** 是否启用 effort routing */
  effortRoutingEnabled: z.boolean().default(true),
  /** 是否启用 verbosity steering */
  verbositySteeringEnabled: z.boolean().default(true),
  /** routine 步骤的 thinking effort 等级 */
  routineEffortLevel: z.enum(['low', 'medium', 'high']).default('low'),
  /** low effort 的 thinking budget（tokens） */
  lowEffortBudget: z.number().int().min(256).max(8192).default(1024),
  /** medium effort 的 thinking budget（tokens） */
  mediumEffortBudget: z.number().int().min(1024).max(32768).default(4096),
  /** verbosity steering 追加的提示文本（空则用默认） */
  verbosityHint: z.string().default(''),
  /** 是否留 10% 对话不压缩作为对照组（测量真实节省） */
  holdoutRatio: z.number().min(0).max(0.5).default(0),
}));
```

| 字段 | schema 位置 | 类型 | 默认值 | 校验 |
|------|-------------|------|--------|------|
| `outputReduction.outputReductionEnabled` | schema.ts 新增 | boolean | false | — |
| `outputReduction.effortRoutingEnabled` | 同上 | boolean | true | — |
| `outputReduction.verbositySteeringEnabled` | 同上 | boolean | true | — |
| `outputReduction.routineEffortLevel` | 同上 | enum | 'low' | low/medium/high |
| `outputReduction.lowEffortBudget` | 同上 | number | 1024 | 256-8192 |
| `outputReduction.mediumEffortBudget` | 同上 | number | 4096 | 1024-32768 |
| `outputReduction.verbosityHint` | 同上 | string | '' | — |
| `outputReduction.holdoutRatio` | 同上 | number | 0 | 0-0.5 |

**根 schema 接入点**：`AppConfigSchema` 新增 `outputReduction: OutputReductionSchema`。

### 12.5 设置页面接入

- **TabId**：扩展 `'execution'` tab
- **控件**：
  - `outputReductionEnabled`：Toggle + 说明"开启后压缩输出 token（effort routing + verbosity steering）"
  - `effortRoutingEnabled`：Toggle + 说明"routine 步骤降低 thinking effort"
  - `verbositySteeringEnabled`：Toggle + 说明"system prompt 末尾追加 terseness 提示"
  - `routineEffortLevel`：RadioGroup（low/medium/high）
  - `lowEffortBudget`：NumberInput（256-8192）
  - `mediumEffortBudget`：NumberInput（1024-32768）
  - `verbosityHint`：TextArea + 说明"留空使用默认 terseness 提示"
  - `holdoutRatio`：Slider（0-0.5）+ 说明"留 10% 对话不压缩作为对照组"
- **组件**：扩展 `SettingsExecutionTab`

### 12.6 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新增 OutputReductionSchema | `src/config/schema.ts` | LLM 调用配置附近 | 新字段 |
| 接入根 schema | `src/config/schema.ts` | AppConfigSchema | 新增 outputReduction 字段 |
| 新建 output-reducer.ts | `src/agent/output-reducer.ts` | OutputReducer 类 | 新文件 |
| 修改 LLM 调用 | `src/agent/loop.ts` | callLLM 方法 | 接入 effort routing + verbosity steering |
| app-init 注入 OutputReducer | `src/cli/app-init.ts` | agent loop 构造 | 注入 OutputReducer 实例 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | execution tab | 扩展组件 |

### 12.7 测试要求

- `routeEffort` routine 步骤返回 low effort
- `routeEffort` 错误信号返回 high effort
- `routeEffort` 新问题返回 high effort
- `applyVerbositySteering` 在 system prompt 末尾追加 terseness 提示
- `outputReductionEnabled=false` 时 callLLM 不调整参数（零回归）
- `estimateSavings` 返回带置信区间的估算

---

## Task 13：headroom learn 失败挖掘——自动沉淀失败经验到 project_memory（≥ 5 测试）

### 13.1 借鉴来源

**headroom learn**（README "`headroom learn`"）：
- 挖掘失败会话，提取失败模式
- 自动写入修正文件（CLAUDE.local.md / CLAUDE.md / AGENTS.md / GEMINI.md）
- `--verbosity` 子命令学习用户的 terseness 偏好
- `--apply` 应用学习结果

### 13.2 RouteDev 缺口

- RouteDev 的 SelfEvolution 框架是 Phase 54 设计但未落地
- 失败会话的经验没有自动沉淀到 project_memory
- 用户需要手动写 Lessons Learned，容易遗漏

### 13.3 落地设计

```typescript
// src/agent/failure-learner.ts（新建文件）

/**
 * FailureLearner——失败会话挖掘
 * 借鉴 headroom learn
 *
 * 核心机制：
 * 1. 检测失败会话（runCompletionGate 失败 / 用户中断 / BoundedRecovery 重试超限）
 * 2. 用 LLM 分析失败原因，提取可复用的经验
 * 3. 自动写入 project_memory 的 Lessons Learned 部分
 * 4. 格式：- [YYYY-MM-DD] 简述 → 根因 → 修复 → 预防规则
 */

export interface FailureSession {
  /** 会话 ID */
  sessionId: string;
  /** 失败时间戳 */
  failedAt: number;
  /** 失败类型 */
  failureType: 'completion_gate_failed' | 'user_interrupted' | 'recovery_exhausted' | 'build_failed';
  /** 失败时的 goal 描述 */
  goalDescription: string;
  /** 失败时的最后几条消息 */
  lastMessages: Message[];
  /** 失败时的错误信息 */
  errorMessage: string;
  /** 尝试过的修复 */
  attemptedFixes: string[];
}

export interface LearnedLesson {
  /** 日期 */
  date: string;
  /** 简述 */
  summary: string;
  /** 根因 */
  rootCause: string;
  /** 修复 */
  fix: string;
  /** 预防规则 */
  preventionRule: string;
  /** 置信度 */
  confidence: number;
}

export class FailureLearner {
  constructor(
    private llmClient: ILLMClient,
    private config: FailureLearningConfig,
    private projectMemoryWriter: (lesson: LearnedLesson) => Promise<void>,
  ) {}

  /**
   * 从失败会话中学习
   * 借鉴 headroom learn 的失败挖掘
   */
  async learn(failure: FailureSession): Promise<LearnedLesson | null> {
    if (!this.config.failureLearningEnabled) return null;

    // 跳过低置信度失败（如用户主动中断）
    if (failure.failureType === 'user_interrupted' && !this.config.learnFromUserInterrupts) {
      return null;
    }

    const prompt = this.buildLearningPrompt(failure);
    const response = await this.llmClient.complete(prompt);

    const lesson = this.parseLearningResponse(response, failure);
    if (!lesson || lesson.confidence < this.config.confidenceThreshold) {
      return null;
    }

    // 写入 project_memory
    await this.projectMemoryWriter(lesson);
    return lesson;
  }

  private buildLearningPrompt(failure: FailureSession): string {
    return `
## 失败会话分析

你是一个失败模式分析专家。请分析以下失败会话，提取可复用的经验。

### 失败信息
- **失败类型：** ${failure.failureType}
- **失败时间：** ${new Date(failure.failedAt).toISOString()}
- **Goal：** ${failure.goalDescription}
- **错误信息：** ${failure.errorMessage}
- **尝试过的修复：** ${failure.attemptedFixes.join('; ') || '无'}

### 最后几条消息
${JSON.stringify(failure.lastMessages.slice(-5), null, 2)}

### 任务
请分析失败原因，提取可复用的经验，输出 JSON 格式：

\`\`\`json
{
  "date": "${new Date(failure.failedAt).toISOString().slice(0, 10)}",
  "summary": "简述（1 句话）",
  "rootCause": "根因分析（2-3 句话）",
  "fix": "修复方法（1-2 句话）",
  "preventionRule": "预防规则（可执行的规则，如'构建前必须检查 XXX'）",
  "confidence": 0.0-1.0
}
\`\`\`

注意：
- 只提取可复用的经验，不要记录一次性的偶然失败
- preventionRule 必须是可执行的规则，不是模糊建议
- confidence < 0.6 的经验不值得记录
`;
  }

  private parseLearningResponse(response: string, failure: FailureSession): LearnedLesson | null {
    try {
      const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
      const json = jsonMatch ? jsonMatch[1] : response;
      const parsed = JSON.parse(json);

      return {
        date: parsed.date || new Date(failure.failedAt).toISOString().slice(0, 10),
        summary: parsed.summary ?? '',
        rootCause: parsed.rootCause ?? '',
        fix: parsed.fix ?? '',
        preventionRule: parsed.preventionRule ?? '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      };
    } catch {
      return null;
    }
  }
}
```

```typescript
// src/cli/goal-runner.ts（修改 runCompletionGate 失败分支，接入 FailureLearner）

/**
 * 在 runCompletionGate 失败时触发 FailureLearner
 * 借鉴 headroom learn 的失败挖掘
 */
private async runCompletionGate(plan: GoalPlan): Promise<boolean> {
  const result = await this.completionGate.verify(plan);

  if (!result.passed) {
    // Phase 55 Task 13 新增：失败学习
    if (this.config.failureLearning?.failureLearningEnabled) {
      const failure: FailureSession = {
        sessionId: this.sessionId,
        failedAt: Date.now(),
        failureType: 'completion_gate_failed',
        goalDescription: plan.description,
        lastMessages: this.conversationHistory.slice(-5),
        errorMessage: result.reason,
        attemptedFixes: this.boundedRecovery.getAttemptedFixes(),
      };

      const lesson = await this.failureLearner.learn(failure);
      if (lesson) {
        this.logger.info(`失败经验已沉淀到 project_memory: ${lesson.summary}`);
      }
    }

    return false;
  }

  return true;
}
```

### 13.4 配置接入

```typescript
// src/config/schema.ts 扩展

export const FailureLearningSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用失败学习 */
  failureLearningEnabled: z.boolean().default(false),
  /** 是否从用户中断中学习（默认否，用户中断可能非失败） */
  learnFromUserInterrupts: z.boolean().default(false),
  /** 置信度阈值——低于此值的经验不记录 */
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
  /** 最大学习频率（每小时最多 N 次，防止刷屏 project_memory） */
  maxLearningRatePerHour: z.number().int().min(1).max(20).default(3),
  /** 是否在日志中记录学习结果 */
  logLearningResults: z.boolean().default(true),
}));
```

| 字段 | schema 位置 | 类型 | 默认值 | 校验 |
|------|-------------|------|--------|------|
| `failureLearning.failureLearningEnabled` | schema.ts 新增 | boolean | false | — |
| `failureLearning.learnFromUserInterrupts` | 同上 | boolean | false | — |
| `failureLearning.confidenceThreshold` | 同上 | number | 0.6 | 0-1 |
| `failureLearning.maxLearningRatePerHour` | 同上 | number | 3 | 1-20 |
| `failureLearning.logLearningResults` | 同上 | boolean | true | — |

**根 schema 接入点**：`AppConfigSchema` 新增 `failureLearning: FailureLearningSchema`。

### 13.5 设置页面接入

- **TabId**：扩展 `'execution'` tab
- **控件**：
  - `failureLearningEnabled`：Toggle + 说明"开启后失败会话自动分析并沉淀经验到 project_memory"
  - `learnFromUserInterrupts`：Toggle + 说明"从用户中断中学习（可能非失败，默认关闭）"
  - `confidenceThreshold`：Slider（0-1）+ 说明"低于此值的经验不记录"
  - `maxLearningRatePerHour`：NumberInput（1-20）+ 说明"防止 project_memory 被刷屏"
  - `logLearningResults`：Toggle
- **组件**：扩展 `SettingsExecutionTab`

### 13.6 代码接线点

| 操作 | 文件 | 位置 | 说明 |
|------|------|------|------|
| 新增 FailureLearningSchema | `src/config/schema.ts` | SelfEvolution 配置附近 | 新字段 |
| 接入根 schema | `src/config/schema.ts` | AppConfigSchema | 新增 failureLearning 字段 |
| 新建 failure-learner.ts | `src/agent/failure-learner.ts` | FailureLearner 类 | 新文件 |
| 修改 runCompletionGate | `src/cli/goal-runner.ts` | runCompletionGate 失败分支 | 触发 FailureLearner.learn |
| 接入 project_memory 写入 | `src/storage/project-memory.ts` | appendLesson 方法 | 写入 Lessons Learned 部分 |
| 接入 BoundedRecovery 失败 | `src/cli/goal-runner.ts` | recovery_exhausted 分支 | 也触发 FailureLearner |
| app-init 注入 FailureLearner | `src/cli/app-init.ts` | GoalRunner 构造 | 注入 FailureLearner 实例 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | execution tab | 扩展组件 |

### 13.7 测试要求

- `learn` 失败会话返回 LearnedLesson
- `learn` 置信度低于阈值时返回 null
- `learn` 用户中断默认不学习（learnFromUserInterrupts=false）
- `learn` failureLearningEnabled=false 时返回 null（零回归）
- `parseLearningResponse` 正确解析 LLM 返回的 JSON
- `projectMemoryWriter` 被调用写入 Lessons Learned

---

## 陷阱警告（#186-#205）

**186. 2-Action Rule 的 flushInterval 过小导致频繁打断：** Task 1 的 flushInterval 默认 3。如果设为 2，Researcher 每读 2 个文件就要 flush 一次，严重打断探索节奏。flushInterval 必须 ≥ 2，推荐 3-5。设置页面需明确说明"过小会频繁打断，过大会失去 flush 意义"。

**187. Reboot Test 的 5 问可能被 Agent 忽略：** Task 2 的 `requireExplicitAnswers=true` 时，Agent 理论上必须回答 5 问才能继续。但 LLM 可能直接跳过回答继续工作。必须在 system message 中明确"回答以下问题后才能继续工作"，且后续工具调用前检测是否已回答（若未回答则再次提醒）。

**188. Plan Attestation 的 hash 计算必须排除运行时字段：** Task 3 的 `computePlanHash` 只 hash 核心字段（description/steps/dependencies/verificationCriteria），不 hash status/modifiedFiles 等运行时字段。否则 step 状态从 pending 变为 completed 会导致 hash 不匹配，误判为篡改。`includeAcceptanceCriteriaInHash` 开关控制是否包含 acceptanceCriteria——若 acceptanceCriteria 在执行中被动态调整，应设为 false。

**189. Plan 修订归档可能膨胀内存：** Task 3 的 `archivedVersions` 存在 GoalPlan 对象内。如果 plan 被频繁修订（如迭代闭环多轮），archivedVersions 会不断增长。`maxArchivedVersions` 默认 10，超限时 FIFO 丢弃最旧版本。归档版本只存快照，不存完整执行历史。

**190. LLM 难度判定的置信度可能不准：** Task 4 的 LLM 判定可能给出高置信度但错误的 level。`confidenceThreshold` 默认 0.7，低于此值时建议人工确认。但高置信度错误无法靠阈值捕捉。必须有执行时修正（refineLevelAtExecution）作为兜底。

**191. 动态升降级可能导致无限循环：** Task 5/7 的升降级如果触发后再次触发，可能无限循环。必须有最大升降级次数限制（如 2 次），超限后冻结级别并交回用户决策。

**192. 状态迁移可能丢失上下文：** Task 6 的 StateMigration 只保留 Blackboard facts，但 conversation history 在路径切换时可能不连续。迁移后的新路径 Agent 可能缺乏前序步骤的对话上下文。必须在迁移摘要中包含关键决策记录。

**193. L5 前后置阶段可能超时：** Task 7 的 L5 前置 Researcher 和后置 Critic 可能耗时过长。必须有超时机制——Researcher 超时后跳过（用已有信息规划），Critic 超时后跳过（用 Reviewer 结果代替）。

**194. levelRolePresets 用户配置可能不合理：** Task 4 的 levelRolePresets 允许用户调整角色组合。用户可能配出不合理组合（如 L5 去掉 Critic，或 L1 加 Architect）。必须有合理性检查——至少保留 executor 角色，L4/L5 至少保留 reviewer。

**195. 三个能力默认关闭但 Phase 54 演示模式需开启：** Phase 55 的所有能力默认 false（避免破坏现有测试）。但 Phase 54 的 DEMO_MODE_CONFIG_OVERRIDE 应叠加开启所有新能力——演示多 Agent 协作时展示完整能力链。需在 `applyDemoMode` 中追加所有新配置覆盖。

**196. CCR 缓存可能膨胀内存：** Task 9 的 CCRCache 默认 maxEntries=1000，每条缓存可能含大量原始消息。1000 条 × 平均 50 条消息 × 平均 500 tokens = 2500 万 tokens 的内存占用。必须严格设置 maxEntries 和 TTL，且在应用关闭时清理缓存。LRU 淘汰必须在每次 store 时触发，不能延迟。

**197. ccr_retrieve 工具的 hash 前缀冲突：** Task 9 的 ccr_retrieve 接受 12 位 hash 前缀。SHA-256 前 12 位有 48 位空间，冲突概率极低但非零。`findHashByPrefix` 必须处理多匹配情况——若前缀匹配多个 hash，返回全部让 LLM 选择，而非随机取一个。

**198. CacheAligner 可能破坏 system prompt 语义：** Task 10 的动态字段提取用正则匹配，可能误提取。例如代码示例中的日期字符串被提取后，system prompt 的代码示例变得不完整。必须只提取 system prompt 顶层的动态字段，不提取代码块/示例中的内容。`customDynamicFields` 的正则构造需转义特殊字符。

**199. IntelligentContext 评分的语义相似度过于简化：** Task 11 的 `scoreSemanticSimilarity` 只用关键词匹配，不是真正的语义相似度。对于同义词（如"错误"vs"exception"）无法匹配。短期可接受（关键词匹配已比 rolling window 好），长期应接入 embedding 模型计算语义相似度。但 embedding 推理有开销，需权衡。

**200. effort routing 的 routine 信号判定可能误判：** Task 12 的 `routeEffort` 用关键词匹配判定 routine 步骤。但"测试通过"可能出现在错误上下文中（如"测试通过的断言有误"）。必须检查上下文——只有当 lastToolResult 的整体语义是"成功完成"时才判定为 routine。简化方案：要求 routine 信号出现在 lastToolResult 的前 100 字符内（避免错误堆栈中的关键词误匹配）。

**201. verbosity steering 可能影响输出质量：** Task 12 的 terseness 提示可能让模型在需要详细解释时也过于简略。`holdoutRatio` 默认 0（全量压缩），但建议设为 0.1 保留对照组测量真实影响。若对照组显示质量下降，应关闭 verbosity steering。

**202. FailureLearner 的 LLM 调用增加失败处理延迟：** Task 13 的 learn 方法在 runCompletionGate 失败后调用 LLM 分析失败原因，这会增加失败处理的延迟（额外的 LLM 调用）。必须设超时（如 30 秒），超时后跳过学习直接返回失败。`maxLearningRatePerHour` 默认 3 防止连续失败时频繁调用 LLM。

**203. FailureLearner 可能写入低质量经验：** Task 13 的 LLM 分析可能产出泛泛而谈的经验（如"要仔细检查代码"）。`preventionRule` 必须是可执行的规则。解析后应检查 preventionRule 是否含动词（如"检查/验证/运行"），若不含则判定为低质量并丢弃。

**204. Part C 五个能力集中在 execution tab 可能 UI 膨胀：** Task 9-13 都扩展 `'execution'` tab，共新增约 30 个控件。execution tab 会过长。应把 CCR/IntelligentContext/CacheAligner 归入"上下文管理"子分组，OutputReduction/FailureLearning 归入"输出优化"子分组，用可折叠的 Section 分隔。

**205. Part C 与 Part A Task 2 的 Reboot Test 必须协同：** Task 9 的 CCR 和 Task 2 的 Reboot Test 必须协同——Reboot Test 重建上下文时，应在上下文摘要中提示"被 compact 的消息可通过 ccr_retrieve 工具取回"，并附上最近的 hash。若 CCR 未启用但 Reboot Test 启用，Reboot Test 的摘要应明确说明"原始消息已丢失，无法取回"。

---

## 思考引导总结

1. **三部分互补：** Part A（planning-with-files 借鉴）解决"探索阶段 context 膨胀/compact 后失忆/plan 版本追溯"三个轻量问题；Part B（难度路由多 Agent 组合）解决"按任务复杂度自动选择调度路径和 Agent 组合"的核心架构问题；Part C（headroom 压缩层借鉴）解决"compact 破坏性/前缀缓存失效/无重要性评分/输出 token 浪费/失败经验不沉淀"五个压缩层问题。三部分独立但协同——Part A 的 2-Action Rule 服务于 Part B 的 L4/L5 Researcher 角色，Part C 的 CCR 与 Part A 的 Reboot Test 协同让 compact 可逆。

2. **LLM 驱动而非规则驱动：** Part B 的难度判定完全由 LLM 完成，不用规则预筛。任务复杂度难以用简单规则捕捉（如"步骤数=4"可能是 L2 也可能是 L3）。LLM 能理解规则无法表达的细微差别，且判定可解释（reasoning 字段可追溯）。

3. **三路径直接映射复用现有引擎：** L1-L2→Solo，L3→DAG，L4-L5→CompositionalRouter。不新建路径，与 Phase 54 的架构统一层对齐。L5 的 Researcher/Critic 作为 CompositionalRouter 前后置阶段插入。

4. **动态升降级保留已完成工作：** 执行中发现复杂度与预判不符时允许切换路径。升降级时保留已完成步骤的 Blackboard 快照，未完成步骤交给新路径重新规划。不浪费已完成工作。但必须有最大升降级次数限制防无限循环。

5. **预置默认 + 用户可调整的角色配置：** 每级别有默认角色组合（L1=[executor]，L5=[researcher,architect,executor,reviewer,tester,critic]），用户可在设置页面增减。复用 AgentProfile 体系，不新建角色体系。

6. **反写死三要素齐备（本 Phase 强化）：** 每个 Task 都有配置接入（Zod schema）+ 设置页面接入（TabId + 控件）+ 代码接线点（文件级操作表格，含文件路径 + 函数/方法名 + 接入动作）。**本 Phase 强化约束：每个新工具函数必须列出调用方，每个新 schema 字段必须列出设置页控件，每个新 hook 必须列出触发点。没有接线点表的 Task 视为未完成，执行者不得提交。**

7. **hash 计算必须排除运行时字段：** Task 3 的 `computePlanHash` 只 hash 核心字段。step 状态变化（pending→completed）不应触发 hash 变化。

8. **CCR 让 compact 从破坏性变可逆：** Part C Task 9 的 CCR 是 headroom 最有价值的借鉴——compact 前缓存原始消息，注入 ccr_retrieve 工具，LLM 按需取回。这与 Part A Task 2 的 Reboot Test 协同——Reboot Test 重建上下文时，Agent 可通过 retrieve 工具取回被 compact 的关键信息。compact 不再是"失忆"操作。

9. **机制层借鉴不复刻壁垒：** Part C 只吸收 5 个机制层面的借鉴点（CCR/CacheAligner/IntelligentContext/Output reduction/learn），不复刻 headroom 的 SmartCrusher/CodeCompressor/Kompress 模型（核心壁垒，复刻成本极高）。每个借鉴点都适配 RouteDev 现有架构（compact/WorkerExecutor/loop.ts/goal-runner），不引入 ML 推理依赖，不引入 proxy 模式。明确排除的部分见 C.2 表格。

10. **Phase 55 是 v4.4.0 的核心增强：** Part A 是轻量收尾（3 个 Task），Part B 是核心架构（5 个 Task），Part C 是压缩层增强（5 个 Task）。共 13 个 Task，≥55 个测试。Part A 可独立交付，Part B 依赖 Part A 的 2-Action Rule（L4/L5 Researcher 需要），Part C 的 Task 9（CCR）与 Part A 的 Task 2（Reboot Test）必须协同落地。
