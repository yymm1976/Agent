# Phase 37 — 智能交互、自动化与开发者工作流增强

> **版本目标：** v2.9.0
> **前置依赖：** Phase 36 完成（v2.8.0）
> **新增测试要求：** ≥ 30 个
> **研究依据：** 原 Phase 37（需求澄清追问与自动化调度）+ 原 Phase 38（Git 分支实验与回滚增强）合并；新增插件生态兼容研究
> **核心命题：** RouteDev 在核心 Agent 能力上已成熟，但在"智能交互"（模糊目标时的追问）、"自动化"（定时任务+后台行为）、"开发者工作流"（分支实验+选择性回滚）、"生态扩展"（第三方插件兼容）四个维度仍有明显缺口。本 Phase 补齐这些能力，使 RouteDev 从"能用的工具"升级为"顺手的助手"。

---

## 研究背景：四个能力缺口的来源

### 1. 需求澄清追问 — 减少返工

当前 `/goal` 直接分解并执行。用户说"优化项目性能"，Agent 可能做了错误方向的优化——因为没问清楚是优化启动速度还是内存占用。Claude Code 的做法是先问 1-3 个澄清问题，"慢一步"但"少走弯路"。

### 2. 自动化与后台行为 — 生产力工具标配

用户需要"每天早上 8 点搜集新闻生成摘要"、"每小时检查依赖安全漏洞"这类定时任务。同时，Desktop 端关闭窗口后的行为（退出还是最小化到托盘、任务是否继续）应该由用户决定，而非硬编码。当前这两个能力都缺失。

### 3. Git 分支实验 — 从"检查点"到"实验场"

RouteDev 已有 CheckpointManager（基于 git commit）和 `/rollback`，但 Agent 始终在主分支上操作，无法"尝试方案 A 不满意再试方案 B"。`/branch` 命令只分支对话历史，不创建 Git 分支。回滚粒度也太粗——只能整体回滚，不能只回滚某个文件。

### 4. 插件生态兼容 — 开放性的下一步

RouteDev 有自己的插件系统（Phase 22：Theme/Tool/Hook/Router 四类），但 Codex、Claude Code 等工具也有各自的扩展生态。MCP（Model Context Protocol）正在成为 Agent 工具互通的事实标准。值得研究 RouteDev 能否通过 MCP 桥梁接入其他工具的插件生态。

---

## Task 1：/goal 需求澄清追问系统（≥ 7 测试）

### 1.1 问题定义

当用户输入模糊目标时，Agent 应该主动提问而非盲目执行。但不是每次都追问——只有目标模糊度超过阈值时才触发，且用户可以跳过。

### 1.2 设计方向

**新增模块：** `src/agent/requirements-clarifier.ts`

核心流程：

```
/goal "优化项目性能"
  ↓
RequirementsClarifier.clarify(goalText)
  ↓
a. LLM 分析目标模糊度（0~1 分数）
b. 模糊度 < threshold → 直接执行（现有流程）
c. 模糊度 >= threshold → 生成 1-3 个澄清问题
  ↓
展示追问 UI（CLI: 交互式提问 / Desktop: 模态对话框）
  ↓
用户回答 → 合并到 enrichedGoalText → 分解执行
```

**模糊度判定维度（供思考）：**
- 缺少具体对象（"优化"但没说优化什么）
- 缺少范围（"重构代码"但没说哪些文件）
- 缺少标准（"提高性能"但没说提高到多少）
- 包含歧义词汇（"这个""那个"指代不明）

**接口设计：**

```typescript
export interface ClarificationQuestion {
  id: string;
  question: string;
  context: string;    // 为什么问这个问题
  optional: boolean;   // 是否可跳过
}

export interface ClarificationResult {
  needsClarification: boolean;
  score: number;       // 模糊度 0~1
  questions: ClarificationQuestion[];
  enrichedGoal?: string;
}

export class RequirementsClarifier {
  constructor(options: {
    llmClient: ILLMClient;
    modelId: string;
    threshold?: number;     // 默认 0.4
    maxQuestions?: number;  // 默认 3
  });
  async clarify(goalText: string): Promise<ClarificationResult>;
  async enrichGoal(goalText: string, answers: Record<string, string>): Promise<string>;
}
```

