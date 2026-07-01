# Phase 51 — 外部开源借鉴落地与配置化接入收尾

> **版本目标：** v4.0.0
> **前置依赖：** Phase 50（死代码接入收尾与模块集成）完成
> **新增测试要求：** ≥ 60 个
> **研究依据：** 精读两个开源项目的完整源码（通过 git clone 本地读取，非 README 泛览）：
> 1. **Flue**（`github.com/withastro/flue`，Astro 团队）— TypeScript Agent Harness 框架，"像 Claude Code 但只有 TypeScript"。三层抽象 Instance → Harness → Session；call-scoped overlay 已重构为 subagent + detached child session 模型；审查反馈机制（三条证据 + input not requirements）；双受众错误模型；Durable Execution；Context Compaction；Out-of-band fs；CallHandle；Skill 懒加载；分层事件系统。
> 2. **ohmypi**（`github.com/ajjucoder/ohmypi`）— pi-coding-agent 的 TypeScript 扩展层。No Generic Backend Worker + Hard Delegation Policy（三态 allow/delegate/refuse）；Bounded Delegation 四维约束（maxDepth/maxParallel/delegationTargets/subprocessTools）；Second-Pass Escalation（直接做→单路升级→多路并行）；TUI Activity Widget（事件推送+三态机）；Reviewer 分级（三档但无配置化，工程化弱点）；三层配置合并；软提示+硬拦截双层防线；关键词双命中规则。
> **核心约束（反写死原则）：** 之前的 Phase 经常"写死代码，不接入配置，不进设置页面"。Phase 51 的每个 Task 必须包含三要素：① 配置接入（Zod schema 字段 + 默认值 + 校验范围）② 设置页面接入（TabId + 控件类型）③ 代码接线点（文件级操作表格）。杜绝"写了但不接入"的孤立代码。

---

## 项目现状审计与可行性结论

### 1. 借鉴点与 RouteDev 缺口的映射

| # | 借鉴来源 | 核心机制 | RouteDev 现状缺口 | Phase 51 Task |
|---|----------|----------|-------------------|---------------|
| 1 | ohmypi Reviewer 分级 + Flue 审查反馈 | 三档分级 + 三条证据协议 | 双循环仅 critical 过滤，无分级；审查反馈无结构化要求 | Task 1 |
| 2 | ohmypi Bounded Delegation | 四维约束（depth/parallel/targets/tools） | 委托只有 1 层硬限制（物理移除 spawn_agent），无四维约束 | Task 2 |
| 3 | ohmypi No Generic Worker + Hard Policy | 三态策略（allow/delegate/refuse） | 委托决策无策略，全靠 LLM 自行判断 | Task 3 |
| 4 | Flue call-scoped overlay | subagent + detached child session | 子 Agent 共享父上下文，无隔离的 child session | Task 4 |
| 5 | ohmypi TUI Activity Widget | 事件推送 + 三态机 + 模型/thinking 标签 | TaskMonitorPanel 只显示消息流，无 specialist 活动追踪 | Task 5 |
| 6 | Flue 三层抽象 | Instance → Harness → Session | RouteDev 只有 Session 层，无 Instance/Harness 分层 | Task 6 |
| 7 | ohmypi Reviewer 分级（弱点改进） | 三档配置化 + 跨模型自动触发 | ohmypi 自己没配置化，RouteDev 要做对 | Task 7 |
| 8 | ohmypi 三层配置合并 | global + project + default | RouteDev 配置只有单层，无项目级覆盖 | Task 8 |
| 9 | Flue 双受众错误模型 | message + details + dev | RouteDevError 只有 message + code，无受众分层 | Task 9 |
| 10 | Flue Result Schemas | valibot 结构化返回 + finish/give_up 协议 | 子 Agent 返回纯文本，无结构化 schema | Task 10 |
| 11 | ohmypi splitModelLabel | 模型名与 thinking 等级分离显示 | UI 把 `gpt-5.4:high` 当整体显示 | Task 11 |
| 12 | — | 集成测试与文档同步 | — | Task 12 |

### 2. 可行性总评

- **Task 1（双循环仲裁增强）：** 高度可行。DualLoopOrchestrator 已有 evaluateOuterLoop 方法，扩展分级字段即可。
- **Task 2（委托四维约束）：** 可行。createChildRegistry 当前是物理移除 spawn_agent 的硬限制，改为深度计数 + 四维校验。
- **Task 3（智能委托策略）：** 可行。借鉴 ohmypi 的三态策略，但 RouteDev 已有 AgentProfile 体系，扩展 policy 字段。
- **Task 4（call-scoped overlay）：** 中等可行。需要改造 spawn-agent，为子 Agent 创建独立 session 上下文。
- **Task 5（Agent 活动面板）：** 高度可行。TaskMonitorPanel（280px 右栏）是现成位置，扩展活动追踪即可。
- **Task 6（三层抽象）：** 中等可行。RouteDev 当前只有 Session 层，引入 Instance/Harness 需要重构存储键。建议保守落地——先引入概念层抽象，存储键三元组后续 Phase 再迁移。
- **Task 7（Reviewer 分级配置化）：** 高度可行。在 GoalConfigSchema 或新 schema 中扩展 reviewerPolicy 字段。
- **Task 8（项目级配置）：** 可行。在 config loader 中增加项目级 `.routedev/config.json` 读取 + deepMerge。
- **Task 9（Structured Errors）：** 高度可行。RouteDevError 基类已存在，扩展 details/dev 字段。
- **Task 10（Result Schemas）：** 可行。spawn-agent 的返回值扩展为结构化 schema。
- **Task 11（Model vs Thinking）：** 高度可行。UI 层面的显示优化，工具函数级改动。

### 3. RouteDev 源码接线点速查（已实际核查）

| 接线点 | 文件 | 关键行号 | 备注 |
|--------|------|----------|------|
| 根 schema | `src/config/schema.ts` | 1291-1374 | 新字段加在此处 |
| Agent 全局并行 | `src/config/schema.ts` | 666 | `maxConcurrentSubAgents` 默认 5 |
| 委托接入开关 | `src/config/schema.ts` | 1237-1244 | 无 `delegationPolicy`，需新建 |
| SubAgents 配置 | `src/config/schema.ts` | 946-957 | 有 gateRules.reviewerMaxParallel |
| Goal 审计模式 | `src/config/schema.ts` | 972 | 含 reviewer_first 选项 |
| Tab 注册 | `desktop/renderer/src/pages/SettingsPage.tsx` | 51-59 | 26 个 tab |
| Tab 组件目录 | `desktop/renderer/src/components/settings/` | — | 已抽离 7 个，剩余 19 个内联 |
| Orchestrator 类 | `src/agent/multi/orchestrator.ts` | 239-559 | plan/buildParallelGroups/ConflictDetector |
| 三层并行限制 | schema.ts:666 / spawn-agent.ts:159 / orchestrator-strategy.ts:26 | 5/3/3 | 默认值不一致 |
| Worker 角色 | `src/agent/multi/orchestrator.ts` | 230-237 | coder/searcher/tester/reviewer |
| 双循环编排器 | `src/agent/dual-loop-orchestrator.ts` | 53-370 | DEFAULT_MAX_RERUNS=2 (line 39) |
| reviewer 过滤 | `src/agent/dual-loop-orchestrator.ts` | 252-260 | 仅 critical 过滤 |
| 错误基类 | `src/utils/errors.ts` | 14-96 | 5 子类 + isRouteDevError |
| 子 Agent 委托 | `src/tools/builtin/spawn-agent.ts` | 111-149 | 1 层硬限制 |
| 三栏布局 | `desktop/renderer/src/components/Layout.tsx` | 109-205 | TaskMonitorPanel 280px |
| AgentProfile | `src/agents/profiles/types.ts` | 44-83 | role: researcher/executor/reviewer/custom |

**两个已知不一致点**（Phase 51 统一）：
1. `WorkerRole`（coder/searcher/tester/reviewer）vs `AgentRole`（researcher/executor/reviewer/custom）命名不统一。
2. 三层并行数默认值 5/3/3 不一致，且 L2/L3 未从 config 读取（硬编码默认值）。

---

## 核心设计原则

### 原则 1：反写死（最高约束）

所有新增能力必须有：配置开关（Zod schema 字段）、设置页面入口（TabId + 控件）、明确代码接线点（文件:行号）。**孤立代码 = 未完成代码**。

### 原则 2：配置驱动优先于硬编码

ohmypi 的工程化弱点是 Reviewer 分级全靠系统提示的自然语言，无配置字段。RouteDev 必须避免——所有策略阈值、分级标准、开关都走 Zod schema，进设置页面。

### 原则 3：软提示 + 硬拦截双层防线

ohmypi 的前端策略用"系统提示软约束 + tool_call 事件硬拦截"双层防线。RouteDev 的委托策略、安全策略都应采用此模式——不能只靠系统提示，必须在工具调用层有硬校验。

### 原则 4：结构化优先于纯文本

Flue 的审查反馈用 valibot schema 结构化返回（`{ summary, risks[] }`），子 Agent 返回值也走 finish/give_up 工具协议。RouteDev 的子 Agent 交互应从纯文本升级为结构化 schema。

### 原则 5：隔离优先于共享

Flue 的 call-scoped overlay 已重构为"独立子 session"——角色指令不注入父 history，避免污染。RouteDev 的子 Agent 应有独立上下文作用域，而非共享父上下文。

---

## Task 1：双循环仲裁增强——Reviewer 分级与审查反馈协议（≥ 6 测试）

### 1.1 借鉴来源

**ohmypi Reviewer 分级**（`src/prompts.ts` `buildOrchestratorInstructions()` L33-34）：
- 三档分级：tiny（跳过外循环）/ medium（一轮 reviewer）/ big+high-risk（1-2 轮 mid-work + 1 轮 final）
- 工程化弱点：分级阈值全靠自然语言，无配置字段，无自动跨模型

**Flue 审查反馈协议**（`AGENTS.md` 根目录）：
- 审查者必须提供三条证据：① 具体的正确性/耐久性风险 ② 清晰的失败场景或被违反的不变量 ③ 相关 `file:line` 证据
- "review feedback is input, not requirements"——反馈是参考输入，主 Agent 自己决定是否采纳
- 禁止仅为满足重复审查而改动

### 1.2 RouteDev 缺口

- `DualLoopOrchestrator.evaluateOuterLoop()`（dual-loop-orchestrator.ts:226）仅按 `severity === 'critical'` 过滤，无分级机制
- 审查反馈无结构化要求——reviewer 可以返回笼统的"建议改进"，无 file:line 证据
- 无"mid-work 审查"概念——只有 final 审查
- `DEFAULT_MAX_RERUNS = 2`（line 39）是固定值，不随任务规模调整

