# /goal 执行流程重设计 实现计划

**目标：** 把 /goal 从"恒走多 Agent"改为"按任务复杂度自动选择三条执行路径"，接入高价值子 Agent 模块，解决"为分步而分步拖慢进度 + 缓存率降低"问题。

**架构：** 新增 ExecutionRouter 路径判定器（single/dag/compose/legacy），扩展 GoalParser 输出 dependencies+domain，WorkerExecutor 改固定前缀缓存；失败恢复用 BoundedRecovery 局部重跑 + DualLoop 双循环（修复两个接线断层）；spawn_agent 接入 DelegationPolicy + 契约机制 + detachedSession；SelfEvolution 消费执行信号产出提案。

**涉及文件：**
- 新增：`src/agent/execution-router.ts`
- 改造：`src/agent/goal-types.ts`、`src/agent/goal-parser.ts`、`src/agent/multi/worker-executor.ts`、`src/cli/goal-runner.ts`、`src/agent/loop.ts`、`src/cli/app-init.ts`、`src/config/schema.ts`、`src/config/defaults.ts`、设置页组件、`src/router/cache-optimizer.ts`
- 新增脚本：`scripts/verify-cache-hit.ts`

**参考设计文档：** `docs/specs/2026-06-28-goal-execution-redesign-design.md`

**构建命令：** `pnpm typecheck` + `pnpm dist:electron`

**分阶段交付：**
- 阶段 1（Task 1-5）：ExecutionRouter + GoalParser 扩展 + WorkerExecutor 缓存改造 + config
- 阶段 2（Task 6-10）：DagEngine + BoundedRecovery + DualLoop 接线修复 + detachedSession 修复
- 阶段 3（Task 11-16）：CompositionalRouter + DelegationPolicy + SelfEvolution + 设置页 UI + 删除旧代码

---

## 阶段 1：基础设施（路径判定 + 缓存改造）

### Task 1: 扩展 GoalStep 类型 + Domain 枚举

**文件：**
- 修改：`src/agent/goal-types.ts:11-41`（GoalStep 接口）

- [ ] **Step 1: 在 goal-types.ts 顶部新增 Domain 枚举类型**

在 `type GoalStepStatus` 之后新增：

```typescript
/** 步骤所属领域（小写枚举，大小写不敏感比较时统一转 lowercase） */
export type Domain = 'frontend' | 'backend' | 'config' | 'docs' | 'database' | 'infra' | 'test' | 'general';
```

- [ ] **Step 2: 在 GoalStep 接口新增 domain 字段**

在 `suggestedRole?` 字段之后（第 40 行后）新增：

```typescript
  /**
   * 步骤所属领域（Phase 55：供 ExecutionRouter 判定路径用）
   * 由 GoalParser 拆分时 LLM 输出，缺失时由 sanitizeSteps 兜底为 'general'
   */
  domain: Domain;
```

- [ ] **Step 3: 在 GoalPlan 接口新增推导字段**

在 `steps: GoalStep[]` 字段之后新增：

```typescript
  /** Phase 55：去重后的领域列表（ExecutionRouter 判定用，由 GoalParser 填充） */
  uniqueDomains?: Domain[];
  /** Phase 55：是否存在依赖关系（ExecutionRouter 判定用，由 GoalParser 填充） */
  hasDependencies?: boolean;
```

- [ ] **Step 4: 类型检查**

运行：`pnpm typecheck`
预期：无新增类型错误（现有代码引用 GoalStep 不受影响，新字段 domain 是必填，但 GoalParser 创建时会填充）

若出现"domain 缺失"错误，先在 GoalParser 的 parseAndBuildPlan 临时填充 `domain: 'general'`，Task 2 会改为 LLM 输出。

- [ ] **Step 5: 提交**

```powershell
rtk git add src/agent/goal-types.ts
rtk git commit -m "feat(goal): 扩展 GoalStep 新增 domain 字段和 Domain 枚举类型"
```

---

### Task 2: GoalParser 扩展输出 dependencies + domain

**文件：**
- 修改：`src/agent/goal-parser.ts:14-35`（PARSER_SYSTEM_PROMPT）、`:170-224`（validatePlan + sanitizeSteps）

- [ ] **Step 1: 修改 PARSER_SYSTEM_PROMPT，要求 LLM 输出 dependencies 和 domain**

在 PARSER_SYSTEM_PROMPT 的"输出严格的 JSON 格式"部分修改为：

```typescript
输出严格的 JSON 格式（不要输出任何其他内容）：
{
  "steps": [
    {
      "id": 1,
      "description": "步骤1",
      "acceptanceCriteria": "具体可验证的验收标准",
      "suggestedRole": "researcher",
      "dependencies": [],
      "domain": "backend"
    },
    {
      "id": 2,
      "description": "步骤2",
      "acceptanceCriteria": "具体可验证的验收标准",
      "suggestedRole": "executor",
      "dependencies": [1],
      "domain": "backend"
    }
  ]
}

字段说明：
- dependencies：本步骤依赖的前置步骤 id 列表（空数组表示无依赖）
- domain：步骤所属领域，必须是以下枚举之一：frontend / backend / config / docs / database / infra / test / general
```

- [ ] **Step 2: 修改 parseAndBuildPlan，解析 LLM 输出的 dependencies 和 domain**

在 parseAndBuildPlan 中解析 JSON 时，映射 dependencies 和 domain 字段。若 LLM 未输出 domain，填充 'general'。

- [ ] **Step 3: 在 validatePlan 增加依赖图无环校验和 domain 非空校验**

在 validatePlan 函数的"验收标准非空"校验之后新增：