**CLI 端追问交互示意：**

```
🎯 目标：优化项目性能

这个目标有些模糊，为了更精准地帮助你：

[1/3] 你具体想优化哪方面？
  ○ 启动速度  ○ 内存占用  ○ 响应时间  ○ 构建时间  ○ 其他

[2/3] 优化范围？
  ○ 整个项目  ○ 特定模块：____

[跳过追问]  [取消]
```

**Desktop 端**：在 ChatPage 中弹出 ClarificationModal，支持单选/多选/文本输入三种问题类型。

**配置项：**

```yaml
optimization:
  clarification:
    enabled: true
    threshold: 0.4
    maxQuestions: 3
    skipIfConfident: true  # LLM 置信度 > 0.8 时自动跳过
```

### 1.3 需要你决定的

1. **追问用哪个模型生成？** 主模型（贵但精准）还是分类器模型（便宜但可能不够细腻）？建议读 `router/classifier.ts` 和 `llm/base.ts` 后判断。
2. **追问后是否需要用户确认 enrichedGoal？** 合并回答后的目标文本，是否需要"我理解你的目标是…对吗？"的二次确认？
3. **多轮追问？** 当前设计只支持单轮追问。多轮追问（追问后再追问）虽然更精准，但可能让用户烦躁。建议先做单轮。

### 1.4 验收标准

- [ ] `RequirementsClarifier` 可实例化，`clarify()` 返回模糊度分数和追问列表
- [ ] `enrichGoal()` 将回答合并到目标文本
- [ ] CLI 端追问 UI 支持单选/多选/文本输入
- [ ] Desktop 端追问模态框支持三种问题类型
- [ ] 用户可"跳过追问"直接执行
- [ ] 配置项在 schema.ts 中定义
- [ ] SettingsPage 中有 Clarification Card（enabled/threshold/maxQuestions）
- [ ] ≥ 7 个单元测试

---

## Task 2：自动化调度与后台行为控制（≥ 13 测试）

### 2.1 问题定义

RouteDev 只能响应用户的实时输入，缺少定时任务能力。同时 Desktop 端关闭窗口后的行为硬编码，用户无法控制。这两个能力是生产力工具的标配。

### 2.2 自动化调度设计方向

**新增模块：**
- `src/scheduler/types.ts` — 调度类型
- `src/scheduler/engine.ts` — 调度引擎
- `src/scheduler/store.ts` — 任务持久化（JSON 文件）
- `src/cli/commands/schedule.ts` — `/schedule` 命令

**调度引擎核心接口：**

```typescript
export interface ScheduledTask {
  id: string;
  name: string;           // 用户可读名称
  goal: string;           // 目标描述
  cron: string;           // cron 表达式
  timezone: string;       // 时区（默认系统时区）
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  maxRuns?: number;       // 最大执行次数（可选）
  notifyOnComplete: boolean;
  createdAt: Date;
}

export interface ScheduleEngine {
  start(): void;
  stop(): void;
  add(task: ScheduledTask): void;
  remove(id: string): void;
  update(id: string, updates: Partial<ScheduledTask>): void;
  list(): ScheduledTask[];
  getNextRun(cron: string, timezone: string): Date;
}
```

**CLI 命令：**

```
/schedule list                  — 列出所有定时任务
/schedule add "每日新闻" "0 8 * * *" "搜集前端技术新闻"
/schedule remove <id>           — 删除任务
/schedule toggle <id>           — 启用/禁用
/schedule run <id>              — 立即手动执行一次
/schedule next                  — 下次执行时间
```

**Desktop 端：** SettingsPage 新增"自动化"标签页，包含定时任务列表、添加表单（名称/目标/cron+可视化选择器/时区/通知开关）、手动执行按钮、执行历史。

**后台行为要求：** 调度引擎必须在 Electron main process 中运行，即使 renderer 窗口关闭也能触发。任务执行时通过 IPC 调用 renderer 中的 GoalRunner（窗口打开时），或在 main process 中创建轻量 GoalRunner 实例（窗口关闭时）。

**配置项：**