### 1.3 落地设计

```typescript
// src/config/schema.ts 扩展（在 GoalConfigSchema 附近，约 line 972 之后）

/**
 * Reviewer 分级策略
 * 借鉴 ohmypi 的三档分级，但配置化（ohmypi 的弱点是无配置）
 */
export const ReviewerPolicySchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 Reviewer 分级（false 时退回 critical 过滤的旧行为） */
  tieredReviewEnabled: z.boolean().default(false),
  /** 任务规模阈值——小于此值走 tiny 策略（跳过外循环） */
  tinyTaskStepThreshold: z.number().int().min(1).max(20).default(5),
  /** 大任务阈值——超过此值走 big 策略（两轮审查） */
  bigTaskStepThreshold: z.number().int().min(10).max(100).default(30),
  /** mid-work 审查触发——执行到此比例时插入一次审查（0.5 = 50%） */
  midWorkReviewRatio: z.number().min(0.3).max(0.8).default(0.5),
  /** high-risk 任务是否自动跨模型审查（需配置 crossModelReviewerId） */
  autoCrossModelForHighRisk: z.boolean().default(false),
  /** 跨模型审查使用的模型 ID（autoCrossModelForHighRisk=true 时必填） */
  crossModelReviewerId: z.string().default(''),
  /** 审查反馈是否强制三条证据（false 时允许笼统反馈） */
  enforceEvidenceProtocol: z.boolean().default(false),
}));
```

```typescript
// src/agent/dual-loop-orchestrator.ts 扩展

/**
 * 审查反馈结构化 schema
 * 借鉴 Flue 的"三条证据"协议
 */
export interface StructuredReviewFeedback {
  summary: string;                    // 审查总结
  risks: Array<{
    description: string;              // 具体的正确性/耐久性风险
    failureScenario: string;          // 清晰的失败场景
    violatedInvariant: string;        // 被违反的不变量
    evidence: Array<{                 // file:line 证据
      file: string;
      line: number;
      excerpt?: string;
    }>;
    severity: 'blocking' | 'warning' | 'info';
    suggestedFix?: string;            // 建议修复（非强制，主 Agent 可不采纳）
  }>;
  overallVerdict: 'pass' | 'conditional' | 'fail';
}

/**
 * Reviewer 分级判定
 * 借鉴 ohmypi 的三档，但基于可配置的 step 阈值
 */
export type ReviewerTier = 'tiny' | 'medium' | 'big' | 'high-risk';

export function determineReviewerTier(
  taskSteps: number,
  isHighRisk: boolean,
  policy: { tinyTaskStepThreshold: number; bigTaskStepThreshold: number },
): ReviewerTier {
  if (isHighRisk) return 'high-risk';
  if (taskSteps < policy.tinyTaskStepThreshold) return 'tiny';
  if (taskSteps > policy.bigTaskStepThreshold) return 'big';
  return 'medium';
}

/**
 * 根据分级决定审查轮次
 */
export function getReviewPassesForTier(tier: ReviewerTier): {
  midWork: number;     // mid-work 审查轮次
  final: number;       // final 审查轮次
  crossModel: boolean; // 是否跨模型
} {
  switch (tier) {
    case 'tiny': return { midWork: 0, final: 0, crossModel: false };
    case 'medium': return { midWork: 0, final: 1, crossModel: false };
    case 'big': return { midWork: 1, final: 1, crossModel: false };
    case 'high-risk': return { midWork: 1, final: 1, crossModel: true };
  }
}
```

### 1.4 配置接入

| 字段 | schema 位置 | 类型 | 默认值 | 校验 |
|------|-------------|------|--------|------|
| `reviewerPolicy.tieredReviewEnabled` | schema.ts 新增 ReviewerPolicySchema | boolean | false | — |
| `reviewerPolicy.tinyTaskStepThreshold` | 同上 | number | 5 | 1-20 |
| `reviewerPolicy.bigTaskStepThreshold` | 同上 | number | 30 | 10-100 |
| `reviewerPolicy.midWorkReviewRatio` | 同上 | number | 0.5 | 0.3-0.8 |
| `reviewerPolicy.autoCrossModelForHighRisk` | 同上 | boolean | false | — |
| `reviewerPolicy.crossModelReviewerId` | 同上 | string | '' | 非空（当 autoCrossModel=true） |
| `reviewerPolicy.enforceEvidenceProtocol` | 同上 | boolean | false | — |

**根 schema 接入点**：在 `AppConfigSchema`（schema.ts:1291）中新增 `reviewerPolicy: ReviewerPolicySchema`。

### 1.5 设置页面接入

- **TabId**：扩展 `'goal'` tab（已存在，line 59），或新建 `'reviewer'` tab
- **控件**：
  - `tieredReviewEnabled`：Toggle 开关
  - `tinyTaskStepThreshold` / `bigTaskStepThreshold`：NumberInput 滑块
  - `midWorkReviewRatio`：Slider 0.3-0.8
  - `autoCrossModelForHighRisk`：Toggle 开关
  - `crossModelReviewerId`：ModelSelect 下拉（当 autoCrossModel=true 时启用）
  - `enforceEvidenceProtocol`：Toggle 开关
- **组件**：新建 `desktop/renderer/src/components/settings/SettingsReviewerTab.tsx`

### 1.6 代码接线点

| 操作 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 新增 ReviewerPolicySchema | `src/config/schema.ts` | 972 之后 | 在 GoalConfigSchema 附近 |
| 接入根 schema | `src/config/schema.ts` | 1291-1374 | AppConfigSchema 新增字段 |
| 新增 StructuredReviewFeedback | `src/agent/dual-loop-orchestrator.ts` | 39 之后 | 类型定义 |
| 新增 determineReviewerTier | `src/agent/dual-loop-orchestrator.ts` | 226 之前 | 分级判定函数 |
| 改造 evaluateOuterLoop | `src/agent/dual-loop-orchestrator.ts` | 226-270 | 根据分级决定审查轮次 |
| 新增 mid-work 审查钩子 | `src/agent/dual-loop-orchestrator.ts` | run 方法内 | 按 midWorkReviewRatio 插入 |
| 新建设置页组件 | `desktop/renderer/src/components/settings/SettingsReviewerTab.tsx` | — | 新文件 |
| 接入 SettingsPage | `desktop/renderer/src/pages/SettingsPage.tsx` | 51-59 | TabId 新增 'reviewer' |

### 1.7 测试要求

- `determineReviewerTier` 四档判定（tiny/medium/big/high-risk）
- `getReviewPassesForTier` 轮次映射
- `enforceEvidenceProtocol=true` 时缺证据的反馈被拒绝
- mid-work 审查在 midWorkReviewRatio 时机触发
- `tieredReviewEnabled=false` 时退回旧行为（critical 过滤）
- 跨模型审查在 autoCrossModel=true 时触发

---

## Task 2：委托四维约束——maxDepth/maxParallel/delegationTargets/subprocessTools（≥ 7 测试）

### 2.1 借鉴来源

**ohmypi Bounded Delegation**（`src/delegation.ts` `canDelegate()` + `src/types.ts`）：

| 维度 | 含义 | ohmypi 默认值 | 校验位置 |
|------|------|---------------|----------|
| maxDepth | 委派链最大深度 | 2 | `canDelegate()` |
| maxParallel | 单次并行委派上限 | 4 | `prepareParallelDelegationTasks()` |
| delegationTargets | 每个 specialist 可向哪些目标委派 | scout/frontend=`[]`、planner/reviewer=`['scout']` | `canDelegate()` |
| subprocessTools | 子进程允许注入的自定义工具白名单 | scout=`['web_search']`、frontend=`[]` | `getSubprocessCustomTools()` |

**关键实现细节**：
- 深度通过**环境变量**在子进程间传递（`OHMYPI_DELEGATION_DEPTH`），不靠引用计数——子进程崩溃不污染父状态
- `maxParallel` 超限直接 throw（硬上限，非软建议）
- `delegationTargets` 阻止非法跨域委派
- `subprocessTools` 控制子进程能力

### 2.2 RouteDev 缺口

- `createChildRegistry`（spawn-agent.ts:111-149）用物理移除 `spawn_agent` 实现 1 层硬限制——无法支持多层受控委托
- `AgentConfigSchema.maxConcurrentSubAgents`（schema.ts:666，默认 5）只有全局并行数，无深度/目标/工具白名单
- `OrchestratorConfig.maxParallelism`（orchestrator-strategy.ts:26，默认 3）与全局并行数不一致（5 vs 3）
- 无 `delegationTargets` 概念——任何子 Agent 理论上可以派任何类型的孙 Agent
- 无 `subprocessTools` 白名单——子 Agent 的工具集由 AgentProfile.allowedTools 控制，但无"子进程可注入的自定义工具"概念

### 2.3 落地设计

```typescript
// src/config/schema.ts 扩展（在 SubAgentsConfigSchema 附近，约 line 946）

/**
 * 委托四维约束
 * 借鉴 ohmypi 的 Bounded Delegation，但全部配置化
 */
export const DelegationPolicySchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用四维约束（false 时退回物理移除的旧硬限制） */
  boundedDelegationEnabled: z.boolean().default(false),
  /** 委派链最大深度（0=禁用委托，1=单层，2=允许孙 Agent） */
  maxDepth: z.number().int().min(0).max(5).default(1),
  /** 单次并行委派上限 */
  maxParallel: z.number().int().min(1).max(10).default(4),
  /** 每个 role 允许向哪些 role 继续委派（空数组=不可委派） */
  delegationTargets: z.record(
    z.enum(['researcher', 'executor', 'reviewer', 'custom']),
    z.array(z.enum(['researcher', 'executor', 'reviewer', 'custom'])),
  ).default({
    researcher: [],           // 调研者不再委派（叶子节点）
    executor: ['researcher', 'reviewer'],  // 执行者可委派调研和审查
    reviewer: [],             // 审查者不再委派
    custom: [],               // 自定义默认不可委派
  }),
  /** 子 Agent 允许注入的自定义工具白名单（独立于 AgentProfile.allowedTools） */
  subprocessTools: z.record(
    z.enum(['researcher', 'executor', 'reviewer', 'custom']),
    z.array(z.string()),
  ).default({
    researcher: ['web_search', 'read', 'grep', 'glob'],
    executor: [],
    reviewer: ['read', 'grep', 'glob'],
    custom: [],
  }),
  /** 深度传递方式：'env'（环境变量，子进程崩溃不污染父）或 'counter'（引用计数） */
  depthPassingMode: z.enum(['env', 'counter']).default('counter'),
}));
```