```typescript
// Phase 55：依赖图无环校验（拓扑排序检测）
if (hasCycle(steps)) {
  reasons.push('步骤依赖关系存在环，请检查 dependencies 字段');
}

// Phase 55：domain 非空校验
const VALID_DOMAINS = ['frontend', 'backend', 'config', 'docs', 'database', 'infra', 'test', 'general'];
for (const step of steps) {
  if (!step.domain || !VALID_DOMAINS.includes(step.domain)) {
    reasons.push(`步骤 ${step.id} 的 domain 字段无效（${step.domain ?? '空'}），必须是 ${VALID_DOMAINS.join('/')} 之一`);
  }
}
```

新增 hasCycle 辅助函数（Kahn 算法拓扑排序，若排序后节点数 < 总节点数则有环）。

- [ ] **Step 4: 修改 sanitizeSteps，兜底处理有环依赖和缺失 domain**

在 sanitizeSteps 函数的"重排 id 和 dependencies"之后新增：

```typescript
// Phase 55：依赖图有环时断环（移除构成环的边）
const acyclicSteps = breakCycles(truncated);

// Phase 55：domain 缺失时填充 'general'
return acyclicSteps.map(step => ({
  ...step,
  domain: step.domain || 'general',
}));
```

新增 breakCycles 辅助函数（DFS 检测环，移除回边）。

- [ ] **Step 5: 在 parse 末尾填充 GoalPlan 的推导字段**

在 `return plan` 之前新增：

```typescript
plan.uniqueDomains = [...new Set(plan.steps.map(s => s.domain))];
plan.hasDependencies = plan.steps.some(s => s.dependencies.length > 0);
```

- [ ] **Step 6: 修改 sanitizeSteps 中 dependencies 的处理**

当前 sanitizeSteps 会重排 dependencies 为 `[i]`（第 220 行附近）。改为保留原始依赖关系，仅在 id 重排时映射：

```typescript
// 原：dependencies: i > 0 ? [i] : [],
// 改为：基于原始依赖关系映射新 id
const idMap = new Map<number, number>();
truncated.forEach((step, i) => idMap.set(step.id, i + 1));
return truncated.map((step, i) => ({
  ...step,
  id: i + 1,
  dependencies: step.dependencies
    .map(depId => idMap.get(depId))
    .filter((depId): depId is number => depId !== undefined && depId < i + 1),
}));
```

- [ ] **Step 7: 类型检查**

运行：`pnpm typecheck`
预期：无错误

- [ ] **Step 8: 提交**

```powershell
rtk git add src/agent/goal-parser.ts
rtk git commit -m "feat(goal-parser): 扩展输出 dependencies + domain，增加无环校验和兜底"
```

---

### Task 3: 新增 ExecutionRouter 路径判定器

**文件：**
- 创建：`src/agent/execution-router.ts`

- [ ] **Step 1: 创建 execution-router.ts，定义类型和类**

```typescript
// src/agent/execution-router.ts
// Phase 55：/goal 执行路径判定器
// 根据 GoalPlan 的 steps + dependencies + domain 判定走哪条执行路径

import type { GoalPlan } from './goal-types.js';

export type ExecutionRoute = 'single' | 'dag' | 'compose' | 'legacy';

export interface ExecutionRouterOptions {
  /** 判定模式：auto（自动判定）/ legacy（强制旧路径）/ explicit（显式指定） */
  mode: 'auto' | 'legacy' | 'explicit';
  /** mode=explicit 时生效，指定具体路径 */
  explicitRoute?: ExecutionRoute;
  /** 单 Agent 路径的最大步数（默认 2） */
  singleAgentMaxSteps: number;
  /** DAG 路径的最大领域数（超过则升级到 compose，默认 1） */
  dagMaxDomains: number;
}

export class ExecutionRouter {
  route(plan: GoalPlan, options: ExecutionRouterOptions): ExecutionRoute {
    // mode=legacy：直接返回旧路径
    if (options.mode === 'legacy') return 'legacy';

    // mode=explicit：返回用户指定的路径
    if (options.mode === 'explicit' && options.explicitRoute) {
      return options.explicitRoute;
    }

    // mode=auto：按任务复杂度自动判定
    return this.autoRoute(plan, options);
  }

  private autoRoute(plan: GoalPlan, options: ExecutionRouterOptions): ExecutionRoute {
    const { steps, uniqueDomains = [], hasDependencies = false } = plan;

    // 路径 1：单 Agent（1-2 步，无依赖，单领域）
    if (
      steps.length <= options.singleAgentMaxSteps &&
      !hasDependencies &&
      uniqueDomains.length <= options.dagMaxDomains
    ) {
      return 'single';
    }

    // 路径 3：CompositionalRouter（跨领域）
    if (uniqueDomains.length > options.dagMaxDomains) {
      return 'compose';
    }

    // 路径 2：DAG 引擎（3+ 步，有依赖，单领域）
    return 'dag';
  }
}
```

- [ ] **Step 2: 创建单元测试**

创建 `src/agent/execution-router.test.ts`，覆盖 4 个场景：
- 1 步无依赖单领域 → single
- 2 步无依赖单领域 → single
- 5 步有依赖单领域 → dag
- 5 步跨领域（frontend + backend + database）→ compose
- mode=legacy → legacy
- mode=explicit + explicitRoute=single → single

- [ ] **Step 3: 运行测试**

运行：`pnpm test -- execution-router`
预期：全部通过

- [ ] **Step 4: 类型检查**

运行：`pnpm typecheck`
预期：无错误

- [ ] **Step 5: 提交**

```powershell
rtk git add src/agent/execution-router.ts src/agent/execution-router.test.ts
rtk git commit -m "feat(execution-router): 新增路径判定器，按复杂度自动选择 single/dag/compose/legacy"
```

---

### Task 4: config schema + defaults 新增 executionRouter 配置