```yaml
scheduler:
  enabled: true
  persistPath: "~/.routedev/scheduled-tasks.json"
  maxTasks: 20
  defaultTimezone: "Asia/Shanghai"
```

### 2.3 后台行为控制设计方向

**新增配置项（无新模块，纯配置+行为调整）：**

```yaml
general:
  backgroundBehavior: "ask"     # "exit" / "minimize-to-tray" / "ask"
  activeTaskOnClose: "prompt"   # "terminate" / "continue-in-background" / "prompt"
```

**行为映射表：**

| backgroundBehavior | activeTaskOnClose | 关闭窗口时的行为 |
|---|---|---|
| exit | terminate | 直接退出，终止所有任务 |
| minimize-to-tray | continue-in-background | 最小化到托盘，任务后台继续 |
| ask | prompt | 弹对话框询问用户 |

**组合校验规则：** 如果 `backgroundBehavior === 'exit'`，则 `activeTaskOnClose` 强制为 `'terminate'`（进程退出必然终止任务），UI 中禁用该选项并显示提示。

**系统托盘支持：** 关闭窗口时如果选择了"最小化到托盘"，创建 Tray 图标。托盘菜单：显示主窗口/查看任务/退出。任务完成后通过托盘气泡通知。

**注意：** macOS 的 dock 图标和 tray 图标是分开的，Windows 的 tray 图标需要显式创建。跨平台差异需要关注。

### 2.4 需要你决定的

1. **ScheduleEngine 用 node-cron 还是自研定时器？** node-cron 依赖少但功能有限；自研可控但增加维护成本。建议读 `package.json` 现有依赖后判断。
2. **窗口关闭后 main process 中如何调用 GoalRunner？** 是否需要把 GoalRunner 的部分逻辑提取到 main process？建议读 `desktop/main/src/index.ts` 和 `cli/goal-runner.ts`。
3. **后台行为的两组配置是否有组合冲突？** "exit" + "continue-in-background" 逻辑上不可能。校验逻辑放在哪里？

### 2.5 验收标准

**调度系统：**
- [ ] `ScheduleEngine` 基于 cron 表达式调度
- [ ] 任务持久化到 JSON 文件，重启后恢复
- [ ] `/schedule` 命令完整实现（list/add/remove/toggle/run/next）
- [ ] Desktop 端"自动化"标签页可管理定时任务
- [ ] 任务到达触发时间自动执行 goal
- [ ] 支持通知（Desktop 系统通知/CLI 日志）
- [ ] 窗口关闭后定时任务仍能触发

**后台行为：**
- [ ] Desktop 端关闭窗口时根据配置执行对应行为
- [ ] "ask"模式弹对话框询问用户
- [ ] "minimize-to-tray"模式创建系统托盘图标
- [ ] 托盘菜单支持"显示主窗口"和"退出"

**SettingsPage：**
- [ ] 自动化 Tab 有 Scheduler Card（enabled/maxTasks）
- [ ] appearance Tab 有 BackgroundBehavior Card（两组 Radio，含组合校验）

**测试：** ≥ 13 个

---

## Task 3：Git 分支实验与选择性回滚（≥ 10 测试）

### 3.1 问题定义

当前 Agent 直接在主分支上修改代码，用户无法让 Agent "尝试多种方案后选择最优"。回滚粒度也太粗——`/rollback` 只能整体回滚到某个检查点，不能只回滚某个文件。

**理想体验：** Agent 说"我有两种实现方案，A 用递归，B 用迭代。让我在两个分支上分别实现，你对比后选择。"

### 3.2 Git Worktree 实验分支设计方向

**核心机制：Git Worktree**

Git Worktree 允许同一仓库创建多个独立工作目录，共享 `.git`：

```bash
git worktree add .routedev/experiments/exp-001 feature-branch
# 在 exp-001 中独立工作，不影响主工作区
git worktree remove .routedev/experiments/exp-001
```

优势：零额外磁盘开销、真正的文件系统隔离、天然支持分支对比、不需要 Docker/VM。

**目录结构：**