```typescript
// src/tools/builtin/spawn-agent.ts 改造

/**
 * 委托权限判定（纯函数，借鉴 ohmypi canDelegate）
 */
export interface DelegationPermission {
  ok: boolean;
  reason?: string;
  nextDepth?: number;
}

export function canDelegate(
  currentDepth: number,
  currentRole: AgentRole,
  targetRole: AgentRole,
  policy: {
    maxDepth: number;
    delegationTargets: Record<AgentRole, AgentRole[]>;
  },
): DelegationPermission {
  // 深度检查
  const nextDepth = currentDepth + 1;
  if (nextDepth > policy.maxDepth) {
    return {
      ok: false,
      reason: `已达到最大委托深度 ${policy.maxDepth}（当前 ${currentDepth}）`,
    };
  }
  // 目标合法性检查
  const allowedTargets = policy.delegationTargets[currentRole] ?? [];
  if (!allowedTargets.includes(targetRole)) {
    return {
      ok: false,
      reason: `角色 ${currentRole} 不允许委派给 ${targetRole}（允许：${allowedTargets.join(', ') || '无'}）`,
    };
  }
  return { ok: true, nextDepth };
}

/**
 * 改造 createChildRegistry：从物理移除改为深度计数 + 条件注册
 */
export function createChildRegistry(
  parentRegistry: ToolRegistry,
  subagentType: SubagentType,
  profileManager?: AgentProfileManager,
  delegationContext?: {
    currentDepth: number;
    policy: DelegationPolicyConfig;
    targetRole: AgentRole;
  },
): ToolRegistry {
  const child = parentRegistry.clone();

  // 旧模式：无 delegationContext 时退回物理移除（向后兼容）
  if (!delegationContext) {
    child.unregister('spawn_agent');
    return child;
  }

  // 新模式：根据四维约束决定是否保留 spawn_agent
  const permission = canDelegate(
    delegationContext.currentDepth,
    delegationContext.targetRole,
    delegationContext.targetRole, // 简化：目标角色由调用方决定
    delegationContext.policy,
  );

  if (!permission.ok || permission.nextDepth! >= delegationContext.policy.maxDepth) {
    // 深度用尽，移除 spawn_agent
    child.unregister('spawn_agent');
  }
  // 否则保留 spawn_agent，但子 Agent 调用时会再次校验 canDelegate

  return child;
}
```

### 2.4 配置接入

| 字段 | schema 位置 | 类型 | 默认值 | 校验 |
|------|-------------|------|--------|------|
| `delegationPolicy.boundedDelegationEnabled` | schema.ts 新增 | boolean | false | — |
| `delegationPolicy.maxDepth` | 同上 | number | 1 | 0-5 |
| `delegationPolicy.maxParallel` | 同上 | number | 4 | 1-10 |
| `delegationPolicy.delegationTargets` | 同上 | Record | 见代码 | role 枚举 |
| `delegationPolicy.subprocessTools` | 同上 | Record | 见代码 | string[] |
| `delegationPolicy.depthPassingMode` | 同上 | enum | 'counter' | 'env'\|'counter' |

**根 schema 接入点**：在 `AppConfigSchema`（schema.ts:1291）中新增 `delegationPolicy: DelegationPolicySchema`。

### 2.5 设置页面接入

- **TabId**：扩展已存在的 `'subagents'` tab（line 56）
- **控件**：
  - `boundedDelegationEnabled`：Toggle 开关
  - `maxDepth`：NumberInput（0-5）+ 说明文字"0=禁用委托，1=单层，2=允许孙 Agent"
  - `maxParallel`：NumberInput（1-10）
  - `delegationTargets`：4×4 矩阵 Checkbox（role × target）
  - `subprocessTools`：每个 role 一个 MultiSelect 工具选择器
  - `depthPassingMode`：RadioGroup（env/counter）+ 说明
- **组件**：扩展 `SettingsSubAgentsTab`（如已存在）或新建

### 2.6 代码接线点

| 操作 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 新增 DelegationPolicySchema | `src/config/schema.ts` | 946 附近 | SubAgentsConfigSchema 之前 |
| 接入根 schema | `src/config/schema.ts` | 1291-1374 | AppConfigSchema 新增字段 |
| 新增 canDelegate 纯函数 | `src/tools/builtin/spawn-agent.ts` | 80 之前 | 委托权限判定 |
| 改造 createChildRegistry | `src/tools/builtin/spawn-agent.ts` | 111-149 | 从物理移除改为深度计数 |
| 新增 prepareParallelDelegation | `src/tools/builtin/spawn-agent.ts` | 新增 | 并行委派准备（超限 throw） |
| 统一三层并行默认值 | `schema.ts:666` / `spawn-agent.ts:159` / `orchestrator-strategy.ts:26` | — | 从 config 读取，消除 5/3/3 不一致 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | subagents tab | 扩展或新建组件 |

### 2.7 测试要求

- `canDelegate` 深度超限拒绝
- `canDelegate` 目标非法拒绝
- `canDelegate` 合法委派通过 + nextDepth 递增
- `maxParallel` 超限 throw
- `boundedDelegationEnabled=false` 时退回物理移除旧行为
- `delegationTargets` 空数组的 role 不可委派
- `subprocessTools` 白名单过滤生效

---

## Task 3：智能委托策略——三态 allow/delegate/refuse（≥ 6 测试）

### 3.1 借鉴来源

**ohmypi No Generic Backend Worker**（`src/prompts.ts` `buildOrchestratorInstructions()`）：
- 默认不为通用后端工作派出 specialist——主 Orchestrator 自己直接写
- 理由：handoff 的 token/上下文/审查成本 > 收益（主模型已具备 backend 能力）

**ohmypi Hard Delegation Policy**（`src/frontend-policy.ts` `getFrontendWorkPolicy()`）：
- 三态策略：`allow`（主模型自由操作）/ `delegate`（强制委派）/ `refuse`（拒绝并提示用户）
- 专家不可用时**拒绝而非降级**——`assertFrontendSpecialistAllowed()`（index.ts:248-264）+ `tool_call` 事件硬拦截（index.ts:805-822）
- **软提示 + 硬拦截双层防线**：系统提示告诉模型该委派，tool_call 钩子硬阻止模型绕过

**ohmypi 关键词双命中规则**（`src/frontend-policy.ts` `isFrontendUiTask()`）：
- 必须同时命中 ACTION 关键词（build/create/implement/style/design）和 ARTIFACT 关键词（component/page/dashboard/layout）
- 单组命中不算——避免"Review the frontend architecture"误触发委派

### 3.2 RouteDev 缺口

- 委托决策全靠 LLM 自行判断——无策略驱动
- 无"该委派 vs 该自己做"的判定逻辑
- 无"专家不可用时拒绝"机制——子 Agent 配置缺失时静默降级
- 无 tool_call 硬拦截——模型可以绕过系统提示直接操作

### 3.3 落地设计

```typescript
// src/agents/delegation-policy.ts（新建文件）

/**
 * 委托策略三态
 * 借鉴 ohmypi 的 allow/delegate/refuse
 */
export type DelegationMode = 'allow' | 'delegate' | 'refuse';

export interface DelegationDecision {
  mode: DelegationMode;
  reason: string;
  targetRole?: AgentRole;       // mode=delegate 时必填
  nextStep?: string;            // 给用户的提示
}

/**
 * 任务类型识别——关键词双命中规则
 * 借鉴 ohmypi isFrontendUiTask 的双组命中设计
 */
export const TASK_TYPE_KEYWORDS = {
  // 前端任务
  frontend: {
    actions: ['build', 'create', 'implement', 'style', 'design', 'refactor'],
    artifacts: ['component', 'page', 'dashboard', 'layout', 'widget', 'modal'],
  },
  // 调研任务
  research: {
    actions: ['search', 'investigate', 'explore', 'analyze', 'survey'],
    artifacts: ['codebase', 'architecture', 'dependency', 'pattern', 'convention'],
  },
  // 审查任务
  review: {
    actions: ['review', 'audit', 'check', 'verify', 'inspect'],
    artifacts: ['code', 'change', 'pull-request', 'diff', 'commit'],
  },
} as const;

export type TaskType = keyof typeof TASK_TYPE_KEYWORDS;

/**
 * 双命中判定——action 和 artifact 必须同时命中
 */
export function classifyTask(taskDescription: string): TaskType | 'general' {
  const lower = taskDescription.toLowerCase();
  for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    const actionHit = keywords.actions.some((a) => lower.includes(a));
    const artifactHit = keywords.artifacts.some((a) => lower.includes(a));
    if (actionHit && artifactHit) return type as TaskType;
  }
  return 'general';
}

/**
 * 委托决策
 * 借鉴 ohmypi 的三态策略，但基于可配置的 policy
 */
export function decideDelegation(
  taskDescription: string,
  policy: {
    hardDelegationTypes: TaskType[];      // 必须委派的类型
    refuseIfSpecialistUnavailable: boolean; // 专家不可用时拒绝而非降级
    specialistAvailability: Record<AgentRole, boolean>; // 各角色专家是否可用
  },
): DelegationDecision {
  const taskType = classifyTask(taskDescription);

  // 通用任务：主 Agent 自己做（No Generic Backend Worker）
  if (taskType === 'general') {
    return { mode: 'allow', reason: '通用任务，主 Agent 直接执行' };
  }

  // 硬委派类型检查
  if (policy.hardDelegationTypes.includes(taskType)) {
    const targetRole = taskType === 'frontend' ? 'executor'
      : taskType === 'research' ? 'researcher'
      : taskType === 'review' ? 'reviewer'
      : 'custom';

    const specialistAvailable = policy.specialistAvailability[targetRole];
    if (specialistAvailable) {
      return {
        mode: 'delegate',
        reason: `${taskType} 任务，硬委派给 ${targetRole} specialist`,
        targetRole,
      };
    }

    // 专家不可用
    if (policy.refuseIfSpecialistUnavailable) {
      return {
        mode: 'refuse',
        reason: `${taskType} 任务需要 ${targetRole} specialist，但专家不可用`,
        nextStep: `请在设置页面配置 ${targetRole} specialist 的模型和凭证`,
      };
    }
    // 降级允许（非推荐）
    return {
      mode: 'allow',
      reason: `${taskType} 任务，但 ${targetRole} specialist 不可用，降级为主 Agent 执行`,
    };
  }

  // 非硬委派类型：主 Agent 自己做
  return { mode: 'allow', reason: `${taskType} 任务未标记为硬委派，主 Agent 执行` };
}
```

