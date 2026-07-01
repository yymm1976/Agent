# /goal 执行流程重设计

- **日期**：2026-06-28
- **状态**：待用户复查
- **主题**：重新设计 /goal 命令的执行流程，按任务复杂度自动选择执行路径，接入高价值子 Agent 模块，解决"为分步而分步拖慢进度 + 缓存率降低"问题

---

## 1. 背景与问题

### 1.1 当前问题

当前 /goal 命令的执行流程存在三个核心问题：

1. **恒走多 Agent 路径**：`orchestrationEnabled = orchestrator && workerExecutor && blackboard` 三者总是注入（[goal-runner.ts:701](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/goal-runner.ts#L701)），所有任务都被推到多 Agent 路径，即使简单任务也每步启动独立 Worker
2. **缓存命中率极低**：每个 Worker 的 `enhancedPrompt = baseSystemPrompt + rolePrompt + blackboardContext`（[worker-executor.ts:256-264](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/worker-executor.ts#L256-L264)），rolePrompt 因角色而异、blackboardContext 随步骤增长 → system prompt 跨 Worker 不命中；又因 `profileManager` 总是注入使 `workerHistory = []` → 无 history 前缀可复用
3. **高价值模块未启用**：项目有 37 个子 Agent 相关模块，只有 10 个真正启用；CompositionalRouter/BoundedRecovery/DagEngine/SelfEvolution/detachedSession/DelegationPolicy 全部开关 false；其中 DualLoopOrchestrator 和 detachedSession 存在接线断层

### 1.2 用户痛点

- "为分步而分步拖慢进度" —— 简单任务被强制走多 Agent，启动开销大
- "缓存率降低" —— 多 Agent 路径结构性破坏 prompt 缓存
- "审查不通过后不能打回去重新改" —— 迭代闭环开关被配置阻塞（已在前序修复）
- 希望高价值模块真正接入 /goal 流程，而非停留在"代码写了但没启用"

---

## 2. 决策清单

通过 10 轮澄清问题对齐的决策：

| # | 决策点 | 选定方案 |
|---|--------|---------|
| 1 | 路径判定方式 | **任务复杂度自动判定**：1-2 步无依赖单领域→单 Agent；3+ 步有依赖单领域→DAG；跨领域→CompositionalRouter |
| 2 | 判定输入信号来源 | **扩展 GoalParser 输出**：LLM 分解时同时输出 dependencies + domain，一次调用拿全信号 |
| 3 | DAG 与 CompositionalRouter 分工 | **DAG 为主，跨领域才升级到 CompositionalRouter**：单领域复杂任务走 DAG，跨领域走 CompositionalRouter |
| 4 | 多 Agent 缓存命中方案 | **固定前缀 + 黑板后置**：system prompt 拆固定前缀（打 cache_control）+ 可变后缀（不打）；Worker history 不再强制清空，用 tail 切片 |
| 5 | 失败恢复策略 | **BoundedRecovery 局部重跑 + 修复 DualLoop 接线**：步骤级失败局部重跑，验证失败 DualLoop 打回，修复两个接线断层 |
| 6 | detachedSession 定位 | **仅 spawn_agent 路径用**：/goal 多 Agent 走 WorkerExecutor（性能优先），主 Agent 临时派发走 detachedSession（隔离优先） |
| 7 | DelegationPolicy + 契约机制 | **接入 spawn_agent 前置门控**：三态判定 + 契约下发 + 有限质疑权 |
| 8 | SelfEvolution 是否纳入 | **一起接入**：DualLoop 修复后立即接入，消费执行信号产出提案 |
| 9 | 现有迭代闭环去留 | **替换（先保留为 fallback，验证通过后删除）**：新路径走 DualLoop + BoundedRecovery；旧迭代闭环代码保留为 P2 降级兜底，验证标准见第 9 节 |
| 10 | 改造交付方式 | **一次性全量交付 + 配置开关守护 + 设置页接入**：默认走新路径，legacy 作为 fallback，验证后删除旧代码 |

---

## 3. 架构总览

### 3.1 三条执行路径

```
/goal "xxx"
  ↓
GoalParser.parse（扩展输出：steps + dependencies + domain）
  ↓
ExecutionRouter.route(plan)  ← 新增组件，路径判定器
  ↓
  ├─ 路径 1：单 Agent       （1-2 步，无依赖，单领域）
  │   共享主 history + systemPrompt → 缓存命中最大化
  │   ↓
  │   ReActAgentLoop.run()
  │
  ├─ 路径 2：DAG 引擎       （3+ 步，有依赖，单领域）
  │   拓扑排序 + 分层并行
  │   ↓
  │   DagEngine.execute(plan) → WorkerExecutor（固定前缀缓存）
  │   失败 → BoundedRecovery 局部重跑
  │
  └─ 路径 3：CompositionalRouter （跨领域，多 domain）
      Decompose → 检索 Skill → Compose DAG
      ↓
      CompositionalRouter.route(plan) → DagEngine.execute(composedPlan)
      失败 → BoundedRecovery 局部重跑
```

### 3.2 验证与失败恢复

```
执行完成
  ↓
DualLoopOrchestrator（双循环）
  ├─ 内循环：执行 Agent（DAG/单 Agent 路径）
  └─ 外循环：验证 Agent（不同模型，打破自评盲区）
      ↓
      验证通过 → GoalAuditor 三层审计 → done
      验证失败 → DualLoop 打回到内循环
                   ↓
                   BoundedRecovery 回退到最近 checkpoint
                   只重跑失败步骤及其依赖闭包
```

### 3.3 主 Agent 临时派发（非 /goal 路径）

```
spawn_agent 工具调用
  ↓
DelegationPolicy 三态门控（allow / delegate / refuse）
  ↓
  ├─ refuse：主 Agent 自己做
  ├─ allow：直接执行（通用任务）
  └─ delegate：
      ↓
      DelegationContractManager 下发契约
      ↓
      detachedSession 创建独立会话
      ↓
      子 Agent 执行（有有限质疑权，最多 3 次）
      ↓
      SubAgentLifecycle 状态机管理
      ↓
      SubAgentScoreCardCollector 记录质量
```

### 3.4 SelfEvolution（横切关注点）

SelfEvolutionFramework 不直接参与 /goal 执行，而是作为横切关注点消费执行信号：

```
DualLoopOrchestrator 执行轨迹
  ↓
LoopMemory + ScoreCard + ProcessDefect 信号
  ↓
SelfEvolutionFramework
  ├─ GodelProposer：基于规则识别可改进模式 → 产出提案
  └─ SelfHarnessLoop：弱点挖掘 + 提案 + 回归测试
      ↓
      提案（不自动应用，需用户确认）
```

### 3.5 旧代码处理

- 旧多 Agent 路径（`executePlanWithMultiAgent`）+ 迭代闭环代码（goal-runner.ts:909-985）保留为 fallback
- `executionRouter=legacy` 时触发
- 新路径验证通过后删除（验证标准见第 9 节）

---

## 4. 组件清单与改动点

### 4.1 新增组件（1 个）

#### ExecutionRouter（路径判定器）
- **文件**：`src/agent/execution-router.ts`（新增）
- **职责**：根据 GoalPlan 的 steps + dependencies + domain 判定走哪条执行路径
- **接口**：
```typescript
export type ExecutionRoute = 'single' | 'dag' | 'compose' | 'legacy';

export interface ExecutionRouterOptions {
  mode: 'auto' | 'legacy' | 'explicit';
  explicitRoute?: ExecutionRoute;  // mode=explicit 时生效
  singleAgentMaxSteps: number;     // 默认 2
  dagMaxDomains: number;           // 默认 1（超过则升级到 compose）
}

export class ExecutionRouter {
  route(plan: GoalPlan, options: ExecutionRouterOptions): ExecutionRoute;
}
```
- **判定逻辑**（mode=auto）：
  - `steps.length <= singleAgentMaxSteps && dependencies.length === 0 && uniqueDomains <= dagMaxDomains` → `single`
  - `uniqueDomains <= dagMaxDomains` → `dag`
  - 否则 → `compose`
- **依赖**：无（纯函数，便于测试）

### 4.2 改造组件（6 个）

#### 4.2.1 GoalParser（扩展输出）
- **文件**：`src/agent/goal-parser.ts`
- **改动**：
  - `PARSER_SYSTEM_PROMPT` 增加要求：输出 `dependencies: number[]`（步骤依赖的前置步骤 id）和 `domain: string`（步骤所属领域，如 "frontend"/"backend"/"config"/"docs"）
  - `GoalStep` 类型扩展：新增 `domain: Domain` 字段（`type Domain = 'frontend' | 'backend' | 'config' | 'docs' | 'database' | 'infra' | 'test' | 'general'`，小写枚举，大小写不敏感比较时统一转 lowercase）；`dependencies` 字段不再被 sanitizeSteps 清空
  - `validatePlan` 增加校验：依赖图无环（拓扑排序检测）、domain 非空
  - `sanitizeSteps` 兜底：依赖图有环时断环（移除构成环的边）、domain 缺失时填充 "general"

#### 4.2.2 WorkerExecutor（固定前缀缓存）
- **文件**：`src/agent/multi/worker-executor.ts`
- **改动**：`enhancedPrompt` 构造从单字符串改为数组：
```typescript
// 改造前
const enhancedPrompt = [baseSystemPrompt, rolePrompt, blackboardContext].join('\n');

// 改造后（Anthropic cache_control 友好）
const systemBlocks = [
  { type: 'text', text: baseSystemPrompt, cache_control: { type: 'ephemeral' } },  // 固定前缀，跨 Worker 命中
  { type: 'text', text: `${rolePrompt}\n\n## 当前协作上下文\n${blackboardContext}` },  // 可变后缀，不缓存
];
```
- **history 策略调整**：不再强制 `workerHistory = []`，改为：
  - `workerContext.enabled && workerContext.strategy === 'tail'` → `history.slice(-maxMessages)`
  - 否则 → `[]`（保留原行为）
  - 移除"profileManager 注入则强制清空"的逻辑

#### 4.2.3 goal-runner.ts（接入 ExecutionRouter + 替换迭代闭环）
- **文件**：`src/cli/goal-runner.ts`
- **改动**：
  - `executeGoalPlan` 内 `orchestrationEnabled` 判定替换为 `ExecutionRouter.route()` 分发
  - 新增 `executePlanWithDag`：调用 `DagEngine.execute(plan)`，WorkerExecutor 作为执行单元
  - 新增 `executePlanWithCompose`：调用 `CompositionalRouter.route(plan)` 生成组合计划，再调 `DagEngine.execute`
  - 迭代闭环代码（909-985 行）**先保留为 fallback**：新路径用 `DualLoopOrchestrator.run()` 替代，但旧代码保留作为 P2 降级兜底（见第 7 节）；验证通过后删除（见第 9 节）
  - `verifyPlan` + `runCompletionGate` 保留，被 DualLoop 内部调用

#### 4.2.4 ReActAgentLoop（修复 DualLoop 接线断层）
- **文件**：`src/agent/loop.ts`
- **改动**：新增并实现 `setDualLoopOrchestrator(orchestrator: DualLoopOrchestrator): void` 方法（app-init.ts 已有弱类型调用点 `loop.setDualLoopOrchestrator?.()`，但 loop.ts 中该方法不存在，所以 `?.()` 实际是 no-op；本次在 loop.ts 中真正实现）
  - `run()` 入口处检查 `dualLoopOrchestrator` 是否注入
  - 已注入 → 调 `dualLoopOrchestrator.run()` 转交控制权
  - 未注入 → 走原逻辑（向后兼容）
  - app-init.ts 的弱类型断言 `as unknown as` 改为强类型调用

#### 4.2.5 app-init.ts（修复 detachedSession 接线 + 启用高价值模块）
- **文件**：`src/cli/app-init.ts`
- **改动 1**：`delegationDeps` 构造补传 `detachedSessionEnabled` 字段
- **改动 2**：高价值模块开关默认改为 `true`（在 defaults.ts + schema.ts 同步），共 22 个开关（与第 6.3 节配置字段映射表中默认值为 true 的开关一一对应）
- **改动 3**：实例化 ExecutionRouter 并注入 goal-runner

#### 4.2.6 config schema + defaults（新增 executionRouter 配置）
- **文件**：`src/config/schema.ts` + `src/config/defaults.ts`
- **新增配置项**：
```typescript
goal: {
  executionRouter: {
    mode: z.enum(['auto', 'legacy', 'explicit']).default('auto'),
    explicitRoute: z.enum(['single', 'dag', 'compose', 'legacy']).optional(),
    singleAgentMaxSteps: z.number().int().min(1).max(5).default(2),
    dagMaxDomains: z.number().int().min(1).max(5).default(1),
  },
}
```

### 4.3 接入但不大改的模块（验证接线即可）

| 模块 | 验证点 |
|------|--------|
| DagEngine | `goalParser.setDagEngine()` 注入后，`executePlanWithDag` 能调用 `dagEngine.execute()` |
| BoundedRecoveryManager | `dualLoopOrchestrator.setBoundedRecovery()` 已注入，验证失败时触发局部重跑 |
| CompositionalRouter | `executePlanWithCompose` 能调用 `compositionalRouter.route()` |
| DualLoopOrchestrator | 修复 `loop.ts` 接线后，`run()` 能被调用 |
| CrossModelReviewer | DualLoop 内部调用，验证跨模型审查生效 |
| DelegationPolicy | spawn_agent 前置门控，验证三态判定 |
| DelegationContractManager | 验证契约下发 + 质疑机制 |
| SubAgentSessionScope | 修复 detachedSession 字段后，验证独立会话创建 |
| SelfEvolutionFramework | DualLoop 执行轨迹能被消费，验证提案生成 |
| ContextPacker | WorkerExecutor 注入后，验证上下文打包 |
| SubAgentLifecycle | 验证状态机管理 |
| SubAgentScoreCardCollector | 验证质量记录 |
| CircuitBreaker | 验证连续失败熔断 |
| StrategySelector | Orchestrator 注入后，验证策略选择 |
| ExecutionStateGraph | 验证步骤级状态跟踪 |

### 4.4 改动文件清单汇总

| 类型 | 文件 | 改动量 |
|------|------|--------|
| 新增 | `src/agent/execution-router.ts` | ~80 行 |
| 改造 | `src/agent/goal-parser.ts` | ~50 行 |
| 改造 | `src/agent/multi/worker-executor.ts` | ~30 行 |
| 改造 | `src/cli/goal-runner.ts` | ~150 行 |
| 改造 | `src/agent/loop.ts` | ~20 行 |
| 改造 | `src/cli/app-init.ts` | ~40 行 |
| 改造 | `src/config/schema.ts` | ~15 行 |
| 改造 | `src/config/defaults.ts` | ~30 行 |
| 改造 | 现有设置页组件（新增配置项按第 6.2 节分区放置） | ~100 行 |
| **合计** | | **~515 行** |

---

## 5. 数据流与执行流程

### 5.1 完整执行流程时序

```
用户输入: /goal "为用户管理模块添加分页功能，前端列表组件需要改造，后端接口需要支持 page/size 参数，数据库需要加索引"
                                ↓
[1] goal-runner.ts: handleGoalCommand
    ├─ 正则解析 description + verificationCriteria
    ├─ classifier.classify + modelRouter.route
    ├─ (可选) clarifyGoalIfNeeded
    └─ (可选) GoalPromptBuilder.build
                                ↓
[2] GoalParser.parse（扩展输出）
    ├─ LLM 分解，输出每个步骤的：
    │   { id, description, acceptanceCriteria, suggestedRole, dependencies, domain }
    ├─ validatePlan 校验：
    │   ├─ 步骤数 ≤ 15
    │   ├─ 重复检测（Jaccard > 0.7）
    │   ├─ 验收标准非空
    │   ├─ 依赖图无环（拓扑排序检测）  ← 新增
    │   └─ domain 非空                ← 新增
    └─ sanitizeSteps 兜底（重试耗尽时）：
        ├─ 去重 + 截断
        ├─ 重排 id + dependencies
        ├─ 依赖图有环 → 断环（移除构成环的边）  ← 新增
        └─ domain 缺失 → 填充 "general"          ← 新增
                                ↓
[3] ExecutionRouter.route(plan, options)
    判定逻辑（mode=auto）：
    ├─ steps.length=5, uniqueDomains={frontend, backend, database}=3
    ├─ 3 > dagMaxDomains(1) → 返回 'compose'
    └─ （若 uniqueDomains=1 且 steps.length=5 → 返回 'dag'）
                                ↓
[4] 按路径分发执行
    ├─ 路径 1: single → for 循环 agentLoop.run（共享 history + systemPrompt）
    ├─ 路径 2: dag → dagEngine.execute(plan, { workerExecutor })
    ├─ 路径 3: compose → compositionalRouter.route(plan) → dagEngine.execute
    └─ 路径 4: legacy → executePlanWithMultiAgent（旧路径 fallback）
                                ↓
[5] DualLoopOrchestrator.run()（验证循环，替换旧迭代闭环）
    内循环：[4] 的执行路径
    外循环：验证 Agent（不同模型）
    ├─ 执行完成 → verifyPlan + runCompletionGate + GoalAuditor.audit
    ├─ 验证通过 → 返回 success
    └─ 验证失败 → BoundedRecovery 局部重跑 → 回到内循环
                                ↓
[6] done 事件 + 任务摘要
```

### 5.2 WorkerExecutor 缓存数据流

```
WorkerExecutor.execute(step, plan)
  ↓
构造 system blocks：
  blocks = [
    { type: 'text', text: baseSystemPrompt, cache_control: { type: 'ephemeral' } },  // 固定前缀
    { type: 'text', text: `${rolePrompt}\n\n## 当前协作上下文\n${blackboardContext}` }  // 可变后缀
  ]
  ↓
构造 history：
  if (workerContext.enabled && workerContext.strategy === 'tail') {
    workerHistory = conversationHistoryRef.current.slice(-maxMessages)
  } else {
    workerHistory = []
  }
  // 注：workerContext.enabled 默认 true（在 defaults.ts 中显式设置）
  ↓
agentLoop.run({ systemBlocks, conversationHistory: workerHistory })
  ↓
Anthropic API：固定前缀跨 Worker 命中，可变后缀不缓存
```

### 5.3 DualLoop 状态机数据流

> **概念区分**：`maxRounds`（来自 `config.goalVerifier.iterative.maxRounds`，默认 3）是**外循环验证轮数**；`maxRetries`（硬编码 3）是**步骤级重跑次数**（见 7.3 节 BoundedRecovery）。两者是不同层面的重试限制，互不影响。

```
DualLoopOrchestrator.run(plan)
  ↓
初始化：
  innerAgent = 主执行 Agent
  outerAgent = 验证 Agent（不同模型）
  boundedRecovery = 已注入
  maxRounds = config.goalVerifier.iterative.maxRounds
  ↓
Round N:
  innerResult = innerAgent.execute(plan)
  verifyResult = outerAgent.verify(innerResult)
  ├─ passed=true → GoalAuditor.audit → 通过则返回 success
  └─ passed=false → BoundedRecovery.recover(plan, verifyResult)
      ├─ 识别失败步骤
      ├─ 回退到最近 checkpoint
      ├─ 计算依赖闭包
      └─ 标记闭包内步骤为 pending → 回到 Round N+1
  ↓
达到 maxRounds 仍失败 → 返回 failed
```

### 5.4 关键数据结构变更

#### GoalStep 扩展
```typescript
export type Domain = 'frontend' | 'backend' | 'config' | 'docs' | 'database' | 'infra' | 'test' | 'general';

export interface GoalStep {
  id: number;
  description: string;
  acceptanceCriteria?: string;
  dependencies: number[];      // 已有，改造后不再被清空
  suggestedRole?: 'researcher' | 'executor' | 'reviewer';
  domain: Domain;              // 新增：步骤所属领域（小写枚举）
}
```

#### WorkerExecutor 调用签名变更
```typescript
// 改造后
agentLoop.run({
  systemBlocks: [
    { type: 'text', text: fixedPrefix, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: variableSuffix },
  ],
  conversationHistory: workerHistory,  // tail 切片或空数组
})
```

---

## 6. 设置页 UI

### 6.1 设计原则

复用现有设置页结构，新增配置项按第 6.2 节表格指定的分区放置。现有设置页用户已满意，不改动布局。若目标分区不存在则回退到"目标验证"分区并在 PR 中说明，不得自行新增分区。

### 6.2 新增配置项位置

新增配置项按所属分区放置：

| 配置项 | 所属分区 | UI 控件 |
|--------|---------|---------|
| 路径判定模式 | 目标验证 | 单选（auto/legacy/explicit） |
| 单 Agent 最大步数 | 目标验证 | Stepper |
| DAG 最大领域数 | 目标验证 | Stepper |
| DAG 引擎开关 | 目标验证 | Toggle |
| 组合路由开关 | 目标验证 | Toggle |
| 策略选择器开关 | 目标验证 | Toggle |
| 步骤状态图开关 | 目标验证 | Toggle |
| 熔断器开关 | 目标验证 | Toggle |
| 双循环编排开关 | 目标验证 | Toggle |
| 有界恢复开关 | 目标验证 | Toggle |
| 跨模型审查开关 | 目标验证 | Toggle |
| Reviewer 分级开关 | 目标验证 | Toggle |
| 智能委托策略开关 | 子 Agent | Toggle |
| 委托门控开关 | 子 Agent | Toggle |
| 委托执行器开关 | 子 Agent | Toggle |
| 生命周期管理开关 | 子 Agent | Toggle |
| 质量评分卡开关 | 子 Agent | Toggle |
| 独立会话隔离开关 | 子 Agent | Toggle |
| 上下文打包器开关 | 子 Agent | Toggle |
| 自进化框架开关 | 子 Agent | Toggle |
| Gödel 提案器开关 | 子 Agent | Toggle |
| Self-Harness 循环开关 | 子 Agent | Toggle |

### 6.3 配置字段映射

| UI 控件 | config 字段 | 默认值 |
|---------|------------|--------|
| 路径判定模式 | `goal.executionRouter.mode` | `auto` |
| 单 Agent 最大步数 | `goal.executionRouter.singleAgentMaxSteps` | 2 |
| DAG 最大领域数 | `goal.executionRouter.dagMaxDomains` | 1 |
| 显式指定路径 | `goal.executionRouter.explicitRoute` | - |
| DAG 引擎 | `phase53Integration.dagEngine.enabled` | true |
| 组合路由 | `phase52Integration.compositionalRouting.enabled` | true |
| 策略选择器 | `orchestrationIntegration.strategyEnabled` | true |
| 步骤状态图 | `orchestrationIntegration.stateGraphEnabled` | true |
| 熔断器 | `phase53Integration.circuitBreaker.enabled` | true |
| 双循环编排 | `phase49Integration.dualLoopEnabled` | true |
| 跨模型审查 | `reviewerPolicy.autoCrossModelForHighRisk` | true |
| Reviewer 分级 | `reviewerPolicy.tieredReviewEnabled` | true |
| 有界恢复 | `boundedRecovery.enabled` | true |
| 最大迭代轮数 | `goalVerifier.iterative.maxRounds` | 3 |
| 智能委托策略 | `delegationPolicy.boundedDelegationEnabled` | true |
| 委托门控 | `delegationIntegration.delegationGateEnabled` | true |
| 委托执行器 | `delegationIntegration.delegationEnforcerEnabled` | true |
| 生命周期管理 | `delegationIntegration.lifecycleEnabled` | true |
| 质量评分卡 | `delegationIntegration.scoreCardEnabled` | true |
| 独立会话隔离 | `delegationPolicy.detachedSessionEnabled` | true |
| 上下文打包器 | `delegationIntegration.contextPackerEnabled` | true |
| 自进化框架 | `phase52Integration.selfEvolution.enabled` | true |
| Gödel 提案器 | `phase52Integration.godelProposer.enabled` | true |
| Self-Harness 循环 | `phase52Integration.selfHarness.enabled` | true |

### 6.4 交互细节

- 切换开关时立即保存到 config.yaml（无需点击"保存"按钮）
- 切换失败时显示 toast 错误提示，开关回滚
- 关键模块关闭时显示提示（如关闭 BoundedRecovery 提示"失败将全盘重跑"）
- 数值输入用 stepper 组件，失焦时保存
- 切换到 legacy 模式时显示一次性确认提示

---

## 7. 错误处理与回退策略

### 7.1 错误分级与处理矩阵

| 错误级别 | 触发场景 | 处理策略 | 用户可见 |
|---------|---------|---------|---------|
| P0 致命 | ExecutionRouter 初始化失败 / DagEngine 注入失败 | 自动降级到 legacy 路径 + 日志 | toast 提示"执行引擎异常，已降级到兼容模式" |
| P1 可恢复 | 单个 Worker 执行失败 | BoundedRecovery 局部重跑 | 系统消息"步骤 X 失败，正在局部重跑" |
| P1 可恢复 | DualLoop 验证失败 | 打回到内循环重跑 | 系统消息"验证未通过，第 N 轮重跑" |
| P2 降级 | DualLoop 接线异常 / BoundedRecovery 失败 | 降级到现有迭代闭环逻辑（保留为 fallback） | 系统消息"高级恢复异常，降级到基础重跑" |
| P2 降级 | CompositionalRouter 失败 | 降级到 DAG 路径 | 系统消息"组合路由异常，降级到 DAG 执行" |
| P2 降级 | DAG 引擎失败 | 降级到单 Agent 串行 | 系统消息"DAG 引擎异常，降级到串行执行" |
| P3 非阻塞 | SelfEvolution 提案生成失败 | 跳过本次提案 + 日志 | 无 |
| P3 非阻塞 | GoalAuditor 三层审计中某层失败 | 跳过该层，用其余层结果 | 无 |

### 7.2 路径降级链

> **适用范围**：本降级链适用于 **P1/P2 路径降级**（单次执行内，逐级降级）。**P0 配置回退**见 7.5 节，可跳级直接到 legacy。

```
ExecutionRouter.route() 返回路径
  ↓
执行失败？
  ├─ compose 失败 → 降级到 dag
  │   ├─ dag 失败 → 降级到 single
  │   │   ├─ single 失败 → 降级到 legacy
  │   │   │   ├─ legacy 失败 → 标记 goal failed
  │   │   │   └─ legacy 成功 → done
  │   │   └─ single 成功 → done
  │   └─ dag 成功 → done
  └─ 原路径成功 → done
```

每次降级只降一级，不跳级。降级时记录原因到 trace，供 SelfEvolution 消费。

**CompositionalRouter 失败的降级分支**：
- **Decompose 阶段失败**（无法拆分子任务）：降级到 DAG 路径，使用**原始 plan**，按 domain 分组分别走 DAG（每个 domain 一个子 DAG）
- **Compose 阶段失败**（DAG 组装失败）：使用 Decompose 已产出的子任务列表，按 domain 分组分别走 DAG

### 7.3 BoundedRecovery 局部重跑逻辑

```
步骤失败
  ↓
BoundedRecoveryManager.recover(plan, failedStep):
  ├─ 检查 checkpoint：有则回退，无则从失败步骤开始
  ├─ 计算依赖闭包：failedStep + 其 dependencies 递归，排除已成功步骤
  ├─ 标记闭包内步骤为 pending
  └─ 触发重跑（只执行 pending 步骤）
  ↓
重跑次数检查：
  ├─ < maxRetries(3) → 重跑
  └─ 达到 maxRetries → 标记步骤为永久失败，触发路径降级
```

### 7.4 接线断层修复的验证策略

#### DualLoop 接线验证
- 修复点：`loop.ts` 新增 `setDualLoopOrchestrator` 方法
- 验证：启动时检查 `loop.dualLoopOrchestrator` 是否非空；执行 goal 后检查 trace 是否包含 `dualLoop.run` 事件
- 失败处理：验证失败则降级到 `executionRouter=legacy`，并在设置页显示警告

#### detachedSession 接线验证
- 修复点：`app-init.ts` 补传 `detachedSessionEnabled` 字段
- 验证：spawn_agent 派发时检查 sessionId 是否独立于父会话
- 失败处理：验证失败则 fallback 到非隔离模式（注入父 history），日志告警

### 7.5 配置回退机制

- P0 致命错误 → 自动切回 mode=legacy + toast 提示
- P1/P2 → 不自动切回，保持用户选择，仅本次降级

---

## 8. 缓存命中率验证方案

### 8.1 验证场景

| 场景 | 输入 | 预期路径 | 通过标准 |
|------|------|---------|---------|
| 1 单 Agent 缓存 | "读取 package.json 并报告依赖数量" | single | 步骤 2 命中率 > 50% |
| 2 DAG 跨 Worker | "为 logger.ts 添加单测，运行测试，修复失败用例" | dag | Worker 2/3 固定前缀命中率 > 80% |
| 3 CompositionalRouter | "用户管理分页：前端+后端+数据库" | compose | 分解后子任务命中率 > 80% |
| 4 失败恢复缓存 | 场景 2 人为失败 | dag + recovery | 重跑步骤命中率 > 80% |

### 8.2 验证工具

- CacheStatsTracker 增强：新增 `recordWorkerCacheHit(goalId, workerId, cacheReadTokens, cacheCreationTokens)`
- 验证脚本：`scripts/verify-cache-hit.ts`（开发工具，不打包）
- trace 事件：`worker_cache_stats`（goalId/workerId/route/cacheReadTokens/hitRate）

### 8.3 对比基线

| 场景 | 改造前命中率 | 改造后目标 |
|------|------------|-----------|
| 单 Agent | N/A（恒走多 Agent） | > 50% |
| DAG 3 步 | ~0% | > 80% |
| compose | ~0% | > 80% |
| 失败重跑 | ~0%（全盘重跑） | > 80% |

### 8.4 缓存失效的兜底

即使缓存命中未达预期，不影响功能正确性：缓存只是优化，失效时多付 token，不影响结果。provider 不支持 cache_control 时，systemBlocks 自动降级为普通 system prompt 字符串。

---

## 9. 旧代码删除标准

用户要求"验证后删除旧代码"。删除分两步：

### 9.1 单条删除条件（各 5 个真实任务）

每条旧代码需独立满足以下条件（"真实 goal 任务"= 用户实际执行的 /goal 命令，需在 trace 中留有执行记录）：

| 旧代码 | 删除条件 |
|--------|---------|
| 迭代闭环（goal-runner.ts:909-985） | 1. DualLoop 在 5 个真实 goal 任务中成功处理验证失败；2. BoundedRecovery 局部重跑生效；3. 无降级到迭代闭环的 P2 告警 |
| `executePlanWithMultiAgent` | 1. ExecutionRouter 三条路径在 5 个真实任务中均成功；2. 无降级到 legacy 的 P0 告警；3. 单 Agent 路径缓存命中率达到预期 |
| 旧 `orchestrationEnabled` 判定逻辑 | 同上 |

### 9.2 整体删除门禁

9.1 所有条件满足后，再观察**连续 10 个真实 goal 任务无降级告警**，方可执行删除。即"各 5 个"是单条门禁，"连续 10 个"是整体门禁，两者是 AND 关系。

---

## 10. 设计原则自审

- **最小侵入**：旧路径保留为 fallback；不改 Orchestrator/Blackboard/GoalAuditor 等已稳定的模块；设置页复用现有结构
- **组合性**：ExecutionRouter 纯函数无依赖；WorkerExecutor 只改 prompt 构造方式；DualLoop 修复接线而非重写；三条路径独立
- **版本安全**：遵循现有配置 schema 模式；开关默认 true 但可关闭；executionRouter=legacy 可完全回退；GoalStep 新增字段有兜底值
- **命名**：ExecutionRouter / executePlanWithDag / executePlanWithCompose / uniqueDomains 清晰表达职责