**文件：**
- 修改：`src/config/schema.ts`、`src/config/defaults.ts`

- [ ] **Step 1: 在 schema.ts 的 goal 配置中新增 executionRouter**

找到 goal schema 定义，新增 executionRouter 子对象：

```typescript
executionRouter: z.object({
  mode: z.enum(['auto', 'legacy', 'explicit']).default('auto'),
  explicitRoute: z.enum(['single', 'dag', 'compose', 'legacy']).optional(),
  singleAgentMaxSteps: z.number().int().min(1).max(5).default(2),
  dagMaxDomains: z.number().int().min(1).max(5).default(1),
}).default({ mode: 'auto', singleAgentMaxSteps: 2, dagMaxDomains: 1 }),
```

- [ ] **Step 2: 在 defaults.ts 的 goal 配置中同步默认值**

```typescript
goal: {
  // ... 现有配置
  executionRouter: {
    mode: 'auto',
    singleAgentMaxSteps: 2,
    dagMaxDomains: 1,
  },
},
```

- [ ] **Step 3: 类型检查**

运行：`pnpm typecheck`
预期：无错误

- [ ] **Step 4: 提交**

```powershell
rtk git add src/config/schema.ts src/config/defaults.ts
rtk git commit -m "feat(config): 新增 goal.executionRouter 配置项"
```

---

### Task 5: WorkerExecutor 固定前缀缓存改造

**文件：**
- 修改：`src/agent/multi/worker-executor.ts:256-264`（enhancedPrompt 构造）、`:321`（workerHistory）

- [ ] **Step 1: 修改 enhancedPrompt 构造，改为 systemBlocks 数组**

找到 enhancedPrompt 构造位置（约第 256-264 行），改为：

```typescript
// Phase 55 改造：固定前缀 + 可变后缀，支持 Anthropic cache_control
// 固定前缀跨 Worker 命中，可变后缀（rolePrompt + blackboardContext）不缓存
const systemBlocks = [
  {
    type: 'text' as const,
    text: baseSystemPrompt,
    cache_control: { type: 'ephemeral' as const },
  },
  {
    type: 'text' as const,
    text: `## 你的角色: ${roleLabel}\n${rolePrompt}\n\n## 当前协作上下文\n${blackboardContext}`,
  },
];
```

- [ ] **Step 2: 修改 agentLoop.run 调用，传入 systemBlocks 替代 systemPrompt**

找到 agentLoop.run 调用，把 `systemPrompt: enhancedPrompt` 改为 `systemBlocks`。若 agentLoop.run 尚未支持 systemBlocks 字段，需先在 ReActAgentLoop.run 的参数类型中新增 systemBlocks?: SystemBlock[]，并在内部优先使用 systemBlocks（未传时回退到 systemPrompt 字符串，向后兼容）。

- [ ] **Step 3: 修改 workerHistory 构造，不再强制清空**

找到 workerHistory 构造位置（约第 321 行），改为：

```typescript
// Phase 55 改造：不再强制清空，按 workerContext 策略取 tail 切片
// 移除"profileManager 注入则强制清空"的逻辑
const workerHistory = (workerContext?.enabled && workerContext.strategy === 'tail')
  ? filteredHistory.slice(-workerContext.maxMessages)
  : [];
```

- [ ] **Step 4: 确保 ReActAgentLoop 支持 systemBlocks**

在 `src/agent/loop.ts` 的 run 方法参数类型中新增：

```typescript
interface RunOptions {
  // ... 现有字段
  /** Phase 55：结构化 system blocks（支持 cache_control），未传时回退到 systemPrompt */
  systemBlocks?: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
}
```

在 run 内部构造 LLM 请求时，优先使用 systemBlocks，未传时回退到 systemPrompt 字符串。

- [ ] **Step 5: 在 LLM 客户端层（anthropic.ts）确认 systemBlocks 透传**

确认 anthropic.ts 的 complete 方法能正确处理 systemBlocks 参数，把 cache_control 透传到 Anthropic API。若当前实现只支持 systemPrompt 字符串，需新增 systemBlocks 支持。

- [ ] **Step 6: 类型检查**

运行：`pnpm typecheck`
预期：无错误

- [ ] **Step 7: 手动验证缓存命中**

启动 RouteDev，执行 `/goal "读取 package.json 并报告依赖数量"`（预期走 single 路径），检查 trace 中 worker_cache_stats 事件的 cacheReadTokens 是否 > 0。

若命中率低，检查 systemBlocks 构造是否正确、固定前缀是否真的固定。

- [ ] **Step 8: 提交**

```powershell
rtk git add src/agent/multi/worker-executor.ts src/agent/loop.ts src/router/llm/anthropic.ts
rtk git commit -m "perf(worker-executor): 固定前缀缓存改造，跨 Worker 命中 systemPrompt 缓存"
```

---

## 阶段 2：核心执行链路（DAG + BoundedRecovery + DualLoop）

### Task 6: goal-runner 接入 ExecutionRouter + 新增 executePlanWithDag

**文件：**
- 修改：`src/cli/goal-runner.ts:699-704`（orchestrationEnabled 判定）、新增 executePlanWithDag 函数

- [ ] **Step 1: 在 createGoalRunner 注入 ExecutionRouter**

在 createGoalRunner 的参数中新增 `executionRouter: ExecutionRouter`，在 app-init.ts 实例化并注入（Task 8 完成）。

- [ ] **Step 2: 替换 orchestrationEnabled 判定为 ExecutionRouter.route 分发**

找到 `executeGoalPlan` 中的 `const orchestrationEnabled = ...`（约第 699-704 行），替换为：

```typescript
// Phase 55：用 ExecutionRouter 替代 orchestrationEnabled 判定
const route = executionRouter.route(plan, {
  mode: config.goal?.executionRouter?.mode ?? 'auto',
  explicitRoute: config.goal?.executionRouter?.explicitRoute,
  singleAgentMaxSteps: config.goal?.executionRouter?.singleAgentMaxSteps ?? 2,
  dagMaxDomains: config.goal?.executionRouter?.dagMaxDomains ?? 1,
});