```typescript
// src/tools/builtin/spawn-agent.ts 扩展——tool_call 硬拦截

/**
 * 软提示 + 硬拦截双层防线
 * 借鉴 ohmypi 的 tool_call 事件拦截
 */
export function createDelegationGuard(
  policy: DelegationPolicyConfig,
  specialistAvailability: Record<AgentRole, boolean>,
): (toolName: string, taskContext: string) => { block: boolean; reason?: string } {
  return (toolName, taskContext) => {
    // 只拦截写操作类工具
    const writeTools = ['edit', 'write', 'bash'];
    if (!writeTools.includes(toolName)) return { block: false };

    const decision = decideDelegation(taskContext, {
      hardDelegationTypes: policy.hardDelegationTypes,
      refuseIfSpecialistUnavailable: policy.refuseIfSpecialistUnavailable,
      specialistAvailability,
    });

    if (decision.mode === 'refuse') {
      return { block: true, reason: `委托策略拦截：${decision.reason}` };
    }
    if (decision.mode === 'delegate') {
      // 提示而非硬阻止——模型应该走 spawn_agent
      return {
        block: true,
        reason: `此任务应委派给 ${decision.targetRole} specialist，请使用 spawn_agent 工具`,
      };
    }
    return { block: false };
  };
}
```

### 3.4 配置接入

```typescript
// src/config/schema.ts 扩展 DelegationPolicySchema

export const DelegationPolicySchema = z.preprocess((v) => v ?? {}, z.object({
  // ... Task 2 的四维约束字段 ...
  /** 硬委派类型——这些类型必须委派给 specialist */
  hardDelegationTypes: z.array(
    z.enum(['frontend', 'research', 'review']),
  ).default(['research', 'review']),  // 默认只硬委派调研和审查
  /** 专家不可用时拒绝而非降级 */
  refuseIfSpecialistUnavailable: z.boolean().default(false),
  /** 各角色专家是否可用（由 AgentProfile 配置自动推导，也可手动覆盖） */
  specialistAvailabilityOverride: z.record(
    z.enum(['researcher', 'executor', 'reviewer', 'custom']),
    z.boolean(),
  ).default({}),
  /** 是否启用 tool_call 硬拦截 */
  toolCallGuardEnabled: z.boolean().default(false),
}));
```

### 3.5 设置页面接入

- **TabId**：扩展 `'subagents'` tab
- **控件**：
  - `hardDelegationTypes`：Checkbox 组（frontend/research/review）
  - `refuseIfSpecialistUnavailable`：Toggle 开关 + 警告提示
  - `specialistAvailabilityOverride`：4 个 Toggle（每角色一个）
  - `toolCallGuardEnabled`：Toggle 开关 + 说明"启用后写操作工具会被策略拦截"
- **组件**：与 Task 2 合并在 SettingsSubAgentsTab

### 3.6 代码接线点

| 操作 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 新建 delegation-policy.ts | `src/agents/delegation-policy.ts` | — | 新文件 |
| 扩展 DelegationPolicySchema | `src/config/schema.ts` | Task 2 新增处 | 增加 hardDelegation 等字段 |
| 新增 createDelegationGuard | `src/tools/builtin/spawn-agent.ts` | 新增 | tool_call 硬拦截 |
| 接入 tool_call 事件 | `src/agent/loop.ts` 或事件系统 | — | 工具调用前校验 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | subagents tab | 扩展组件 |

### 3.7 测试要求

- `classifyTask` 双命中判定（frontend/research/review/general）
- `classifyTask` 单组命中不触发（如"review the architecture"不触发 review）
- `decideDelegation` allow 模式（通用任务）
- `decideDelegation` delegate 模式（硬委派类型 + 专家可用）
- `decideDelegation` refuse 模式（硬委派类型 + 专家不可用 + refuseIfUnavailable=true）
- `createDelegationGuard` 拦截写工具

---

## Task 4：call-scoped overlay——子 Agent 独立上下文作用域（≥ 5 测试）

### 4.1 借鉴来源

**Flue call-scoped overlay**（已重构为 subagent + detached child session 模型）：
- 旧版"role 作为 call-scoped system prompt overlay"已废弃
- 当前做法：每次 `session.task(text, { agent: 'reviewer' })` 创建**全新子 session**
- 子 session 的 system prompt 由 subagent 的 `instructions` + AGENTS.md/skills 重新构建
- 子 session 拥有独立 `storageKey`、独立 `SessionData`、独立消息历史
- **仅把最终答案文本返回给父会话**——不污染父 history
- 委派深度限制 `MAX_DELEGATION_DEPTH = 4`（session.ts:161）

**Flue 存储键三元组**（`harness.ts:155-159`）：
- `createSessionStorageKey(instanceId, harnessName, sessionName)`
- Instance ⊃ Harness ⊃ Session 的组合关系体现在 key 结构

### 4.2 RouteDev 缺口

- 子 Agent 共享父上下文——通过 `createChildRegistry` 克隆工具注册表，但消息历史和 system prompt 与父共享
- 无"独立子 session"概念——子 Agent 的对话历史会污染父 Agent
- 无存储键三元组——无法区分"哪个 instance 的哪个 harness 的哪个 session"

### 4.3 落地设计

```typescript
// src/agents/subagent-session.ts（新建文件）

/**
 * 子 Agent 独立会话作用域
 * 借鉴 Flue 的 detached child session 模型
 *
 * 核心原则：子 Agent 的角色指令不注入父 history，
 * 子 Agent 的对话历史也不回流父上下文。
 * 仅最终答案文本返回给父会话。
 */
export interface SubAgentSessionScope {
  /** 会话 ID（独立于父会话） */
  sessionId: string;
  /** 父会话 ID（用于溯源） */
  parentSessionId: string;
  /** 子 Agent 角色 */
  role: AgentRole;
  /** 独立 system prompt（由 AgentProfile.systemPrompt 构建，不从父继承） */
  systemPrompt: string;
  /** 独立消息历史（不回流父上下文） */
  messageHistory: Message[];
  /** 委派深度（0=主 Agent，1=子 Agent，2=孙 Agent） */
  depth: number;
  /** 存储键三元组（借鉴 Flue） */
  storageKey: {
    instanceId: string;
    harnessName: string;
    sessionName: string;
  };
  /** 创建时间 */
  createdAt: number;
  /** 是否已完成 */
  completedAt?: number;
}

/**
 * 创建子 Agent 独立会话
 * 借鉴 Flue 的 createTaskSession
 */
export function createSubAgentSession(
  parentSessionId: string,
  role: AgentRole,
  profile: AgentProfile,
  depth: number,
  parentStorageKey?: { instanceId: string; harnessName: string },
): SubAgentSessionScope {
  const sessionId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionName = `task:${parentSessionId}:${sessionId}`;

  return {
    sessionId,
    parentSessionId,
    role,
    // system prompt 由 profile 构建，不从父继承
    systemPrompt: profile.systemPrompt,
    // 独立空历史
    messageHistory: [],
    depth,
    // 存储键三元组（借鉴 Flue）
    storageKey: {
      instanceId: parentStorageKey?.instanceId ?? 'default',
      harnessName: parentStorageKey?.harnessName ?? 'default',
      sessionName,
    },
    createdAt: Date.now(),
  };
}

/**
 * 提取子 Agent 最终答案——仅文本，不含中间过程
 * 借鉴 Flue "仅把 taskResult.text 返回给父会话"
 */
export function extractFinalAnswer(scope: SubAgentSessionScope): string {
  // 取最后一条 assistant 消息的文本内容
  const lastAssistant = [...scope.messageHistory]
    .reverse()
    .find((m) => m.role === 'assistant');
  return lastAssistant?.content ?? '';
}
```

### 4.4 配置接入

```typescript
// src/config/schema.ts 扩展 DelegationPolicySchema

export const DelegationPolicySchema = z.preprocess((v) => v ?? {}, z.object({
  // ... Task 2/3 的字段 ...
  /** 是否启用子 Agent 独立会话作用域 */
  detachedSessionEnabled: z.boolean().default(false),
  /** 子 Agent 上下文是否完全隔离（true=不继承父 history，false=继承精简版） */
  fullContextIsolation: z.boolean().default(true),
  /** 子 Agent 最大上下文 token 数（防止子 Agent 上下文膨胀） */
  subAgentMaxContextTokens: z.number().int().min(1000).max(200000).default(32000),
  /** 是否把子 Agent 的工具调用记录回流父上下文（false=只回流最终答案） */
  propagateToolCallsToParent: z.boolean().default(false),
}));
```

### 4.5 设置页面接入

- **TabId**：扩展 `'subagents'` tab
- **控件**：
  - `detachedSessionEnabled`：Toggle 开关
  - `fullContextIsolation`：Toggle 开关 + 说明"开启后子 Agent 不继承父 history"
  - `subAgentMaxContextTokens`：NumberInput（1000-200000）
  - `propagateToolCallsToParent`：Toggle 开关 + 说明"开启后父 Agent 能看到子 Agent 的工具调用"

### 4.6 代码接线点

| 操作 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 新建 subagent-session.ts | `src/agents/subagent-session.ts` | — | 新文件 |
| 改造 spawn-agent 工具 | `src/tools/builtin/spawn-agent.ts` | 111-149 | 创建独立 session scope |
| 接入存储键三元组 | `src/storage/` 或 session 管理 | — | 后续 Phase 迁移 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | subagents tab | 扩展组件 |

### 4.7 测试要求

- `createSubAgentSession` 生成独立 sessionId 和 storageKey
- `extractFinalAnswer` 只返回最后一条 assistant 消息
- `fullContextIsolation=true` 时子 Agent 不继承父 history
- `propagateToolCallsToParent=false` 时父上下文无工具调用记录
- `detachedSessionEnabled=false` 时退回旧行为（共享父上下文）

---

## Task 5：Agent 活动面板——specialist 活动实时追踪（≥ 5 测试）

### 5.1 借鉴来源

**ohmypi TUI Activity Widget**（`src/activity.ts` + `extensions/ohmypi/index.ts`）：

**显示字段**：
| 字段 | 来源 | 示例 |
|------|------|------|
| title | `${lineage} · d${depth}` | `planner > scout · d2` |
| detail | 任务预览（截断 72 字符） | `Find existing pi widget examples…` |
| meta | `tools ${count} · last ${toolName}` + thinking level + 进度 | `tools 3 · last read · Reading tui.md… · thinking high` |
| model | 从 `provider/model:thinking` 切出的纯模型名 | `gpt-5.4` |
| status | running/success/error | `●` / `✓` / `✕` |

**数据更新机制**：事件推送（非轮询）
- ActivityStore 三态机：`startActivity` → `updateActivity` → `finishActivity`
- 子进程 stdout 按行解析 JSON 事件
- `message_update` + `text_delta` → 追加文本 → updateActivity
- `tool_execution_start` → 记录工具调用 → updateActivity
- 完成后从 `active[]` 移到 `recent[]`（slice 防膨胀）

**Widget 布局**：
- header：`ohmypi active · {projectName} · {activeCount} active · {recentCount} recent`
- summary：`scout · planner · reviewer · frontend · depth 2 · parallel 4`
- running[]：最多 4 条
- recent[]：最多 3 条