```
用户工作区（main worktree）
    ├── src/...                    ← 主分支代码
    ├── .routedev/
    │   ├── experiments/           ← 实验工作树根目录
    │   │   ├── exp-001/           ← 方案 A
    │   │   └── exp-002/           ← 方案 B
    │   └── experiment-registry.json
    └── .git/                      ← 共享
```

**ExperimentManager 接口：**

```typescript
class ExperimentManager {
  async createExperiment(name: string, baseBranch?: string): Promise<Experiment>
  async runInExperiment(expId: string, task: string): Promise<ExperimentResult>
  async compareExperiments(expA: string, expB: string): Promise<ExperimentDiff>
  async adoptExperiment(expId: string): Promise<void>
  async discardExperiment(expId: string): Promise<void>
  listExperiments(): Experiment[]
}
```

**CLI 命令：**

```
/experiment create <名称> [基于分支]  — 创建实验分支
/experiment list                       — 列出实验
/experiment run <id> <任务描述>        — 在实验分支上运行
/experiment compare <id-a> <id-b>      — 对比两个实验
/experiment adopt <id>                 — 采纳（合并到当前分支）
/experiment discard <id>               — 丢弃
```

**与现有系统的集成：**
- CheckpointManager 在实验分支上仍然工作（独立检查点链）
- DurableExecutor 的断点恢复支持在实验分支上恢复
- AuditLogger 记录实验创建/运行/采纳/丢弃操作

### 3.3 选择性回滚设计方向

扩展 `/rollback` 命令，增加文件级和步骤级粒度：

```
/rollback <checkpoint-id>              — 整体回滚（已有行为）
/rollback file <path> [checkpoint-id]  — 只回滚指定文件
/rollback step <step-id>               — 回滚到某步骤之前
/rollback preview <checkpoint-id>      — 预览回滚差异（不执行）
```

**安全设计：**
- 所有回滚前检查工作区是否干净（Phase 29 已有）
- 预览模式必须可用
- 文件级回滚后自动创建"回滚前快照"检查点（防误操作）

### 3.4 方案对比与决策辅助设计方向

`/experiment compare` 的增强输出应包含：

- 文件差异（unified diff 摘要）
- 测试通过率（自动在实验分支上运行 `npm test`）
- 性能数据（如果有 benchmark）
- Token 消耗对比
- Agent 辅助推荐（将对比数据注入上下文，让 Agent 给出建议）

### 3.5 需要你决定的

1. **实验分支基于当前分支还是某个检查点？** 基于检查点需要 `git checkout -b <branch> <commit-hash>`。
2. **实验工作树的位置：** `.routedev/experiments/` 还是 `.git/worktrees/`？前者更可控，后者更标准。
3. **实验并发执行：** 是否支持同时在多个实验上运行 Agent？建议默认串行。
4. **采纳实验的合并策略：** `git merge`（保留历史）还是 `git checkout` 文件 + 新 commit（线性历史）？
5. **文件级回滚的"回滚前快照"是否计入 maxCheckpoints 限制？**
6. **采纳实验时的 merge conflict 如何处理？** 建议中止合并并提示用户手动解决，而非自动选择。

### 3.6 验收标准

**实验分支：**
- [ ] `ExperimentManager` 可创建基于 Git Worktree 的实验分支
- [ ] Agent 可在实验分支上独立执行，不影响主工作区
- [ ] `/experiment compare` 展示代码差异、测试通过率、token 消耗
- [ ] `/experiment adopt` 合并回主分支
- [ ] `/experiment discard` 清理实验工作树和分支
- [ ] 实验分支上的检查点独立管理

**选择性回滚：**
- [ ] `/rollback file` 只回滚指定文件
- [ ] `/rollback step` 回滚到指定步骤之前
- [ ] `/rollback preview` 只展示差异，不修改文件
- [ ] 文件级回滚后自动创建"回滚前快照"

**测试：** ≥ 10 个

---

## Task 4：插件生态兼容研究（≥ 3 测试）

### 4.1 问题定义

RouteDev 有自己的插件系统（Phase 22），但 AI 编码工具生态正在快速演化：