switch (route) {
  case 'single':
    // 走单 Agent 串行路径（复用现有 for 循环）
    await executePlanWithSingleAgent(plan);
    break;
  case 'dag':
    await executePlanWithDag(plan);
    break;
  case 'compose':
    await executePlanWithCompose(plan);
    break;
  case 'legacy':
    // 旧路径 fallback
    await executePlanWithMultiAgent(plan);
    break;
}
```

把现有 for 循环提取为 `executePlanWithSingleAgent` 函数。

- [ ] **Step 3: 新增 executePlanWithDag 函数**

```typescript
async function executePlanWithDag(plan: GoalPlan): Promise<void> {
  if (!dagEngine) {
    logger.warn('DagEngine 未注入，降级到单 Agent 串行');
    return executePlanWithSingleAgent(plan);
  }
  try {
    await dagEngine.execute(plan, {
      workerExecutor,
      onStepComplete: (step) => {
        blackboard?.addCompletedStep(step);
        emit({ type: 'step_update', goalId: gid, stepId: step.id, status: 'completed' });
      },
      onStepFailed: (step) => {
        emit({ type: 'step_update', goalId: gid, stepId: step.id, status: 'failed', error: step.error });
      },
    });
  } catch (error) {
    logger.warn('DAG 引擎异常，降级到单 Agent 串行', { error: String(error) });
    addSystemMessage('⚠️ DAG 引擎异常，降级到串行执行');
    return executePlanWithSingleAgent(plan);
  }
}
```

- [ ] **Step 4: 新增 executePlanWithCompose 占位函数**

```typescript
async function executePlanWithCompose(plan: GoalPlan): Promise<void> {
  // Phase 55 阶段 3 实现：CompositionalRouter.route(plan) → DagEngine.execute(composedPlan)
  // 当前降级到 DAG
  logger.warn('CompositionalRouter 未实现，降级到 DAG');
  addSystemMessage('⚠️ 组合路由未启用，降级到 DAG 执行');
  return executePlanWithDag(plan);
}
```

- [ ] **Step 5: 保留 executePlanWithMultiAgent 作为 legacy fallback**

不删除现有 executePlanWithMultiAgent 函数，仅在其上方加注释：`// Phase 55：legacy fallback 路径，验证通过后删除（见设计文档第 9 节）`

- [ ] **Step 6: 类型检查**

运行：`pnpm typecheck`
预期：无错误

- [ ] **Step 7: 提交**

```powershell
rtk git add src/cli/goal-runner.ts
rtk git commit -m "feat(goal-runner): 接入 ExecutionRouter，新增 executePlanWithDag/Compose 路径"
```

---

### Task 7: 修复 ReActAgentLoop 的 DualLoop 接线断层

**文件：**
- 修改：`src/agent/loop.ts:82`（ReActAgentLoop 类）

- [ ] **Step 1: 在 ReActAgentLoop 类新增 dualLoopOrchestrator 字段和 setDualLoopOrchestrator 方法**

```typescript
export class ReActAgentLoop {
  // ... 现有字段
  /** Phase 55：DualLoop 编排器（可选，注入后 run() 转交控制权） */
  private dualLoopOrchestrator?: DualLoopOrchestrator;

  /** Phase 55：注入 DualLoop 编排器 */
  setDualLoopOrchestrator(orchestrator: DualLoopOrchestrator | null): void {
    this.dualLoopOrchestrator = orchestrator ?? undefined;
  }

  async *run(options: RunOptions): AsyncGenerator<LoopEvent> {
    // Phase 55：DualLoop 注入时转交控制权
    if (this.dualLoopOrchestrator) {
      yield* this.dualLoopOrchestrator.run(options);
      return;
    }
    // ... 现有 run 逻辑
  }
}
```

- [ ] **Step 2: 修改 app-init.ts 的弱类型断言为强类型调用**

找到 app-init.ts 第 1890-1892 行，改为：

```typescript
// 原：const loop = agentLoop as unknown as { setDualLoopOrchestrator?: (o: unknown) => void };
// 改为：
agentLoop.setDualLoopOrchestrator(orchestrator);
```

删除 `as unknown as` 弱类型断言。

- [ ] **Step 3: 在 DualLoopOrchestrator 新增 run 生成器方法**

确认 DualLoopOrchestrator 是否有 `run(options)` AsyncGenerator 方法。若没有，需新增（签名与 ReActAgentLoop.run 一致，内部调用 innerAgent.execute + outerAgent.verify 循环）。

- [ ] **Step 4: 类型检查**

运行：`pnpm typecheck`
预期：无错误

- [ ] **Step 5: 提交**

```powershell
rtk git add src/agent/loop.ts src/cli/app-init.ts src/agent/dual-loop-orchestrator.ts
rtk git commit -m "fix(loop): 修复 DualLoop 接线断层，新增 setDualLoopOrchestrator 强类型方法"
```

---

### Task 8: app-init.ts 启用高价值模块 + 注入 ExecutionRouter + 修复 detachedSession

**文件：**
- 修改：`src/cli/app-init.ts:706-725`（delegationDeps）、实例化 ExecutionRouter

- [ ] **Step 1: 修复 delegationDeps 漏传 detachedSessionEnabled 字段**

找到 app-init.ts 第 706-725 行的 delegationDeps 构造，新增：