### 5.2 RouteDev 缺口

- `TaskMonitorPanel`（Layout.tsx:169-204，默认 280px）只显示消息流
- 无 specialist 活动追踪——看不到子 Agent 在做什么
- 无 lineage/depth 显示
- 无工具调用实时统计

### 5.3 落地设计

```typescript
// src/agents/activity-store.ts（新建文件）

/**
 * Agent 活动记录
 * 借鉴 ohmypi ActivityRecord，但适配 RouteDev 的角色体系
 */
export interface AgentActivityRecord {
  id: string;
  /** 血统链——如 "executor > researcher" */
  lineage: string;
  /** 委派深度 */
  depth: number;
  /** 角色 */
  role: AgentRole;
  /** 任务预览（截断 72 字符） */
  taskPreview: string;
  /** 状态 */
  status: 'running' | 'success' | 'error';
  /** 工具调用计数 */
  toolCallCount: number;
  /** 最近工具名 */
  lastToolName?: string;
  /** 最近工具描述 */
  lastToolDescription?: string;
  /** 模型 ID（纯名，不含 thinking 等级） */
  modelId?: string;
  /** thinking 等级（从 modelId 分离） */
  thinkingLevel?: string;
  /** 开始时间 */
  startedAt: number;
  /** 完成时间 */
  finishedAt?: number;
  /** 错误信息（status=error 时） */
  error?: string;
}

/**
 * 活动存储——三态机
 * 借鉴 ohmypi createActivityStore
 */
export class AgentActivityStore {
  private active: AgentActivityRecord[] = [];
  private recent: AgentActivityRecord[] = [];
  private listeners: Set<(active: AgentActivityRecord[], recent: AgentActivityRecord[]) => void> = new Set();

  constructor(
    private maxActive: number = 4,
    private maxRecent: number = 3,
  ) {}

  startActivity(record: Omit<AgentActivityRecord, 'status' | 'toolCallCount' | 'startedAt'>): string {
    const full: AgentActivityRecord = {
      ...record,
      status: 'running',
      toolCallCount: 0,
      startedAt: Date.now(),
    };
    this.active.unshift(full);  // 新的在前
    if (this.active.length > this.maxActive) {
      this.active = this.active.slice(0, this.maxActive);
    }
    this.notify();
    return full.id;
  }

  updateActivity(id: string, update: Partial<AgentActivityRecord>): void {
    const idx = this.active.findIndex((a) => a.id === id);
    if (idx >= 0) {
      this.active[idx] = { ...this.active[idx], ...update };
      this.notify();
    }
  }

  finishActivity(id: string, status: 'success' | 'error', error?: string): void {
    const idx = this.active.findIndex((a) => a.id === id);
    if (idx >= 0) {
      const [record] = this.active.splice(idx, 1);
      record.status = status;
      record.finishedAt = Date.now();
      record.error = error;
      this.recent.unshift(record);
      this.recent = this.recent.slice(0, this.maxRecent);
      this.notify();
    }
  }

  /** 订阅更新（事件推送，非轮询） */
  subscribe(listener: (active: AgentActivityRecord[], recent: AgentActivityRecord[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.active, this.recent);
    }
  }
}

/**
 * 模型标签分离——借鉴 ohmypi splitModelLabel
 * "openai-codex/gpt-5.4:high" → { model: "gpt-5.4", thinking: "high" }
 */
export function splitModelLabel(modelString: string): { model: string; thinking?: string } {
  const colonIdx = modelString.lastIndexOf(':');
  if (colonIdx > 0) {
    const thinking = modelString.slice(colonIdx + 1);
    const model = modelString.slice(0, colonIdx);
    // 验证 thinking 是等级而非模型名的一部分
    if (['low', 'medium', 'high', 'auto'].includes(thinking)) {
      // 去掉 provider 前缀
      const slashIdx = model.lastIndexOf('/');
      return {
        model: slashIdx >= 0 ? model.slice(slashIdx + 1) : model,
        thinking,
      };
    }
  }
  const slashIdx = modelString.lastIndexOf('/');
  return { model: slashIdx >= 0 ? modelString.slice(slashIdx + 1) : modelString };
}
```

### 5.4 配置接入

```typescript
// src/config/schema.ts 扩展

export const ActivityPanelSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用 Agent 活动面板 */
  enabled: z.boolean().default(false),
  /** 最大同时显示的活动数 */
  maxActiveDisplay: z.number().int().min(1).max(10).default(4),
  /** 最大历史记录数 */
  maxRecentDisplay: z.number().int().min(0).max(20).default(3),
  /** 任务预览截断长度 */
  taskPreviewLength: z.number().int().min(20).max(200).default(72),
  /** 是否显示工具调用统计 */
  showToolCallStats: z.boolean().default(true),
  /** 是否显示 thinking 等级标签 */
  showThinkingLevel: z.boolean().default(true),
}));
```

### 5.5 设置页面接入

- **TabId**：新建 `'activity'` tab，或扩展 `'appearance'` tab
- **控件**：
  - `enabled`：Toggle 开关
  - `maxActiveDisplay` / `maxRecentDisplay`：NumberInput
  - `taskPreviewLength`：NumberInput（20-200）
  - `showToolCallStats` / `showThinkingLevel`：Toggle 开关
- **UI 组件**：新建 `desktop/renderer/src/components/AgentActivityPanel.tsx`，渲染在 TaskMonitorPanel 内部或独立区域

### 5.6 代码接线点

| 操作 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 新建 activity-store.ts | `src/agents/activity-store.ts` | — | 新文件 |
| 新建 UI 组件 | `desktop/renderer/src/components/AgentActivityPanel.tsx` | — | 新文件 |
| 接入 TaskMonitorPanel | `desktop/renderer/src/components/Layout.tsx` | 169-204 | 嵌入活动面板 |
| 接入子 Agent 事件 | `src/tools/builtin/spawn-agent.ts` | spawn 调用处 | startActivity/updateActivity/finishActivity |
| 接入工具调用事件 | `src/agent/loop.ts` 或事件总线 | 工具调用处 | updateActivity(lastToolName) |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | TabId 新增 'activity' | 新建 tab 或扩展 appearance |

### 5.7 测试要求

- `startActivity` 新活动进入 active[] 且 unshift 到首位
- `updateActivity` 原地更新（按 id 查找）
- `finishActivity` 从 active[] 移到 recent[] 且 slice 防膨胀
- `splitModelLabel` 正确分离 `gpt-5.4:high` → `{ model: 'gpt-5.4', thinking: 'high' }`
- `subscribe` 事件推送（非轮询）

---

## Task 6：三层抽象——Instance → Harness → Session（≥ 4 测试）

### 6.1 借鉴来源

**Flue 三层抽象**（`AGENTS.md` + `harness.ts` + `session.ts`）：

```
AgentInstance  →  Harness  →  Session  →  Operation  →  Turn
(URL <id>)      (init())     (harness.session())  (prompt/skill/task)  (一次 LLM 往返)
```

- **Instance 层**：URL `<id>` 标识的"durable runtime scope"，拥有 sandbox 状态
- **Harness 层**：`init()` 创建，封装 model 默认值、tools、sandbox、filesystem、skills、instructions
- **Session 层**：持久化消息历史 + 会话元数据

**存储键三元组**（`harness.ts:155-159`）：
- `createSessionStorageKey(instanceId, harnessName, sessionName)`
- Instance ⊃ Harness ⊃ Session 的组合关系体现在 key 结构

**Scope abort 级联**（`harness.ts:318-334`）：
- 每个 harness 一个 `scopeAbortController`
- `close()` 级联 abort 所有 shell 调用 + session

### 6.2 RouteDev 缺口

- RouteDev 只有 Session 层——无 Instance/Harness 分层
- 无存储键三元组——无法区分"哪个 instance 的哪个 harness 的哪个 session"
- 无 scope abort 级联——子 Agent 失败不会级联取消

### 6.3 落地设计（保守方案——先引入概念层，存储键后续迁移）

```typescript
// src/agents/instance-harness.ts（新建文件）

/**
 * Instance 层——持久运行时作用域
 * 借鉴 Flue AgentInstance
 *
 * 对应一个项目/工作区，拥有独立的 sandbox 状态和配置覆盖
 */
export interface AgentInstance {
  id: string;                    // 实例 ID（对应项目路径或自定义标识）
  projectPath: string;           // 项目路径
  sandboxState?: {               // 沙箱状态
    worktreePath?: string;
    envVars?: Record<string, string>;
  };
  configOverride?: Partial<AppConfig>;  // 实例级配置覆盖
  createdAt: number;
}

/**
 * Harness 层——已初始化的 Agent 环境
 * 借鉴 Flue Harness
 *
 * 封装一次 Agent 运行所需的全部上下文：
 * model 默认值、tools 注册表、sandbox、filesystem、skills
 */
export interface AgentHarness {
  instanceId: string;            // 所属 Instance
  name: string;                  // harness 名称（默认 "default"）
  modelId: string;               // 默认模型
  toolRegistry: ToolRegistry;    // 工具注册表
  skills: SkillRegistry;         // Skill 注册表
  filesystem: AgentFs;           // 文件系统抽象
  scopeAbortController: AbortController;  // scope abort（级联取消）
  createdAt: number;
}

/**
 * 存储键三元组
 * 借鉴 Flue createSessionStorageKey
 */
export function createSessionStorageKey(
  instanceId: string,
  harnessName: string,
  sessionName: string,
): string {
  return `${instanceId}/${harnessName}/${sessionName}`;
}

/**
 * Scope abort 级联
 * 借鉴 Flue harness.close() 的级联取消
 */
export class HarnessScope {
  private abortController: AbortController;
  private childScopes: HarnessScope[] = [];

  constructor(private parent?: HarnessScope) {
    this.abortController = new AbortController();
    this.parent?.addChild(this);
  }

  private addChild(child: HarnessScope): void {
    this.childScopes.push(child);
  }

  /** 级联 abort——取消自己和所有子 scope */
  abort(reason?: string): void {
    this.abortController.abort(reason);
    for (const child of this.childScopes) {
      child.abort(reason);
    }
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }
}
```

### 6.4 配置接入

```typescript
// src/config/schema.ts 扩展

export const InstanceHarnessSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用三层抽象（false 时退回单层 Session 旧行为） */
  threeTierAbstractionEnabled: z.boolean().default(false),
  /** 默认 Instance ID（未指定时使用项目路径 hash） */
  defaultInstanceId: z.string().default(''),
  /** 默认 Harness 名称 */
  defaultHarnessName: z.string().default('default'),
  /** 是否启用 scope abort 级联 */
  scopeAbortCascadeEnabled: z.boolean().default(false),
}));
```