- **OpenAI Codex**：通过 AGENTS.md / CODEX_INSTRUCTIONS 定义 Agent 行为约定，通过 MCP 服务器扩展工具
- **Claude Code**：通过 CLAUDE.md 定义项目约定，通过 MCP 服务器扩展工具，有 Slash Commands
- **Cursor**：通过 .cursorrules 定义行为约定，通过 MCP 扩展工具

三者的共同点：**MCP 是工具层的通用协议**。差异在于约定文件格式和执行运行时。

### 4.2 研究方向

**研究目标：** 评估 RouteDev 接入第三方插件生态的可行路径，输出研究报告 + 原型验证。

**研究维度：**

1. **MCP 桥梁可行性：** RouteDev 已有 MCP 客户端（Phase 8）。Codex 和 Claude Code 都支持 MCP 服务器。理论上 RouteDev 可以直接连接任何 MCP 服务器，获得相同的工具能力。需要验证：
   - RouteDev 的 MCP 客户端能否连接 Codex/Claude Code 生态的 MCP 服务器？
   - 工具描述格式是否兼容？
   - 有没有 RouteDev 不支持但其他生态常用的 MCP 特性？

2. **约定文件兼容性：** AGENTS.md、CLAUDE.md、CODEX_INSTRUCTIONS 格式各异但本质都是"告诉 Agent 怎么做"。研究是否需要：
   - 一个通用约定文件解析器（支持多种格式）
   - 或者约定文件互转工具
   - 或者 RouteDev 只需要支持自己的 AGENTS.md（已经是事实标准）

3. **插件市场可行性：** 目前 Codex 和 Claude Code 都没有公开的插件市场 API。研究：
   - MCP 服务器注册表（如 mcp.so、Smithery 等社区方案）
   - RouteDev 是否有必要建自己的插件市场
   - 还是应该作为消费者接入已有的 MCP 服务器注册表

4. **运行时差异分析：** 三者运行在不同环境中（Node.js / 沙箱 / 终端），哪些插件能力可以跨运行时复用，哪些不行。

### 4.3 交付物

- **研究报告**（写入 `docs/PLUGIN_ECOSYSTEM_RESEARCH.md`）：覆盖上述四个维度，每个维度有结论和推荐路径
- **原型验证**：至少验证 RouteDev 连接一个 Codex/Claude Code 生态的 MCP 服务器，工具可正常调用
- **兼容性评估表**：列出 RouteDev 与 Codex/Claude Code 在工具层、约定层、运行时层的兼容项和不兼容项

### 4.4 需要你决定的

1. **研究深度：** 做到"调研报告 + 原型验证"还是只做"调研报告"？建议前者，因为原型验证能暴露纸面分析发现不了的问题。
2. **优先兼容方向：** 优先研究 Codex 生态还是 Claude Code 生态？还是两者并重？
3. **MCP 服务器注册表：** 是否值得在 RouteDev 中加入"从 MCP 注册表一键安装"的能力？

### 4.5 验收标准

- [ ] `docs/PLUGIN_ECOSYSTEM_RESEARCH.md` 研究报告存在，覆盖四个维度
- [ ] 至少验证一个第三方 MCP 服务器的连接可行性
- [ ] 兼容性评估表存在
- [ ] 研究结论有明确推荐路径
- [ ] ≥ 3 个原型验证测试（MCP 连接、工具调用、描述兼容性）

---

## Task 5：集成测试与文档同步

### 5.1 测试矩阵

| 测试文件 | 测试内容 | 数量 |
|----------|---------|:---:|
| `tests/phase37/requirements-clarifier.test.ts` | 模糊度分析、追问生成、目标富化、阈值边界 | ≥ 7 |
| `tests/phase37/schedule-engine.test.ts` | cron 解析、任务调度、持久化、时区、通知 | ≥ 8 |
| `tests/phase37/background-behavior.test.ts` | 配置解析、行为映射、托盘创建、组合校验 | ≥ 5 |
| `tests/phase37/experiment-worktree.test.ts` | Worktree 创建/运行/对比/采纳/丢弃 | ≥ 5 |
| `tests/phase37/selective-rollback.test.ts` | 文件级/步骤级/预览回滚 | ≥ 3 |
| `tests/phase37/plugin-ecosystem.test.ts` | MCP 桥梁原型验证 | ≥ 3 |