```typescript
const delegationDeps: DelegationIntegrationDeps = {
  // ... 现有字段
  detachedSessionEnabled: delegationPolicyCfg?.detachedSessionEnabled ?? false,  // Phase 55 修复
};
```

确认 DelegationIntegrationDeps 类型定义中已有 detachedSessionEnabled 字段（若没有需先在类型中新增）。

- [ ] **Step 2: 实例化 ExecutionRouter 并注入 goal-runner**

在 app-init.ts 的 createGoalRunner 调用前新增：

```typescript
const executionRouter = new ExecutionRouter();
```

在 createGoalRunner 调用中传入 executionRouter。

- [ ] **Step 3: 在 defaults.ts 把 22 个高价值模块开关默认改为 true**

按照设计文档第 6.3 节配置字段映射表，把以下 22 个开关的默认值从 false 改为 true（在 defaults.ts 和 schema.ts 同步）：

```
orchestrationIntegration.strategyEnabled: true
orchestrationIntegration.stateGraphEnabled: true
delegationIntegration.contextPackerEnabled: true
delegationIntegration.delegationGateEnabled: true
delegationIntegration.delegationEnforcerEnabled: true
delegationIntegration.lifecycleEnabled: true
delegationIntegration.scoreCardEnabled: true
delegationPolicy.boundedDelegationEnabled: true
delegationPolicy.detachedSessionEnabled: true
phase49Integration.dualLoopEnabled: true
phase49Integration.qualityGateEnabled: true
reviewerPolicy.tieredReviewEnabled: true
reviewerPolicy.autoCrossModelForHighRisk: true
boundedRecovery.enabled: true
phase52Integration.boundedRecovery.enabled: true
phase52Integration.compositionalRouting.enabled: true
phase52Integration.selfEvolution.enabled: true
phase52Integration.godelProposer.enabled: true
phase52Integration.selfHarness.enabled: true
phase53Integration.dagEngine.enabled: true
phase53Integration.circuitBreaker.enabled: true
orchestrationIntegration.branchOrchestrationEnabled: true（可选，看是否需要分支实验）
```

- [ ] **Step 4: 同步修改用户 config.yaml**

用 PowerShell 修改 `C:\Users\杨铭\AppData\Roaming\RouteDev\config.yaml`，把上述 22 个开关从 false 改为 true（与 Task 3 阶段的 config schema 默认值对齐）。

- [ ] **Step 5: 类型检查**

运行：`pnpm typecheck`
预期：无错误

- [ ] **Step 6: 启动验证**

运行：`pnpm dev:electron`
预期：RouteDev 正常启动，无报错

- [ ] **Step 7: 提交**

```powershell
rtk git add src/cli/app-init.ts src/config/defaults.ts src/config/schema.ts
rtk git commit -m "feat(app-init): 启用 22 个高价值模块，注入 ExecutionRouter，修复 detachedSession 接线断层"
```

---

### Task 9: goal-runner 替换迭代闭环为 DualLoop + BoundedRecovery

**文件：**
- 修改：`src/cli/goal-runner.ts:909-985`（迭代闭环代码）

- [ ] **Step 1: 保留迭代闭环代码为 fallback，新增 DualLoop 调用**

在迭代闭环代码块（909-985 行）之前新增 DualLoop 调用：

```typescript
// Phase 55：用 DualLoop 替代迭代闭环
// 旧迭代闭环代码保留为 P2 降级 fallback（见设计文档第 7 节）
if (config.phase49Integration?.dualLoopEnabled && dualLoopOrchestrator) {
  try {
    const dualLoopResult = await dualLoopOrchestrator.runPlan(plan, {
      innerExecute: () => executeGoalPlanInternal(plan),
      verify: () => verifyPlan(plan),
      runGate: () => runCompletionGate(plan),
      audit: () => goalAuditor?.audit({...}),
      boundedRecovery,
      maxRounds: config.goalVerifier?.iterative?.maxRounds ?? 3,
    });
    if (dualLoopResult.success) {
      plan.status = 'completed';
    } else {
      plan.status = 'failed';
    }
  } catch (error) {
    logger.warn('DualLoop 异常，降级到基础迭代闭环', { error: String(error) });
    addSystemMessage('⚠️ 高级恢复异常，降级到基础重跑');
    // 走旧迭代闭环 fallback（909-985 行代码）
    await legacyIterativeLoop(plan);
  }
} else {
  // DualLoop 未启用，走旧迭代闭环
  await legacyIterativeLoop(plan);
}
```

把现有 909-985 行代码提取为 `legacyIterativeLoop(plan)` 函数。

- [ ] **Step 2: 确认 DualLoopOrchestrator.runPlan 方法签名**

若 DualLoopOrchestrator 没有 runPlan 方法，需新增（接收 innerExecute/verify/runGate/audit/boundedRecovery/maxRounds 参数，返回 { success: boolean }）。

- [ ] **Step 3: 确认 BoundedRecoveryManager.recover 方法**

确认 BoundedRecoveryManager 的 recover 方法签名，能接收 failedStep 并计算依赖闭包。若接口不匹配，调整调用方式。

- [ ] **Step 4: 类型检查**

运行：`pnpm typecheck`
预期：无错误

- [ ] **Step 5: 手动验证迭代闭环**

启动 RouteDev，执行一个会验证失败的目标（如 `/goal "创建一个不存在的文件"`），观察是否触发 DualLoop 重跑而非旧迭代闭环。

- [ ] **Step 6: 提交**

```powershell
rtk git add src/cli/goal-runner.ts
rtk git commit -m "feat(goal-runner): 用 DualLoop + BoundedRecovery 替代迭代闭环，旧代码保留为 fallback"
```

---

### Task 10: 阶段 2 构建验证 + 打包

- [ ] **Step 1: 完整类型检查**