### 6.5 设置页面接入

- **TabId**：扩展 `'execution'` tab（已存在）
- **控件**：
  - `threeTierAbstractionEnabled`：Toggle 开关 + 说明
  - `defaultInstanceId`：TextInput
  - `defaultHarnessName`：TextInput
  - `scopeAbortCascadeEnabled`：Toggle 开关

### 6.6 代码接线点

| 操作 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 新建 instance-harness.ts | `src/agents/instance-harness.ts` | — | 新文件 |
| 接入 session 管理 | `src/session/` 或现有 session 管理 | — | 存储键三元组（后续 Phase 迁移） |
| 接入 scope abort | `src/agent/loop.ts` 或 spawn-agent | — | 子 Agent 失败级联取消 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | execution tab | 扩展组件 |

### 6.7 测试要求

- `createSessionStorageKey` 生成正确格式
- `HarnessScope.abort` 级联取消子 scope
- `threeTierAbstractionEnabled=false` 时退回旧行为
- Instance/Harness/Session 三层 ID 唯一性

---

## Task 7：Reviewer 分级配置化——ohmypi 弱点的改进（≥ 4 测试）

### 7.1 借鉴来源

**ohmypi Reviewer 分级的工程化弱点**（`src/prompts.ts` + `docs/architecture.md`）：
- 分级阈值全靠系统提示的自然语言描述，**无配置字段**
- 无 `reviewerLevel` / `riskThreshold` 字段
- 无 `taskSize` 自动评估算法
- "跨模型审查"未自动触发——需用户手动配置 specialist.reviewer

**改进方向**（RouteDev 要做对）：
- 分级配置化——暴露 `reviewerPolicy` 字段
- 跨模型自动触发——high-risk 时自动切换 reviewer 模型家族
- 升级决策算法化——基于失败次数、上下文 token、复杂度评分

### 7.2 RouteDev 缺口

- Task 1 已设计了 `ReviewerPolicySchema`，但缺少"high-risk 自动判定"和"升级决策算法化"
- 缺少跨模型审查的模型选择逻辑

### 7.3 落地设计

```typescript
// src/agent/reviewer-tier-evaluator.ts（新建文件）

/**
 * High-risk 自动判定
 * 借鉴 ohmypi 的"high-risk"概念，但算法化判定
 */
export interface RiskAssessment {
  isHighRisk: boolean;
  riskScore: number;              // 0-100
  riskFactors: string[];          // 触发的风险因子
}

export function assessRisk(context: {
  affectsSecurity: boolean;       // 涉及安全/认证/权限
  affectsDataIntegrity: boolean;  // 涉及数据完整性
  affectsFileSystem: boolean;     // 涉及文件系统写操作
  stepCount: number;              // 任务步骤数
  crossModuleChange: boolean;     // 跨模块改动
  hasExternalSideEffects: boolean; // 有外部副作用（网络/进程）
}): RiskAssessment {
  const factors: string[] = [];
  let score = 0;

  if (context.affectsSecurity) { factors.push('security'); score += 40; }
  if (context.affectsDataIntegrity) { factors.push('data-integrity'); score += 30; }
  if (context.crossModuleChange) { factors.push('cross-module'); score += 15; }
  if (context.hasExternalSideEffects) { factors.push('external-side-effects'); score += 10; }
  if (context.stepCount > 30) { factors.push('large-step-count'); score += 5; }
  if (context.affectsFileSystem) { factors.push('filesystem-write'); score += 5; }

  return {
    isHighRisk: score >= 40,  // security 或 data-integrity 单项即 high-risk
    riskScore: Math.min(score, 100),
    riskFactors: factors,
  };
}

/**
 * 跨模型审查的模型选择
 * 借鉴 ohmypi 未实现的"跨模型审查"，RouteDev 自动化
 */
export function selectCrossModelReviewer(
  primaryModelId: string,
  availableModels: string[],
): string | null {
  // 提取 primary model 的家族
  const primaryFamily = extractModelFamily(primaryModelId);

  // 在可用模型中找不同家族的
  const crossModel = availableModels.find((m) => extractModelFamily(m) !== primaryFamily);
  return crossModel ?? null;
}

function extractModelFamily(modelId: string): string {
  if (modelId.includes('gpt') || modelId.includes('openai')) return 'openai';
  if (modelId.includes('claude') || modelId.includes('anthropic')) return 'anthropic';
  if (modelId.includes('gemini') || modelId.includes('google')) return 'google';
  if (modelId.includes('qwen') || modelId.includes('alibaba')) return 'alibaba';
  if (modelId.includes('glm') || modelId.includes('zhipu')) return 'zhipu';
  return 'unknown';
}
```

### 7.4 配置接入

Task 1 的 `ReviewerPolicySchema` 已包含 `autoCrossModelForHighRisk` 和 `crossModelReviewerId`。Task 7 补充：

```typescript
// 扩展 ReviewerPolicySchema
export const ReviewerPolicySchema = z.preprocess((v) => v ?? {}, z.object({
  // ... Task 1 的字段 ...
  /** high-risk 判定阈值（riskScore >= 此值时判定为 high-risk） */
  highRiskThreshold: z.number().int().min(20).max(100).default(40),
  /** 是否自动选择跨模型 reviewer（false 时使用 crossModelReviewerId 指定的模型） */
  autoSelectCrossModel: z.boolean().default(true),
  /** 升级决策算法化——失败次数超过此值时升级 tier */
  failureEscalationThreshold: z.number().int().min(1).max(10).default(2),
  /** 上下文 token 超过此比例时升级 tier（0.8 = 80%） */
  contextTokenEscalationRatio: z.number().min(0.5).max(0.95).default(0.8),
}));
```

### 7.5 设置页面接入

与 Task 1 合并在 `SettingsReviewerTab`，补充控件：
- `highRiskThreshold`：NumberInput（20-100）+ 风险因子说明
- `autoSelectCrossModel`：Toggle 开关
- `failureEscalationThreshold`：NumberInput（1-10）
- `contextTokenEscalationRatio`：Slider（0.5-0.95）

### 7.6 代码接线点

| 操作 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 新建 reviewer-tier-evaluator.ts | `src/agent/reviewer-tier-evaluator.ts` | — | 新文件 |
| 接入 dual-loop-orchestrator | `src/agent/dual-loop-orchestrator.ts` | evaluateOuterLoop | 调用 assessRisk |
| 接入模型选择 | `src/agent/dual-loop-orchestrator.ts` | runCrossModelReview | 调用 selectCrossModelReviewer |
| 扩展 schema | `src/config/schema.ts` | Task 1 新增处 | 增加 highRiskThreshold 等字段 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | reviewer tab | 补充控件 |

### 7.7 测试要求

- `assessRisk` security 因子触发 high-risk
- `assessRisk` 多因子叠加 score 正确
- `selectCrossModelReviewer` 选择不同家族模型
- `selectCrossModelReviewer` 无跨模型可用时返回 null

---

## Task 8：项目级配置——三层合并 global + project + default（≥ 4 测试）

### 8.1 借鉴来源

**ohmypi 三层配置合并**（`src/config.ts` `loadConfig()`）：
```ts
const globalConfig = readJsonIfExists(path.join(agentDir, 'ohmypi.json'));
const projectConfig = cwd ? readJsonIfExists(path.join(cwd, '.pi', 'ohmypi.json')) : undefined;
return mergeConfig<OhmypiConfig>(DEFAULT_CONFIG, globalConfig, projectConfig);
```
- `deepMerge()` 处理对象/数组/原始值三种合并语义（数组直接覆盖，不拼接）
- `hasNonDefaultOverride()` 判断用户是否真的覆盖了某字段
- 路径优先级：`PI_CODING_AGENT_DIR` 环境变量 > `~/.pi/agent` > 默认

### 8.2 RouteDev 缺口

- RouteDev 配置只有单层——全局 `~/.routedev/config.json`
- 无项目级配置覆盖——不同项目无法有不同的 Agent 配置
- 无 deepMerge 语义

### 8.3 落地设计

```typescript
// src/config/loader.ts 扩展（或新建）

/**
 * 三层配置合并
 * 借鉴 ohmypi loadConfig 的 global + project + default 模式
 *
 * 优先级：项目级 > 全局级 > 默认值
 * 项目级路径：.routedev/config.json（项目根目录）
 * 全局级路径：~/.routedev/config.json
 */
export async function loadMergedConfig(projectPath?: string): Promise<AppConfig> {
  // L1: 默认值（Zod schema 的 .default()）
  // L2: 全局配置
  const globalConfig = await readJsonIfExists(getGlobalConfigPath());
  // L3: 项目级配置
  const projectConfig = projectPath
    ? await readJsonIfExists(path.join(projectPath, '.routedev', 'config.json'))
    : undefined;

  // 深度合并：default → global → project
  const merged = deepMergeConfig(
    getDefaultConfig(),
    globalConfig ?? {},
    projectConfig ?? {},
  );

  // Zod 校验合并后的配置
  return AppConfigSchema.parse(merged);
}

/**
 * 深度合并配置
 * 借鉴 ohmypi deepMerge 的语义：
 * - 对象：递归合并
 * - 数组：直接覆盖（不拼接）
 * - 原始值：后者覆盖前者
 */
export function deepMergeConfig<T>(...configs: Partial<T>[]): T {
  if (configs.length === 0) return {} as T;
  return configs.reduce((acc, curr) => deepMerge(acc, curr), {} as T) as T;
}

function deepMerge(target: any, source: any): any {
  if (source === null || source === undefined) return target;
  if (typeof source !== 'object' || Array.isArray(source)) return source;
  if (typeof target !== 'object' || Array.isArray(target)) return source;

  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (key in target) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function getGlobalConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const envPath = process.env.ROUTEDEV_CONFIG_DIR;
  return envPath ?? path.join(home, '.routedev', 'config.json');
}

async function readJsonIfExists(filePath: string): Promise<any | undefined> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}
```

### 8.4 配置接入

```typescript
// src/config/schema.ts 扩展

export const ConfigLayeringSchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用项目级配置覆盖 */
  projectConfigEnabled: z.boolean().default(false),
  /** 项目级配置文件名（相对项目根目录） */
  projectConfigPath: z.string().default('.routedev/config.json'),
  /** 全局配置目录（环境变量 ROUTEDEV_CONFIG_DIR 优先） */
  globalConfigDir: z.string().default(''),
  /** 数组合并策略：'replace'（覆盖）或 'merge'（去重拼接） */
  arrayMergeStrategy: z.enum(['replace', 'merge']).default('replace'),
}));
```

### 8.5 设置页面接入