**总计：≥ 31 个测试**

### 5.2 文档同步

- **AGENTS.md 陷阱更新：** 新增 #55-59
- **CODEMAP.md：** 新增 `src/agent/requirements-clarifier.ts`、`src/scheduler/`、`src/harness/experiment-manager.ts`、`src/cli/commands/experiment.ts`、`src/cli/commands/schedule.ts`
- **CHANGELOG.md：** v2.9.0 条目
- **package.json：** 版本号升级到 v2.9.0

### 5.3 验收标准

- [ ] 全部测试通过（≥ 31 个）
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过
- [ ] AGENTS.md 新增陷阱 #55-59
- [ ] CODEMAP.md / CHANGELOG.md 已更新

---

## 陷阱预告（写入 AGENTS.md）

**#55 RequirementsClarifier 的阈值不是越低越好：** threshold 设太低（如 0.1）几乎所有 `/goal` 都触发追问；设太高（如 0.7）模糊目标被直接执行。建议默认 0.4，记录跳过追问后的返工率用于后续调优。

**#56 ScheduleEngine 的任务执行不能阻塞主线程：** 定时任务触发时调用 GoalRunner 是异步但可能长时间运行。ScheduleEngine 应该在独立的事件循环中调度。

**#57 系统托盘在 macOS 和 Windows 上的行为差异：** macOS 的 dock 图标和 tray 图标分开；Windows 的 tray 需要显式创建。跨平台测试必须。

**#58 Git Worktree 与 CheckpointManager 的检查点链隔离：** 实验分支的检查点在 `.routedev/experiments/` 中，但 CheckpointManager 的元数据文件是全局的。实验分支的检查点必须标记 `experimentId`，`list()` 默认只显示当前分支。

**#59 采纳实验时的 merge conflict：** `/experiment adopt` 合并到主分支时如果产生冲突，应中止并提示用户手动解决。自动选择某一方的修改 = 数据丢失风险。

---

## 思考引导汇总

| # | 问题 | 关联 Task | 建议阅读的代码 |
|---|------|:---:|------|
| 1 | 追问用主模型还是分类器模型？ | Task 1 | `router/classifier.ts` + `llm/base.ts` |
| 2 | 追问回答后是否二次确认 enrichedGoal？ | Task 1 | `cli/components/` 现有交互组件 |
| 3 | ScheduleEngine 用 node-cron 还是自研？ | Task 2 | `package.json` 现有依赖 |
| 4 | 窗口关闭后 main process 如何调用 GoalRunner？ | Task 2 | `desktop/main/src/index.ts` + `cli/goal-runner.ts` |
| 5 | 后台行为两组配置的组合冲突校验放哪里？ | Task 2 | `desktop/main/src/index.ts` window-all-closed 事件 |
| 6 | 实验分支基于当前分支还是检查点？ | Task 3 | `checkpoint-manager.ts` 的 checkpoints 数组结构 |
| 7 | 采纳实验用 merge 还是 checkout + commit？ | Task 3 | `checkpoint-manager.ts` 的 rollback 实现 |
| 8 | WorkerContext UI 放 optimization Tab 还是新建高级 Tab？ | Task 2 | `SettingsPage.tsx` optimization Tab 布局 |
| 9 | 插件生态优先兼容 Codex 还是 Claude Code？ | Task 4 | `mcp/client.ts` + 第三方 MCP 服务器文档 |

---

## 不在本 Phase 范围内

| 项目 | 理由 |
|------|------|
| 条件触发任务（如"当文件变更时执行"） | 需要文件系统监听+防抖，复杂度高于定时任务，后续迭代 |
| 任务执行历史可视化（甘特图/时间线） | UI 复杂度高，当前日志+通知已足够 |
| 多设备任务同步 | 需要云端存储，超出桌面工具范围 |
| 追问系统的多轮追问 | 单轮已覆盖 90% 场景，多轮增加复杂度且可能让用户烦躁 |
| 浏览器自动化（Playwright MCP） | 独立能力，可在后续 Phase 作为 MCP 桥梁研究的延伸 |
| 插件市场的正式实现 | 研究阶段尚未完成，实现留待后续 Phase |