运行：`pnpm typecheck`
预期：无错误

- [ ] **Step 2: 运行所有测试**

运行：`pnpm test`
预期：全部通过

- [ ] **Step 3: 完整打包**

运行：`pnpm dist:electron`
预期：生成 `release-v7/win-unpacked/RouteDev.exe`（版本号递增）

- [ ] **Step 4: 手动验证 DualLoop + BoundedRecovery 生效**

启动新版 RouteDev，执行 `/goal "为 src/utils/logger.ts 添加单元测试，运行测试，修复失败用例"`：
- 预期走 DAG 路径（3 步，单领域 backend）
- 观察是否触发 DualLoop 验证循环
- 人为让步骤 2 失败，观察是否触发 BoundedRecovery 局部重跑（而非全盘重跑）

- [ ] **Step 5: 验证缓存命中率**

执行场景 2（DAG 3 步），检查 trace 中 worker_cache_stats 事件的 hitRate 是否 > 80%。

- [ ] **Step 6: 提交阶段 2 里程碑**

```powershell
rtk git add .
rtk git commit -m "milestone(phase-55-2): 阶段 2 完成，DAG+BoundedRecovery+DualLoop 接入并验证"
```

---

## 阶段 3：高级功能 + UI + 清理

### Task 11: 实现 executePlanWithCompose（CompositionalRouter 接入）

**文件：**
- 修改：`src/cli/goal-runner.ts`（executePlanWithCompose 函数）

- [ ] **Step 1: 完整实现 executePlanWithCompose**

替换 Task 6 的占位函数：

```typescript
async function executePlanWithCompose(plan: GoalPlan): Promise<void> {
  if (!compositionalRouter || !dagEngine) {
    logger.warn('CompositionalRouter 或 DagEngine 未注入，降级到 DAG');
    addSystemMessage('⚠️ 组合路由未启用，降级到 DAG 执行');
    return executePlanWithDag(plan);
  }
  try {
    addSystemMessage('🧩 组合路由：分解任务 + 检索 Skill...');
    const composedPlan = await compositionalRouter.route(plan);
    addSystemMessage(`📋 组合计划已生成（${composedPlan.steps.length} 个步骤）`);
    await dagEngine.execute(composedPlan, {
      workerExecutor,
      onStepComplete: (step) => blackboard?.addCompletedStep(step),
      onStepFailed: (step) => emit({ type: 'step_update', goalId: gid, stepId: step.id, status: 'failed', error: step.error }),
    });
  } catch (error) {
    logger.warn('CompositionalRouter 异常，降级到 DAG', { error: String(error) });
    addSystemMessage('⚠️ 组合路由异常，降级到 DAG 执行');
    // 按设计文档 7.2 节：Decompose 失败用原始 plan，按 domain 分组走 DAG
    return executePlanWithDag(plan);
  }
}
```

- [ ] **Step 2: 确认 CompositionalRouter.route 方法签名**

确认 CompositionalRouter 的 route 方法能接收 GoalPlan 并返回组合后的 GoalPlan。若接口不匹配，调整适配层。

- [ ] **Step 3: 类型检查 + 提交**

```powershell
pnpm typecheck
rtk git add src/cli/goal-runner.ts
rtk git commit -m "feat(goal-runner): 实现 executePlanWithCompose，接入 CompositionalRouter"
```

---

### Task 12: spawn_agent 接入 DelegationPolicy + 契约机制

**文件：**
- 修改：`src/tools/builtin/spawn-agent.ts`、`src/cli/app-init.ts`

- [ ] **Step 1: 确认 DelegationPolicy 已接入 spawn_agent**

Task 8 已启用 delegationPolicy.boundedDelegationEnabled=true。确认 spawn-agent.ts 的 wrapSpawnAgentWithDelegation 调用能正确执行三态判定（allow/delegate/refuse）。

- [ ] **Step 2: 确认 DelegationContractManager 契约下发**

确认 DelegationEnforcer 能在 delegate 时下发契约（grant/obligation/deliverable），子 Agent 有有限质疑权（最多 3 次）。

- [ ] **Step 3: 确认 detachedSession 创建独立会话**

Task 8 已修复 detachedSessionEnabled 字段。确认 spawn-agent.ts 的 `if (deps.detachedSessionEnabled && deps.profileManager)` 分支能正确调用 createSubAgentSession 创建独立会话。

- [ ] **Step 4: 手动验证**

启动 RouteDev，让主 Agent 通过 spawn_agent 派发子任务：
- 通用任务 → refuse（主 Agent 自己做）
- 专业任务 → delegate（走契约 + detachedSession）
- 简单查询 → allow（直接执行）

- [ ] **Step 5: 提交**

```powershell
rtk git add src/tools/builtin/spawn-agent.ts src/cli/app-init.ts
rtk git commit -m "feat(spawn-agent): 接入 DelegationPolicy 三态门控 + 契约机制 + detachedSession"
```

---

### Task 13: SelfEvolution 接入

**文件：**
- 修改：`src/agent/dual-loop-orchestrator.ts`（消费 SelfEvolution）、`src/cli/app-init.ts`

- [ ] **Step 1: 在 DualLoopOrchestrator.runPlan 末尾收集信号**

```typescript
// DualLoop runPlan 末尾
if (selfEvolutionFramework) {
  try {
    const signals = {
      loopMemory: this.loopMemory.serialize(),
      scoreCards: this.scoreCardCollector?.getAll() ?? [],
      processDefects: this.processDefectOntology?.classify(this.executionTrace) ?? [],
    };
    await selfEvolutionFramework.run(signals);
  } catch (error) {
    logger.warn('SelfEvolution 提案生成失败（非阻塞）', { error: String(error) });
  }
}
```