- **TabId**：扩展 `'execution'` tab
- **控件**：
  - `projectConfigEnabled`：Toggle 开关
  - `projectConfigPath`：TextInput
  - `globalConfigDir`：TextInput + 文件夹选择按钮
  - `arrayMergeStrategy`：RadioGroup（replace/merge）
- **显示**：当前生效的配置来源（global / project / default）指示器

### 8.6 代码接线点

| 操作 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 新建/扩展 loader.ts | `src/config/loader.ts` | — | loadMergedConfig |
| 接入 config 加载入口 | `src/config/index.ts` 或启动流程 | — | 替换原单层加载 |
| 新增 deepMergeConfig | `src/config/loader.ts` | — | 深度合并 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | execution tab | 扩展组件 |

### 8.7 测试要求

- `deepMergeConfig` 对象递归合并
- `deepMergeConfig` 数组直接覆盖（arrayMergeStrategy='replace'）
- `deepMergeConfig` 数组去重拼接（arrayMergeStrategy='merge'）
- `loadMergedConfig` 三层优先级（project > global > default）

---

## Task 9：Structured Errors——双受众错误模型（≥ 4 测试）

### 9.1 借鉴来源

**Flue 双受众错误模型**（`errors.ts`）：
- `message`：一句话，caller-safe，始终渲染给用户
- `details`：较长 caller-safe，始终渲染
- `dev`：开发者向，仅 `flue dev`/`flue run` 渲染
- `details` 严禁泄露命名空间/文件系统路径/框架内部/源码级修复指令
- `dev` 才放丰富修复指引
- 每个 error 类自拥 `type` 常量与 HTTP status，构造器只收结构化数据

### 9.2 RouteDev 缺口

- `RouteDevError`（errors.ts:14-25）只有 `message` + `code`
- 无 `details` / `dev` 分层——错误信息要么太笼统要么太详细
- 无受众隔离——内部细节可能泄漏给终端用户

### 9.3 落地设计

```typescript
// src/utils/errors.ts 扩展（改造现有 RouteDevError）

/**
 * 双受众错误模型
 * 借鉴 Flue 的 message + details + dev 三层结构
 *
 * message：一句话，用户可见，不含内部细节
 * details：较长说明，用户可见，caller-safe（不含路径/内部符号）
 * dev：开发者向，仅开发模式渲染（含修复指引、源码位置）
 */
export class RouteDevError extends Error {
  readonly code: string;
  readonly details?: string;     // 用户可见的详细说明（caller-safe）
  readonly dev?: string;         // 开发者向信息（含内部细节）

  constructor(
    message: string,
    code: string,
    options?: {
      details?: string;
      dev?: string;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.details = options?.details;
    this.dev = options?.dev;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** 用户可见的完整信息（message + details） */
  toUserMessage(): string {
    return this.details ? `${this.message}\n\n${this.details}` : this.message;
  }

  /** 开发者可见的完整信息（含 dev） */
  toDevMessage(): string {
    const parts = [this.toUserMessage()];
    if (this.dev) {
      parts.push(`\n[Dev] ${this.dev}`);
    }
    return parts.join('');
  }
}

/**
 * 改造现有子类——增加 details/dev 参数
 */
export class ToolExecutionError extends RouteDevError {
  readonly toolName: string;
  readonly cause?: unknown;

  constructor(
    toolName: string,
    message: string,
    options?: {
      details?: string;
      dev?: string;
      cause?: unknown;
    },
  ) {
    super(message, 'TOOL_EXECUTION_ERROR', options);
    this.toolName = toolName;
    this.cause = options?.cause;
  }
}

// 其他子类同理改造：PermissionDeniedError / ConfigValidationError /
// SecurityViolationError / LLMError
```

### 9.4 配置接入

```typescript
// src/config/schema.ts 扩展（GeneralConfigSchema 附近）

export const ErrorDisplaySchema = z.preprocess((v) => v ?? {}, z.object({
  /** 错误显示模式：'user'（只 message+details）或 'dev'（含 dev 信息） */
  errorDisplayMode: z.enum(['user', 'dev']).default('user'),
  /** 是否在错误中包含堆栈追踪（dev 模式自动启用） */
  includeStackTrace: z.boolean().default(false),
  /** 是否把错误写入日志文件 */
  logErrorsToFile: z.boolean().default(true),
}));
```

### 9.5 设置页面接入

- **TabId**：扩展 `'appearance'` tab 或 `'about'` tab
- **控件**：
  - `errorDisplayMode`：RadioGroup（user/dev）
  - `includeStackTrace`：Toggle 开关
  - `logErrorsToFile`：Toggle 开关

### 9.6 代码接线点

| 操作 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 改造 RouteDevError 基类 | `src/utils/errors.ts` | 14-25 | 增加 details/dev |
| 改造 5 个子类 | `src/utils/errors.ts` | 31-89 | 增加 details/dev 参数 |
| 新增 toUserMessage/toDevMessage | `src/utils/errors.ts` | 新增 | 受众分层渲染 |
| 接入错误显示 | `desktop/renderer/src/components/` 错误显示组件 | — | 根据 errorDisplayMode 渲染 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | appearance tab | 扩展组件 |

### 9.7 测试要求

- `RouteDevError.toUserMessage` 不含 dev 信息
- `RouteDevError.toDevMessage` 含 dev 信息
- `details` 不含路径/内部符号（caller-safe）
- `errorDisplayMode='user'` 时 UI 不渲染 dev 信息

---

## Task 10：Result Schemas——子 Agent 结构化返回（≥ 5 测试）

### 10.1 借鉴来源

**Flue Result Schemas**（`result.ts:15-26` + `types.ts:761`）：
- `result: v.object({...})` 选项触发 `finish`/`give_up` 工具协议
- 强制模型用结构化数据收尾，便于父代理程序化判断
- 审查者返回 `{ summary, risks[] }`（valibot schema 校验）

### 10.2 RouteDev 缺口

- 子 Agent 返回纯文本——父 Agent 需要 LLM 解析才能判断结果
- 无结构化 schema——审查结果、调研结果等无法程序化处理
- 无 `finish`/`give_up` 协议——子 Agent 可能无限运行

### 10.3 落地设计

```typescript
// src/agents/result-schemas.ts（新建文件）

/**
 * 子 Agent 结构化返回 schema
 * 借鉴 Flue 的 result schema + finish/give_up 协议
 *
 * 每种角色有专属的返回 schema，父 Agent 可程序化判断
 */
export const ResearcherResultSchema = z.object({
  /** 调研总结 */
  summary: z.string(),
  /** 发现的关键信息 */
  findings: z.array(z.object({
    topic: z.string(),
    detail: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    sources: z.array(z.string()),  // 文件路径或 URL
  })),
  /** 建议的下一步 */
  suggestedNextSteps: z.array(z.string()),
  /** 是否完成（false=give_up） */
  completed: z.boolean(),
  /** 放弃原因（completed=false 时必填） */
  giveUpReason: z.string().optional(),
});

export const ExecutorResultSchema = z.object({
  /** 执行总结 */
  summary: z.string(),
  /** 变更的文件列表 */
  changedFiles: z.array(z.object({
    path: z.string(),
    changeType: z.enum(['create', 'modify', 'delete']),
    summary: z.string(),
  })),
  /** 是否通过测试 */
  testsPassed: z.boolean().optional(),
  /** 未完成的工作 */
  remainingWork: z.array(z.string()),
  completed: z.boolean(),
  giveUpReason: z.string().optional(),
});

export const ReviewerResultSchema = z.object({
  /** 审查总结 */
  summary: z.string(),
  /** 发现的风险（借鉴 Flue + Task 1 的三条证据协议） */
  risks: z.array(z.object({
    description: z.string(),
    failureScenario: z.string(),
    violatedInvariant: z.string(),
    evidence: z.array(z.object({
      file: z.string(),
      line: z.number(),
      excerpt: z.string().optional(),
    })),
    severity: z.enum(['blocking', 'warning', 'info']),
    suggestedFix: z.string().optional(),
  })),
  /** 总体判定 */
  overallVerdict: z.enum(['pass', 'conditional', 'fail']),
  completed: z.boolean(),
  giveUpReason: z.string().optional(),
});

/**
 * 角色 → schema 映射
 */
export const RESULT_SCHEMAS: Record<AgentRole, z.ZodType> = {
  researcher: ResearcherResultSchema,
  executor: ExecutorResultSchema,
  reviewer: ReviewerResultSchema,
  custom: z.object({ summary: z.string(), completed: z.boolean() }),
};

/**
 * 校验子 Agent 返回值
 */
export function validateSubAgentResult(
  role: AgentRole,
  result: unknown,
): { success: true; data: any } | { success: false; error: string } {
  const schema = RESULT_SCHEMAS[role] ?? RESULT_SCHEMAS.custom;
  const parsed = schema.safeParse(result);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return {
    success: false,
    error: `返回值 schema 校验失败：${parsed.error.message}`,
  };
}
```

### 10.4 配置接入

```typescript
// src/config/schema.ts 扩展

export const ResultSchemaConfig = z.preprocess((v) => v ?? {}, z.object({
  /** 是否启用子 Agent 结构化返回 */
  resultSchemaEnabled: z.boolean().default(false),
  /** 是否强制 finish/give_up 协议（false 时允许纯文本返回） */
  enforceFinishProtocol: z.boolean().default(false),
  /** 子 Agent 最大运行步数（超过则强制 give_up） */
  maxSubAgentSteps: z.number().int().min(5).max(200).default(50),
}));
```

### 10.5 设置页面接入

- **TabId**：扩展 `'subagents'` tab
- **控件**：
  - `resultSchemaEnabled`：Toggle 开关
  - `enforceFinishProtocol`：Toggle 开关
  - `maxSubAgentSteps`：NumberInput（5-200）

### 10.6 代码接线点

| 操作 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 新建 result-schemas.ts | `src/agents/result-schemas.ts` | — | 新文件 |
| 接入 spawn-agent | `src/tools/builtin/spawn-agent.ts` | 返回值处理 | 校验 schema |
| 接入 AgentProfile | `src/agents/profiles/types.ts` | 44-83 | 新增 resultSchema 字段 |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | subagents tab | 扩展组件 |

### 10.7 测试要求

- `validateSubAgentResult` researcher 返回值校验通过
- `validateSubAgentResult` 缺少必填字段时校验失败
- `validateSubAgentResult` completed=false 但无 giveUpReason 时失败
- `enforceFinishProtocol=true` 时纯文本返回被拒绝
- `maxSubAgentSteps` 超限时强制 give_up

---

## Task 11：Model vs Thinking——模型名与 thinking 等级分离显示（≥ 3 测试）

### 11.1 借鉴来源

**ohmypi splitModelLabel**（`src/activity.ts`）：
- `openai-codex/gpt-5.4:high` 拆为：
  - 显示模型名 `gpt-5.4`
  - 单独的 thinking 标签 `thinking high`
- 避免 `gpt-5.4:high` 被误读为模型名
- README 和 architecture.md 都强调了这个设计决策

### 11.2 RouteDev 缺口

- UI 把 `gpt-5.4:high` 当整体显示——用户可能误以为模型名包含 `:high`
- 无 thinking 等级的独立标签

### 11.3 落地设计

Task 5 已实现了 `splitModelLabel` 函数。Task 11 聚焦 UI 层接入：

```typescript
// desktop/renderer/src/components/ModelLabel.tsx（新建文件）

import React from 'react';
import { splitModelLabel } from '@routedev/agents/activity-store';

/**
 * 模型标签组件——分离显示模型名和 thinking 等级
 * 借鉴 ohmypi splitModelLabel 的设计决策
 */
export const ModelLabel: React.FC<{
  modelId: string;
  showThinkingLevel?: boolean;
  size?: 'sm' | 'md';
}> = ({ modelId, showThinkingLevel = true, size = 'sm' }) => {
  const { model, thinking } = splitModelLabel(modelId);

  return (
    <span className="model-label">
      <span className={`model-label__name model-label__name--${size}`}>
        {model}
      </span>
      {showThinkingLevel && thinking && (
        <span className={`model-label__thinking model-label__thinking--${thinking} model-label__thinking--${size}`}>
          thinking {thinking}
        </span>
      )}
    </span>
  );
};
```

### 11.4 配置接入

Task 5 的 `ActivityPanelSchema.showThinkingLevel` 已覆盖。补充：

```typescript
// 扩展 GeneralConfigSchema 或 AppearanceSchema
export const ModelDisplaySchema = z.preprocess((v) => v ?? {}, z.object({
  /** 是否在 UI 中分离显示 thinking 等级 */
  splitThinkingLabel: z.boolean().default(true),
  /** thinking 等级标签样式：'badge' | 'text' | 'icon' */
  thinkingLabelStyle: z.enum(['badge', 'text', 'icon']).default('badge'),
  /** 是否显示 provider 前缀（如 openai/gpt-5.4 中的 openai） */
  showProviderPrefix: z.boolean().default(false),
}));
```

### 11.5 设置页面接入

- **TabId**：扩展 `'appearance'` tab
- **控件**：
  - `splitThinkingLabel`：Toggle 开关
  - `thinkingLabelStyle`：RadioGroup（badge/text/icon）
  - `showProviderPrefix`：Toggle 开关

### 11.6 代码接线点

| 操作 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 新建 ModelLabel.tsx | `desktop/renderer/src/components/ModelLabel.tsx` | — | 新文件 |
| 接入消息显示 | `desktop/renderer/src/components/` 消息渲染组件 | — | 替换纯文本 modelId |
| 接入 Agent 活动面板 | `desktop/renderer/src/components/AgentActivityPanel.tsx` | — | 使用 ModelLabel |
| 设置页接入 | `desktop/renderer/src/pages/SettingsPage.tsx` | appearance tab | 扩展组件 |

### 11.7 测试要求

- `splitModelLabel` 正确分离 `gpt-5.4:high`
- `splitModelLabel` 无 thinking 等级时返回纯模型名
- `splitThinkingLabel=false` 时 UI 显示完整 `gpt-5.4:high`

---

## Task 12：集成测试与文档同步（≥ 4 测试）

### 12.1 集成测试范围

| 测试场景 | 涉及 Task | 验证点 |
|----------|-----------|--------|
| 端到端委托流程 | Task 2/3/4 | 分级判定→四维约束→独立 session→结构化返回 |
| Reviewer 分级全流程 | Task 1/7 | 风险评估→分级→跨模型→三条证据 |
| 配置三层合并 | Task 8 | default→global→project 优先级 |
| 错误受众分层 | Task 9 | user 模式不泄漏 dev 信息 |

### 12.2 文档同步

- 更新 `BLUEPRINT.md`：补充 Phase 51 的 12 个 Task 概述
- 更新 `EXECUTION_STATUS.md`：Phase 51 状态
- 更新设置页面帮助文档：新增 reviewer/subagents/activity tab 说明

### 12.3 测试要求

- 端到端委托流程测试
- Reviewer 分级全流程测试
- 配置三层合并优先级测试
- 错误受众分层隔离测试

---

## 陷阱警告（#161-#170）

**161. 委托四维约束的 maxDepth 与旧硬限制冲突：** Task 2 改造 createChildRegistry 从"物理移除 spawn_agent"改为"深度计数 + 条件注册"。`boundedDelegationEnabled=false` 时必须退回旧行为（物理移除），否则会破坏现有子 Agent 调用。新旧行为切换必须由配置开关控制，不能直接替换。

**162. Reviewer 分级可能导致审查疲劳：** Task 1 的 big/high-risk 分级会触发 2-3 轮审查（mid-work + final）。如果 tieredReviewEnabled=true 且任务规模判定为 big，审查成本会翻倍。bigTaskStepThreshold 默认值 30 要合理——太低会导致大量任务被判定为 big，太高会导致大任务审查不足。

**163. 跨模型审查可能因模型不可用而失败：** Task 7 的 autoCrossModelForHighRisk=true 时，如果 crossModelReviewerId 指定的模型不可用或未配置 API key，审查会失败。必须有 fallback——跨模型不可用时退回同模型审查 + 警告日志，而非直接失败。

**164. call-scoped overlay 的独立 session 增加内存开销：** Task 4 的 detachedSessionEnabled=true 时，每个子 Agent 创建独立 session，内存开销翻倍。subAgentMaxContextTokens 是硬上限——超过时子 Agent 必须压缩或终止，不能无限膨胀。

**165. Agent 活动面板的事件推送可能造成性能问题：** Task 5 的 ActivityStore 通过 subscribe 事件推送更新。如果子 Agent 工具调用频繁（如批量文件操作），updateActivity 会高频触发。必须有节流机制——如 100ms 内多次更新合并为一次 UI 刷新。

**166. 三层配置合并的项目级配置可能被误提交到 Git：** Task 8 的 projectConfigPath 默认 `.routedev/config.json`。如果用户在此文件中写入 API key 等敏感信息，可能误提交。必须在 `.gitignore` 模板中加入 `.routedev/config.json`，且配置加载时检测敏感字段并警告。

**167. 结构化返回 schema 可能不兼容旧子 Agent：** Task 10 的 resultSchemaEnabled=true 时，如果子 Agent 的 AgentProfile 是旧版本（无 resultSchema 字段），返回纯文本会被拒绝。必须有兼容模式——resultSchemaEnabled=false 时允许纯文本，true 时才强制 schema。

**168. 双受众错误模型的 details 字段可能泄漏内部信息：** Task 9 的 details 字段对用户可见，如果开发者误把文件路径、堆栈追踪写入 details 而非 dev，会泄漏内部信息。必须有 lint 规则或 code review 检查——details 中不应出现 `__dirname`、`process.cwd()`、`.ts` 文件路径等内部符号。

**169. 委托策略的关键词双命中可能漏判新型任务：** Task 3 的 classifyTask 依赖预定义关键词列表。如果用户用非英文描述任务（如中文"实现一个登录页面"），关键词命中可能失败。关键词列表必须支持多语言，且有 fallback——未命中时走 general 路径（主 Agent 自己做），而非直接拒绝。

**170. 三层抽象的存储键迁移风险：** Task 6 引入存储键三元组 `instanceId/harnessName/sessionName`。如果启用 threeTierAbstractionEnabled=true 后旧 session 数据的 key 格式不兼容，会导致历史会话丢失。必须有迁移脚本——旧 key `sessionName` 自动迁移为 `default/default/sessionName`。

---

## 思考引导总结

1. **两个开源项目的互补性：** Flue 提供"干净的抽象"（三层模型、call-scoped overlay、双受众错误），ohmypi 提供"务实的策略"（四维约束、三态委托、Activity Widget）。Phase 51 把两者结合——用 Flue 的抽象重构 RouteDev 的架构，用 ohmypi 的策略增强 RouteDev 的委托体系。

2. **ohmypi 的工程化弱点是 RouteDev 的改进方向：** ohmypi 的 Reviewer 分级无配置化、跨模型审查未自动触发、升级决策全靠语义判断。RouteDev 必须避免这些弱点——所有策略配置化、算法化、进设置页面。

3. **反写死原则是 Phase 51 的最高约束：** 每个 Task 的三要素（配置接入 + 设置页面 + 代码接线点）是硬性要求。任何一个 Task 缺少三要素中的任何一个，都视为未完成。

4. **软提示 + 硬拦截双层防线：** ohmypi 的前端策略证明——单靠系统提示不够，模型可能绕过。RouteDev 的委托策略必须在 tool_call 事件层有硬校验。

5. **隔离优先于共享：** Flue 的 call-scoped overlay 重构为独立子 session，证明"角色指令不注入父 history"是更干净的设计。RouteDev 的子 Agent 应走独立 session，而非共享父上下文。

6. **结构化优先于纯文本：** Flue 的 result schema 让父 Agent 程序化判断子 Agent 结果，无需 LLM 解析。RouteDev 的子 Agent 返回值应走 schema 校验。

7. **配置三层合并是工程化的必需品：** ohmypi 的 global + project + default 三层合并让不同项目有不同配置。RouteDev 当前只有单层配置，是明显的工程化缺口。

8. **双受众错误模型避免信息泄漏：** Flue 的 message + details + dev 三层结构，让用户只看到 caller-safe 信息，开发者看到完整信息。RouteDev 的错误体系应避免把内部细节泄漏给终端用户。

9. **Activity Widget 让子 Agent 的工作可见：** ohmypi 的活动面板实时显示 specialist 的 lineage/depth/工具调用，让用户知道子 Agent 在做什么。RouteDev 的 TaskMonitorPanel 是现成位置，扩展为活动面板。

10. **模型标签分离避免误读：** ohmypi 的 splitModelLabel 把 `gpt-5.4:high` 分为模型名和 thinking 等级，避免误读。RouteDev 的 UI 应采用此设计。

11. **Phase 51 是 v4.0.0 的收尾——从"功能完整"到"工程化完备"：** Phase 49（Skill 固化）+ Phase 50（死代码接入）+ Phase 51（外部开源借鉴）三步走，让 RouteDev 从"功能完整"升级为"工程化完备"。Phase 51 的核心是把外部开源的最佳实践落地为可配置、可维护、可测试的工程化能力。

12. **每个 Task 都有明确的代码接线点：** 12 个 Task 不是泛泛而谈的"借鉴方向"，而是有具体文件、行号、操作类型的工程化方案。落地时按 Task 顺序执行，每个 Task 完成后验证三要素齐备。