- [ ] **Step 2: 确认 SelfEvolutionFramework.run 方法**

确认 SelfEvolutionFramework 的 run 方法能接收 signals 并产出提案（不自动应用，存储待用户确认）。

- [ ] **Step 3: 确认 GodelProposer 和 SelfHarnessLoop 已注入**

Task 8 已启用 selfEvolution.enabled + godelProposer.enabled + selfHarness.enabled。确认 app-init.ts 正确实例化并注入。

- [ ] **Step 4: 手动验证**

执行多个 /goal 任务后，检查是否有提案生成（日志或设置页"待确认提案"区块）。

- [ ] **Step 5: 提交**

```powershell
rtk git add src/agent/dual-loop-orchestrator.ts src/cli/app-init.ts
rtk git commit -m "feat(self-evolution): 接入 SelfEvolutionFramework，消费执行信号产出提案"
```

---

### Task 14: 设置页 UI 新增配置项

**文件：**
- 修改：现有设置页组件（按第 6.2 节表格指定的分区）

- [ ] **Step 1: 定位现有设置页"目标验证"和"子 Agent"分区组件**

用 Grep 找到设置页中"目标验证"和"子 Agent"分区对应的组件文件。

- [ ] **Step 2: 在"目标验证"分区新增 12 个配置项**

按第 6.2 节表格，在"目标验证"分区新增：
- 路径判定模式（单选 auto/legacy/explicit）
- 单 Agent 最大步数（Stepper）
- DAG 最大领域数（Stepper）
- DAG 引擎开关（Toggle）
- 组合路由开关（Toggle）
- 策略选择器开关（Toggle）
- 步骤状态图开关（Toggle）
- 熔断器开关（Toggle）
- 双循环编排开关（Toggle）
- 有界恢复开关（Toggle）
- 跨模型审查开关（Toggle）
- Reviewer 分级开关（Toggle）

每个 Toggle/Stepper 切换时调用 `useRouteDevStore.saveConfig()` 保存。

- [ ] **Step 3: 在"子 Agent"分区新增 10 个配置项**

按第 6.2 节表格，在"子 Agent"分区新增：
- 智能委托策略开关
- 委托门控开关
- 委托执行器开关
- 生命周期管理开关
- 质量评分卡开关
- 独立会话隔离开关
- 上下文打包器开关
- 自进化框架开关
- Gödel 提案器开关
- Self-Harness 循环开关

- [ ] **Step 4: 实现交互细节**

- 切换开关时立即保存到 config.yaml
- 切换失败时显示 toast 错误提示，开关回滚
- 关键模块关闭时显示提示（如关闭 BoundedRecovery 提示"失败将全盘重跑"）
- 切换到 legacy 模式时显示一次性确认提示

- [ ] **Step 5: 类型检查 + 启动验证**

```powershell
pnpm typecheck
pnpm dev:electron
```

预期：设置页正常显示新增配置项，切换开关能保存到 config.yaml

- [ ] **Step 6: 提交**

```powershell
rtk git add desktop/renderer/src/components/settings/
rtk git commit -m "feat(settings): 新增目标执行配置项到目标验证和子 Agent 分区"
```

---

### Task 15: 缓存命中率验证脚本 + CacheStatsTracker 增强

**文件：**
- 修改：`src/router/cache-optimizer.ts`（CacheStatsTracker）
- 创建：`scripts/verify-cache-hit.ts`

- [ ] **Step 1: 在 CacheStatsTracker 新增 recordWorkerCacheHit 方法**

```typescript
// src/router/cache-optimizer.ts
export class CacheStatsTracker {
  // ... 现有方法

  /** Phase 55：记录单个 Worker 的缓存命中（按 goalId 聚合） */
  recordWorkerCacheHit(
    goalId: string,
    workerId: string,
    cacheReadTokens: number,
    cacheCreationTokens: number,
    inputTokens: number,
  ): void {
    const hitRate = cacheReadTokens / (cacheReadTokens + cacheCreationTokens + inputTokens);
    this.workerStats.push({ goalId, workerId, cacheReadTokens, cacheCreationTokens, inputTokens, hitRate, timestamp: Date.now() });
  }

  /** Phase 55：按 goalId 聚合缓存命中率 */
  getGoalCacheStats(goalId: string): { workerCount: number; avgHitRate: number; hitRatePerWorker: Array<{ workerId: string; hitRate: number }> } {
    // 实现聚合逻辑
  }
}
```

- [ ] **Step 2: 在 WorkerExecutor.execute 完成后调用 recordWorkerCacheHit**

在 WorkerExecutor.execute 的 done 事件处理中，从 LLM 响应的 usage 字段提取 cacheReadTokens/cacheCreationTokens/inputTokens，调用 recordWorkerCacheHit。

- [ ] **Step 3: 新增 worker_cache_stats trace 事件**

在 WorkerExecutor 发出 trace 事件：

```typescript
emit({
  type: 'worker_cache_stats',
  goalId: gid,
  workerId: `step-${step.id}-${role}`,
  route: currentRoute,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheCreationTokens: usage.cacheCreationTokens ?? 0,
  inputTokens: usage.inputTokens ?? 0,
  hitRate: calculatedHitRate,
});
```

- [ ] **Step 4: 创建 verify-cache-hit.ts 验证脚本**

```typescript
// scripts/verify-cache-hit.ts
// Phase 55：缓存命中率验证脚本（开发工具，不打包）
// 用法：npx tsx scripts/verify-cache-hit.ts "goal 描述"

import { CacheStatsTracker } from '../src/router/cache-optimizer.js';

// 读取最近的 goal 执行 trace，统计缓存命中率
// 输出：每个 Worker 的缓存命中数据 + 命中率
```

- [ ] **Step 5: 执行 4 个验证场景**

按设计文档第 8.1 节，执行 4 个验证场景：
- 场景 1：单 Agent 缓存（目标命中率 > 50%）
- 场景 2：DAG 跨 Worker（目标 > 80%）
- 场景 3：CompositionalRouter（目标 > 80%）
- 场景 4：失败恢复缓存保持（目标 > 80%）

- [ ] **Step 6: 提交**

```powershell
rtk git add src/router/cache-optimizer.ts src/agent/multi/worker-executor.ts scripts/verify-cache-hit.ts
rtk git commit -m "feat(cache): 增强 CacheStatsTracker，新增验证脚本和 trace 事件"
```

---

### Task 16: 验证旧代码删除 + 最终打包

- [ ] **Step 1: 执行 5 个真实 goal 任务验证 DualLoop**

按设计文档第 9.1 节，执行 5 个会触发验证失败的 goal 任务，确认：
- DualLoop 成功处理验证失败
- BoundedRecovery 局部重跑生效
- 无降级到迭代闭环的 P2 告警

- [ ] **Step 2: 执行 5 个真实 goal 任务验证 ExecutionRouter 三条路径**

执行 5 个分别覆盖 single/dag/compose 路径的 goal 任务，确认：
- 三条路径均成功
- 无降级到 legacy 的 P0 告警
- 单 Agent 路径缓存命中率达到预期

- [ ] **Step 3: 观察 10 个连续任务无降级告警**

按设计文档第 9.2 节，观察连续 10 个真实 goal 任务无降级告警。

- [ ] **Step 4: 删除旧代码**

若 Step 1-3 全部通过，删除：
- `legacyIterativeLoop` 函数（原 goal-runner.ts:909-985）
- `executePlanWithMultiAgent` 函数
- 旧 `orchestrationEnabled` 判定逻辑

- [ ] **Step 5: 完整类型检查 + 测试**

```powershell
pnpm typecheck
pnpm test
```
预期：全部通过

- [ ] **Step 6: 最终打包**

```powershell
pnpm dist:electron
```
预期：生成最终版 RouteDev.exe

- [ ] **Step 7: 提交删除旧代码**

```powershell
rtk git add .
rtk git commit -m "refactor(goal-runner): 删除旧迭代闭环和 executePlanWithMultiAgent（验证通过）"
```

- [ ] **Step 8: 阶段 3 里程碑提交**

```powershell
rtk git commit --allow-empty -m "milestone(phase-55-3): /goal 执行流程重设计全部完成"
```

---

## 自审

### 1. 规格覆盖

对照设计文档 10 个决策：

| 决策 | 对应 Task |
|------|----------|
| 1 路径判定方式 | Task 3（ExecutionRouter） |
| 2 判定输入信号 | Task 2（GoalParser 扩展） |
| 3 DAG 与 CompositionalRouter 分工 | Task 6（executePlanWithDag）+ Task 11（executePlanWithCompose） |
| 4 缓存命中方案 | Task 5（WorkerExecutor 改造）+ Task 15（验证脚本） |
| 5 失败恢复策略 | Task 7（DualLoop 接线）+ Task 9（迭代闭环替换） |
| 6 detachedSession 定位 | Task 8（接线修复）+ Task 12（spawn_agent 接入） |
| 7 DelegationPolicy + 契约 | Task 12 |
| 8 SelfEvolution | Task 13 |
| 9 迭代闭环替换 | Task 9 |
| 10 交付方式 + 设置页 | Task 14（设置页）+ Task 16（验证后删旧代码） |

全部覆盖，无遗漏。

### 2. 占位符扫描

- Task 6 Step 4 的 executePlanWithCompose 是占位函数，但在 Task 11 完整实现——这是分阶段交付的正常做法，不算占位符。
- Task 9 Step 2 的"确认 DualLoopOrchestrator.runPlan 方法签名"——若方法不存在需新增，这是明确的实现指令，不是占位符。
- 无其他 TBD/TODO。

### 3. 一致性

- ExecutionRouter 类型定义（Task 3）与 goal-runner 调用（Task 6）的 ExecutionRouterOptions 字段一致：mode/explicitRoute/singleAgentMaxSteps/dagMaxDomains。
- GoalStep.domain 类型（Task 1）与 GoalParser 输出（Task 2）一致：Domain 枚举。
- WorkerExecutor systemBlocks（Task 5）与 ReActAgentLoop.run 参数（Task 5 Step 4）一致。
- 22 个开关列表（Task 8）与设计文档第 6.3 节一致。

### 4. 边界条件

- **构建失败回退**：每个 Task 末尾都有 `pnpm typecheck` 验证 + 独立 commit，失败时 `git revert HEAD` 即可回退。
- **步骤依赖断裂**：Task 6 依赖 Task 3（ExecutionRouter）和 Task 4（config）；Task 9 依赖 Task 7（DualLoop 接线）；Task 11 依赖 Task 6。计划中已按依赖顺序排列。
- **DAG 引擎失败**：Task 6 Step 3 的 executePlanWithDag 有 try/catch 降级到单 Agent。
- **DualLoop 接线失败**：Task 9 Step 1 有 try/catch 降级到 legacyIterativeLoop。
- **CompositionalRouter 失败**：Task 11 Step 1 有 try/catch 降级到 executePlanWithDag。
- **缓存命中未达预期**：Task 15 验证脚本会检测，但不影响功能正确性（设计文档第 8.4 节）。

### 5. 任务粒度

- 16 个 Task，每阶段 4-6 个，符合"单批 3-6 项"最优区间。
- 每个 Task 内部 4-8 个 Step，每步 2-5 分钟可完成。
- 风格相近的任务放同一 Task（如 Task 8 的 22 个开关修改）。
