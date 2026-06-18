# Phase 14：多 Agent 基础（Orchestrator + Worker + Blackboard）

**回应**：Phase 11-13 合并报告的已知局限

| # | 已知局限 | 处理 |
|---|---------|------|
| 1 | 渠道模式不执行工具 | Phase 14 不涉及，渠道模式暂保持直接 LLM 调用 |
| 2 | 视觉分析始终触发 | Phase 14 不涉及 |
| 3 | /goal 步骤全部串行执行 | **本 Phase 核心**：Orchestrator 分析依赖，允许无冲突步骤并行 |

---

**目标**：实现多 Agent 协作基础——Orchestrator 分析 /goal 步骤的依赖关系，将步骤分配给带角色提示的 Worker（coder/searcher/tester/reviewer），Worker 之间通过 Blackboard 共享结论，ConflictDetector 防止并行步骤修改同一文件。

**蓝图参考**：
- 第五节决策 5（单 Agent 先行，接口预留多 Agent）
- 第十节 10.2（公共黑板 Blackboard）
- 第四节文件结构（orchestrator.ts、worker.ts、conflict.ts、blackboard.ts）

**前置依赖**：Phase 9（/goal + GoalParser + executeGoalPlan）

---

## 架构说明

Phase 14 把 /goal 的"单线程流水线"升级为"团队协作"。打个比方：以前是一个人干所有活（Phase 9 的 executeGoalPlan 串行执行每个步骤），现在是来了一个项目经理（Orchestrator），把任务分给不同专长的员工（Worker），员工之间通过公共白板（Blackboard）同步信息。

```
Phase 9 的 /goal 流程（单人流水线）：
  步骤 1 → ReAct loop → 完成
  步骤 2 → ReAct loop → 完成
  步骤 3 → ReAct loop → 完成
  步骤 4 → ReAct loop → 完成

Phase 14 的 /goal 流程（团队协作）：
  Orchestrator 分析步骤依赖：
    步骤 1: "创建 auth 模块" → 无依赖 → 分配给 coder
    步骤 2: "搜索最佳实践" → 无依赖 → 分配给 searcher
    步骤 3: "编写测试" → 依赖步骤 1 → 分配给 tester
    步骤 4: "审查代码" → 依赖步骤 1,3 → 分配给 reviewer

  执行：
    [并行] 步骤 1 (coder) + 步骤 2 (searcher)
    ↓ 步骤 1 完成 → Blackboard 写入 "auth.ts 已创建"
    ↓ 步骤 2 完成 → Blackboard 写入 "搜索到 OAuth2 最佳实践"
    [串行] 步骤 3 (tester) ← 读 Blackboard 知道 auth.ts 位置
    [串行] 步骤 4 (reviewer) ← 读 Blackboard 知道所有变更

  ConflictDetector:
    如果步骤 1 和步骤 2 都要改 config.ts → 强制串行
```

**关键约束**：
- Worker 不是新进程或新线程——它们复用现有的 ReActAgentLoop，只是注入不同的角色 system prompt
- "并行"在 Node.js 单线程环境下是 Promise.all()（协作式并发），不是真正的并行线程。对于 LLM 调用（I/O 密集），这已经足够
- Blackboard 是内存数据结构（不持久化），进程退出即丢失。如需持久化，后续可序列化到 JSON
- Orchestrator 的依赖分析是 LLM 驱动的（用一次 LLM 调用分析步骤描述），不是硬编码规则
- 向后兼容：如果 Orchestrator 分析失败，fallback 到 Phase 9 的串行执行

---

## 具体任务

### Task 1：多 Agent 类型定义

**文件：** 创建 `src/agent/multi/types.ts`

定义 Orchestrator、Worker、Blackboard 的类型。

- [ ] **Step 1：创建 multi 目录 + 类型定义**

```typescript
// src/agent/multi/types.ts
// 多 Agent 协作的类型定义（Phase 14）
// 蓝图参考：第五节决策 5、第十节 10.2

import type { LLMMessage } from '../../router/types.js';

/** Worker 角色 */
export type WorkerRole = 'coder' | 'searcher' | 'tester' | 'reviewer';

/** 步骤依赖关系（Orchestrator 输出） */
export interface StepDependency {
  /** 步骤 ID（对应 GoalPlan.steps[].id） */
  stepId: number;
  /** 依赖的步骤 ID 列表 */
  dependsOn: number[];
  /** 分配的 Worker 角色 */
  assignedRole: WorkerRole;
  /** 可能涉及的文件（从步骤描述推断） */
  likelyFiles: string[];
}

/** 执行计划（Orchestrator 输出） */
export interface ExecutionPlan {
  /** 步骤依赖图 */
  dependencies: StepDependency[];
  /** 可并行的步骤组（每组内的步骤可以同时执行） */
  parallelGroups: number[][];
  /** 执行顺序（考虑依赖后的拓扑排序） */
  executionOrder: number[];
  /** Orchestrator 的分析备注 */
  analysisNotes: string;
}

/** Blackboard 条目（公共信息） */
export interface BlackboardEntry {
  /** 键 */
  key: string;
  /** 值 */
  value: string;
  /** 来源（哪个 Worker 写入的） */
  source: {
    role: WorkerRole;
    stepId: number;
  };
  /** 写入时间 */
  timestamp: number;
  /** 置信度（0-1，用户提供的信息为 1.0） */
  confidence: number;
}

/** Blackboard 快照（给 Worker 读的上下文） */
export interface BlackboardSnapshot {
  /** 当前目标 */
  currentGoal: {
    description: string;
    status: string;
  } | null;
  /** 已完成步骤的结论 */
  completedSteps: BlackboardEntry[];
  /** 项目共识（不变的事实） */
  projectFacts: BlackboardEntry[];
}

/** Worker 任务分配 */
export interface WorkerTask {
  /** 步骤 ID */
  stepId: number;
  /** 步骤描述 */
  description: string;
  /** Worker 角色 */
  role: WorkerRole;
  /** 角色特定的 system prompt 追加内容 */
  rolePrompt: string;
  /** Blackboard 快照（Worker 可读的上下文） */
  blackboardSnapshot: BlackboardSnapshot;
}

/** Worker 执行结果 */
export interface WorkerResult {
  /** 步骤 ID */
  stepId: number;
  /** 角色 */
  role: WorkerRole;
  /** 是否成功 */
  success: boolean;
  /** 结论摘要（写入 Blackboard 的内容） */
  conclusion: string;
  /** 涉及的文件 */
  modifiedFiles: string[];
  /** token 消耗 */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** 冲突检测结果 */
export interface ConflictResult {
  /** 是否有冲突 */
  hasConflict: boolean;
  /** 冲突的文件列表 */
  conflictingFiles: string[];
  /** 冲突的步骤 ID 对 */
  conflictingSteps: Array<[number, number]>;
  /** 建议（如"步骤 3 和 5 都修改 config.ts，建议串行执行"） */
  suggestion: string;
}
```

- [ ] **Step 2：提交**

```powershell
git add src/agent/multi/types.ts
git commit -m "feat(multi-agent): add type definitions for Phase 14"
```

---

### Task 2：Blackboard 公共黑板

**文件：** 创建 `src/agent/multi/blackboard.ts`

Worker 之间共享信息的内存数据结构。

- [ ] **Step 1：实现 Blackboard**

```typescript
// src/agent/multi/blackboard.ts
// 公共黑板：Worker 之间共享的任务共识信息
// 蓝图 10.2：currentGoal + completedSteps + projectFacts + version（乐观锁）

import type {
  BlackboardEntry,
  BlackboardSnapshot,
  WorkerRole,
} from './types.js';
import { logger } from '../../utils/logger.js';

export class Blackboard {
  private currentGoal: { description: string; status: string } | null = null;
  private completedSteps: BlackboardEntry[] = [];
  private projectFacts: BlackboardEntry[] = [];
  /** 乐观锁版本号 */
  private version = 0;

  /** 设置当前目标 */
  setGoal(description: string, status: string): void {
    this.currentGoal = { description, status };
    this.version++;
  }

  /** 更新目标状态 */
  updateGoalStatus(status: string): void {
    if (this.currentGoal) {
      this.currentGoal.status = status;
      this.version++;
    }
  }

  /** Worker 写入完成结论 */
  addCompletedStep(
    stepId: number,
    role: WorkerRole,
    conclusion: string,
    confidence: number = 0.8,
  ): void {
    this.completedSteps.push({
      key: `step-${stepId}`,
      value: conclusion,
      source: { role, stepId },
      timestamp: Date.now(),
      confidence,
    });
    this.version++;
    logger.debug('Blackboard: step completed', { stepId, role });
  }

  /** 添加项目共识（不变的事实） */
  addProjectFact(key: string, value: string, confidence: number = 0.9): void {
    // 如果 key 已存在，更新
    const existing = this.projectFacts.findIndex(f => f.key === key);
    if (existing >= 0) {
      this.projectFacts[existing].value = value;
      this.projectFacts[existing].confidence = confidence;
    } else {
      this.projectFacts.push({
        key,
        value,
        source: { role: 'coder', stepId: -1 },
        timestamp: Date.now(),
        confidence,
      });
    }
    this.version++;
  }

  /** 获取当前快照（给 Worker 读的只读副本） */
  getSnapshot(): BlackboardSnapshot {
    return {
      currentGoal: this.currentGoal ? { ...this.currentGoal } : null,
      completedSteps: [...this.completedSteps],
      projectFacts: [...this.projectFacts],
    };
  }

  /** 格式化为文本（注入到 Worker 的 system prompt 中） */
  formatForPrompt(): string {
    const parts: string[] = [];

    if (this.currentGoal) {
      parts.push(`当前目标: ${this.currentGoal.description} (${this.currentGoal.status})`);
    }

    if (this.completedSteps.length > 0) {
      parts.push('已完成步骤:');
      for (const step of this.completedSteps) {
        parts.push(`  - [步骤 ${step.source.stepId}] ${step.value}`);
      }
    }

    if (this.projectFacts.length > 0) {
      parts.push('项目共识:');
      for (const fact of this.projectFacts) {
        parts.push(`  - ${fact.key}: ${fact.value}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : '（黑板为空）';
  }

  /** 获取版本号 */
  getVersion(): number {
    return this.version;
  }

  /** 重置 */
  reset(): void {
    this.currentGoal = null;
    this.completedSteps = [];
    this.projectFacts = [];
    this.version = 0;
  }

  /** 条目总数 */
  get entryCount(): number {
    return this.completedSteps.length + this.projectFacts.length;
  }
}
```

- [ ] **Step 2：提交**

```powershell
git add src/agent/multi/blackboard.ts
git commit -m "feat(multi-agent): implement Blackboard for shared worker context"
```

---

### Task 3：ConflictDetector 冲突检测

**文件：** 创建 `src/agent/multi/conflict.ts`

检测并行步骤是否修改同一文件，防止冲突。

- [ ] **Step 1：实现 ConflictDetector**

```typescript
// src/agent/multi/conflict.ts
// ConflictDetector：文件访问冲突检测
// 在 Orchestrator 生成执行计划后调用，检查并行步骤是否有文件冲突
// 如果有冲突，建议将冲突步骤改为串行

import type { StepDependency, ConflictResult } from './types.js';
import { logger } from '../../utils/logger.js';

export class ConflictDetector {
  /**
   * 检测并行步骤组中的文件冲突
   * @param parallelGroup 可并行的步骤 ID 列表
   * @param dependencies 所有步骤的依赖信息
   */
  detect(
    parallelGroup: number[],
    dependencies: StepDependency[],
  ): ConflictResult {
    if (parallelGroup.length < 2) {
      return {
        hasConflict: false,
        conflictingFiles: [],
        conflictingSteps: [],
        suggestion: '',
      };
    }

    const conflictingFiles: string[] = [];
    const conflictingSteps: Array<[number, number]> = [];

    // 两两比较
    for (let i = 0; i < parallelGroup.length; i++) {
      for (let j = i + 1; j < parallelGroup.length; j++) {
        const stepA = dependencies.find(d => d.stepId === parallelGroup[i]);
        const stepB = dependencies.find(d => d.stepId === parallelGroup[j]);

        if (!stepA || !stepB) continue;

        // 找文件交集
        const commonFiles = stepA.likelyFiles.filter(f =>
          stepB.likelyFiles.includes(f),
        );

        if (commonFiles.length > 0) {
          conflictingFiles.push(...commonFiles);
          conflictingSteps.push([stepA.stepId, stepB.stepId]);
        }
      }
    }

    const uniqueFiles = [...new Set(conflictingFiles)];
    const hasConflict = uniqueFiles.length > 0;

    let suggestion = '';
    if (hasConflict) {
      const stepPairs = conflictingSteps
        .map(([a, b]) => `步骤 ${a} 和 ${b}`)
        .join('、');
      suggestion = `${stepPairs} 都修改了 ${uniqueFiles.join(', ')}，建议串行执行。`;
      logger.info('Conflict detected', {
        files: uniqueFiles,
        steps: conflictingSteps,
      });
    }

    return {
      hasConflict,
      conflictingFiles: uniqueFiles,
      conflictingSteps,
      suggestion,
    };
  }

  /**
   * 修复冲突：将有冲突的并行组拆分为串行
   * @param parallelGroups 原始并行组
   * @param dependencies 所有步骤依赖
   * @returns 修复后的并行组（冲突步骤被移到独立组）
   */
  resolveConflicts(
    parallelGroups: number[][],
    dependencies: StepDependency[],
  ): number[][] {
    const resolved: number[][] = [];

    for (const group of parallelGroups) {
      const conflict = this.detect(group, dependencies);

      if (!conflict.hasConflict) {
        resolved.push(group);
        continue;
      }

      // 有冲突：保留第一个步骤在并行组，其余移到串行组
      const conflictStepIds = new Set<number>();
      for (const [a, b] of conflict.conflictingSteps) {
        conflictStepIds.add(b); // 保留 a，将 b 串行化
      }

      const safeSteps = group.filter(id => !conflictStepIds.has(id));
      const conflictSteps = group.filter(id => conflictStepIds.has(id));

      if (safeSteps.length > 0) resolved.push(safeSteps);
      for (const stepId of conflictSteps) {
        resolved.push([stepId]); // 每个冲突步骤独立一组（串行）
      }
    }

    return resolved;
  }
}
```

- [ ] **Step 2：提交**

```powershell
git add src/agent/multi/conflict.ts
git commit -m "feat(multi-agent): implement ConflictDetector for parallel step file conflicts"
```

---

### Task 4：Orchestrator 编排器

**文件：** 创建 `src/agent/multi/orchestrator.ts`

分析 GoalPlan 的步骤依赖，生成 ExecutionPlan。

- [ ] **Step 1：实现 Orchestrator**

```typescript
// src/agent/multi/orchestrator.ts
// Orchestrator：分析 /goal 步骤的依赖关系，生成执行计划
// 蓝图：OrchestratorAgent（动态分解、冲突检测、结果汇总）
//
// 工作流程：
//   1. 接收 GoalPlan（步骤列表）
//   2. 调用 LLM 分析步骤之间的依赖关系和适合的 Worker 角色
//   3. 构建依赖图 → 拓扑排序 → 并行分组
//   4. 调用 ConflictDetector 检查文件冲突
//   5. 输出 ExecutionPlan

import type { ILLMClient } from '../../router/types.js';
import type { GoalPlan, GoalStep } from '../goal-types.js';
import type { ExecutionPlan, StepDependency, WorkerRole } from './types.js';
import { ConflictDetector } from './conflict.js';
import { logger } from '../../utils/logger.js';

/** Worker 角色的 system prompt 片段 */
export const WORKER_ROLE_PROMPTS: Record<WorkerRole, string> = {
  coder: '你是一个编码专家。专注于编写高质量、可维护的代码。遵循项目已有的代码风格。',
  searcher: '你是一个信息搜索专家。专注于搜索和整理相关的技术文档、最佳实践和参考资料。提供清晰的信息摘要。',
  tester: '你是一个测试专家。专注于编写全面的测试用例，覆盖正常路径和边界情况。确保测试可运行。',
  reviewer: '你是一个代码审查专家。专注于发现潜在的 bug、安全漏洞、性能问题和代码风格不一致。提供具体的改进建议。',
};

export class Orchestrator {
  private llmClient: ILLMClient;
  private modelId: string;
  private conflictDetector: ConflictDetector;

  constructor(llmClient: ILLMClient, modelId: string) {
    this.llmClient = llmClient;
    this.modelId = modelId;
    this.conflictDetector = new ConflictDetector();
  }

  /**
   * 分析 GoalPlan，生成 ExecutionPlan
   * 如果分析失败，fallback 到串行执行
   */
  async plan(goalPlan: GoalPlan): Promise<ExecutionPlan> {
    try {
      const analysis = await this.analyzeWithLLM(goalPlan);
      if (!analysis) {
        return this.fallbackPlan(goalPlan);
      }

      // 拓扑排序
      const executionOrder = this.topologicalSort(analysis);

      // 构建并行组
      const parallelGroups = this.buildParallelGroups(analysis, executionOrder);

      // 冲突检测与修复
      const resolvedGroups = this.conflictDetector.resolveConflicts(
        parallelGroups,
        analysis,
      );

      return {
        dependencies: analysis,
        parallelGroups: resolvedGroups,
        executionOrder,
        analysisNotes: `分析了 ${goalPlan.steps.length} 个步骤，${resolvedGroups.length} 个执行组`,
      };
    } catch (error) {
      logger.error('Orchestrator planning failed', { error: String(error) });
      return this.fallbackPlan(goalPlan);
    }
  }

  /** LLM 驱动的步骤分析 */
  private async analyzeWithLLM(goalPlan: GoalPlan): Promise<StepDependency[] | null> {
    const systemPrompt = [
      '你是一个任务编排专家。分析以下步骤之间的依赖关系，并为每个步骤分配最合适的 Worker 角色。',
      '',
      '输出 JSON 数组，每个元素：',
      '{',
      '  "stepId": 步骤序号（从 1 开始）,',
      '  "dependsOn": [依赖的步骤序号列表，无依赖则为空数组],',
      '  "assignedRole": "coder" | "searcher" | "tester" | "reviewer",',
      '  "likelyFiles": ["该步骤可能涉及的文件路径"]',
      '}',
      '',
      '角色分配原则：',
      '- coder: 编写/修改代码的步骤',
      '- searcher: 搜索信息、查阅文档的步骤',
      '- tester: 编写/运行测试的步骤',
      '- reviewer: 审查代码、检查质量的步骤',
      '',
      '只输出 JSON 数组，不要输出其他内容。',
    ].join('\n');

    const userMessage = [
      `目标: ${goalPlan.description}`,
      '',
      '步骤列表:',
      ...goalPlan.steps.map((s, i) => `  ${i + 1}. ${s.description}`),
    ].join('\n');

    const response = await this.llmClient.complete({
      model: this.modelId,
      messages: [{ role: 'user', content: userMessage }],
      systemPrompt,
      maxTokens: 1000,
      temperature: 0.2,
    });

    return this.parseAnalysis(response.content, goalPlan.steps);
  }

  private parseAnalysis(content: string, steps: GoalStep[]): StepDependency[] | null {
    try {
      const jsonStr = this.extractJson(content);
      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) return null;

      return parsed.map((item: any) => ({
        stepId: Number(item.stepId) || 1,
        dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(Number) : [],
        assignedRole: (['coder', 'searcher', 'tester', 'reviewer'].includes(item.assignedRole)
          ? item.assignedRole
          : 'coder') as WorkerRole,
        likelyFiles: Array.isArray(item.likelyFiles) ? item.likelyFiles : [],
      }));
    } catch {
      return null;
    }
  }

  private extractJson(content: string): string {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    return match ? match[1].trim() : content.trim();
  }

  /** 拓扑排序 */
  private topologicalSort(dependencies: StepDependency[]): number[] {
    const inDegree = new Map<number, number>();
    const adj = new Map<number, number[]>();

    for (const dep of dependencies) {
      inDegree.set(dep.stepId, dep.dependsOn.length);
      for (const d of dep.dependsOn) {
        if (!adj.has(d)) adj.set(d, []);
        adj.get(d)!.push(dep.stepId);
      }
    }

    const queue: number[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const order: number[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);

      for (const next of (adj.get(current) ?? [])) {
        const newDegree = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, newDegree);
        if (newDegree === 0) queue.push(next);
      }
    }

    return order;
  }

  /** 构建并行组（同一"层"的无依赖步骤可以并行） */
  private buildParallelGroups(
    dependencies: StepDependency[],
    order: number[],
  ): number[][] {
    const level = new Map<number, number>();

    for (const id of order) {
      const dep = dependencies.find(d => d.stepId === id);
      if (!dep || dep.dependsOn.length === 0) {
        level.set(id, 0);
      } else {
        const maxLevel = Math.max(...dep.dependsOn.map(d => level.get(d) ?? 0));
        level.set(id, maxLevel + 1);
      }
    }

    // 按层分组
    const groups = new Map<number, number[]>();
    for (const [id, lvl] of level) {
      if (!groups.has(lvl)) groups.set(lvl, []);
      groups.get(lvl)!.push(id);
    }

    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, ids]) => ids);
  }

  /** Fallback：全部串行执行（与 Phase 9 行为一致） */
  private fallbackPlan(goalPlan: GoalPlan): ExecutionPlan {
    const dependencies: StepDependency[] = goalPlan.steps.map((_, i) => ({
      stepId: i + 1,
      dependsOn: i > 0 ? [i] : [],
      assignedRole: 'coder' as WorkerRole,
      likelyFiles: [],
    }));

    return {
      dependencies,
      parallelGroups: goalPlan.steps.map((_, i) => [i + 1]),
      executionOrder: goalPlan.steps.map((_, i) => i + 1),
      analysisNotes: 'Fallback: LLM 分析失败，使用串行执行',
    };
  }
}
```

- [ ] **Step 2：提交**

```powershell
git add src/agent/multi/orchestrator.ts
git commit -m "feat(multi-agent): implement Orchestrator with dependency analysis and conflict detection"
```

---

### Task 5：Worker 执行器 + App.tsx 集成

**文件：**
- 创建 `src/agent/multi/worker-executor.ts`
- 修改 `src/cli/App.tsx`

Worker 执行器封装了"带角色提示的 ReAct loop 调用"。App.tsx 的 executeGoalPlan 升级为使用 Orchestrator + Worker。

- [ ] **Step 1：实现 WorkerExecutor**

```typescript
// src/agent/multi/worker-executor.ts
// WorkerExecutor：执行单个步骤，注入角色 system prompt + Blackboard 上下文
// Worker 不创建新进程——复用现有的 ReActAgentLoop

import type { ILLMClient, LLMMessage } from '../../router/types.js';
import type { RoutingResult } from '../../router/types.js';
import type { ReActAgentLoop } from '../loop.js';
import type { ToolExecutorAdapter } from '../loop-config.js';
import type { WorkerTask, WorkerResult, WorkerRole } from './types.js';
import { WORKER_ROLE_PROMPTS } from './orchestrator.js';
import { logger } from '../../utils/logger.js';

export class WorkerExecutor {
  private agentLoop: ReActAgentLoop;

  constructor(agentLoop: ReActAgentLoop) {
    this.agentLoop = agentLoop;
  }

  /**
   * 执行一个 Worker 任务
   * @returns WorkerResult（结论 + 涉及文件 + token 消耗）
   */
  async execute(
    task: WorkerTask,
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
    conversationHistory: LLMMessage[],
    baseSystemPrompt: string,
    signal?: AbortSignal,
    onConfirmTool?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>,
  ): Promise<WorkerResult> {
    // 构建角色增强的 system prompt
    const rolePrompt = task.rolePrompt || WORKER_ROLE_PROMPTS[task.role];
    const blackboardContext = this.formatBlackboard(task.blackboardSnapshot);

    const enhancedPrompt = [
      baseSystemPrompt,
      '',
      `## 你的角色: ${task.role}`,
      rolePrompt,
      '',
      `## 当前协作上下文`,
      blackboardContext,
    ].join('\n');

    let responseText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const modifiedFiles: string[] = [];

    try {
      for await (const event of this.agentLoop.run({
        userMessage: task.description,
        llmClient,
        routeDecision,
        conversationHistory,
        systemPrompt: enhancedPrompt,
        signal,
        onConfirmTool,
      })) {
        switch (event.type) {
          case 'text_delta':
            responseText += event.text;
            break;
          case 'tool_call_result':
            // 提取涉及的文件
            if (event.toolName.includes('file_') || event.toolName.includes('git_')) {
              const args = event.result;
              // 从工具结果中提取文件路径（启发式）
              const fileMatch = args.match(/[\w/.\\-]+\.\w{1,5}/);
              if (fileMatch) modifiedFiles.push(fileMatch[0]);
            }
            break;
          case 'done':
            if (event.content) responseText = event.content;
            if (event.usage) {
              inputTokens = event.usage.inputTokens;
              outputTokens = event.usage.outputTokens;
            }
            break;
        }
      }

      // 生成结论摘要（取前 200 字符）
      const conclusion = responseText.length > 200
        ? responseText.slice(0, 200) + '...'
        : responseText;

      return {
        stepId: task.stepId,
        role: task.role,
        success: true,
        conclusion,
        modifiedFiles: [...new Set(modifiedFiles)],
        tokenUsage: { inputTokens, outputTokens },
      };
    } catch (error) {
      return {
        stepId: task.stepId,
        role: task.role,
        success: false,
        conclusion: `执行失败: ${error instanceof Error ? error.message : String(error)}`,
        modifiedFiles: [],
        tokenUsage: { inputTokens, outputTokens },
      };
    }
  }

  private formatBlackboard(snapshot: WorkerTask['blackboardSnapshot']): string {
    const parts: string[] = [];

    if (snapshot.currentGoal) {
      parts.push(`目标: ${snapshot.currentGoal.description}`);
    }

    if (snapshot.completedSteps.length > 0) {
      parts.push('已完成:');
      for (const step of snapshot.completedSteps) {
        parts.push(`  - [${step.source.role}] ${step.value}`);
      }
    }

    if (snapshot.projectFacts.length > 0) {
      parts.push('已知信息:');
      for (const fact of snapshot.projectFacts) {
        parts.push(`  - ${fact.key}: ${fact.value}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : '（无上下文）';
  }
}
```

- [ ] **Step 2：修改 App.tsx 的 executeGoalPlan**

在 `executeGoalPlan` 中，在步骤执行前调用 Orchestrator 生成执行计划，然后按计划（支持并行）执行步骤：

```typescript
import { Orchestrator, WORKER_ROLE_PROMPTS } from '../agent/multi/orchestrator.js';
import { WorkerExecutor } from '../agent/multi/worker-executor.js';
import { Blackboard } from '../agent/multi/blackboard.js';

// 在 executeGoalPlan 开头（plan.status = 'executing' 之后）：

// ===== Phase 14：Orchestrator 分析 =====
const orchestrator = new Orchestrator(client, config.router.classifierModel);
const executionPlan = await orchestrator.plan(plan);

// 初始化 Blackboard
const blackboard = new Blackboard();
blackboard.setGoal(plan.description, 'executing');

setMessages(prev => [...prev, {
  id: nextId(),
  role: 'system' as const,
  content: `📋 执行计划: ${executionPlan.parallelGroups.length} 个执行组\n${executionPlan.analysisNotes}`,
}]);

// ===== Phase 14：按执行组执行（组内可并行） =====
const workerExecutor = new WorkerExecutor(agentLoopRef.current);

for (const group of executionPlan.parallelGroups) {
  // 检查 /pause
  if (abortControllerRef.current?.signal.aborted) {
    plan.status = 'failed';
    break;
  }

  if (group.length === 1) {
    // 单步骤：串行执行（与原逻辑一致）
    const stepIndex = group[0] - 1;
    const step = plan.steps[stepIndex];
    const dep = executionPlan.dependencies.find(d => d.stepId === group[0]);

    // ... 原有的单步骤执行逻辑 ...
    // 执行后写入 Blackboard
    // blackboard.addCompletedStep(group[0], dep?.assignedRole ?? 'coder', result);
  } else {
    // 多步骤：并行执行
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: `⚡ 并行执行步骤: ${group.join(', ')}`,
    }]);

    const promises = group.map(async (stepId) => {
      const stepIndex = stepId - 1;
      const step = plan.steps[stepIndex];
      const dep = executionPlan.dependencies.find(d => d.stepId === stepId);

      // 分类、路由、获取 client
      const classification = await classifier.classify({ query: step.description });
      const routeDecision = await modelRouter.route(classification);
      const llmClient = clientManager.get(routeDecision.providerId);
      if (!llmClient) return null;

      const task: WorkerTask = {
        stepId,
        description: step.description,
        role: dep?.assignedRole ?? 'coder',
        rolePrompt: WORKER_ROLE_PROMPTS[dep?.assignedRole ?? 'coder'],
        blackboardSnapshot: blackboard.getSnapshot(),
      };

      return workerExecutor.execute(
        task, llmClient, routeDecision,
        conversationHistoryRef.current,
        getSystemPrompt(config.general.language),
        abortControllerRef.current?.signal,
        handleToolConfirm,
      );
    });

    const results = await Promise.all(promises);

    // 处理并行结果
    for (const result of results) {
      if (!result) continue;
      const stepIndex = result.stepId - 1;
      plan.steps[stepIndex].status = result.success ? 'completed' : 'failed';
      plan.steps[stepIndex].result = result.conclusion;

      blackboard.addCompletedStep(
        result.stepId,
        result.role,
        result.conclusion,
      );

      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `${result.success ? '✓' : '✗'} 步骤 ${result.stepId} (${result.role}): ${result.conclusion.slice(0, 80)}...`,
      }]);
    }
  }
}

blackboard.updateGoalStatus(plan.status);
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/multi/worker-executor.ts src/cli/App.tsx
git commit -m "feat(multi-agent): integrate Orchestrator and WorkerExecutor into executeGoalPlan"
```

---

### Task 6：单元测试

**文件：**
- 创建 `tests/agent/multi/blackboard.test.ts`
- 创建 `tests/agent/multi/conflict.test.ts`
- 创建 `tests/agent/multi/orchestrator.test.ts`

- [ ] **Step 1：Blackboard 测试**

测试点：
- setGoal() → getSnapshot().currentGoal 正确
- addCompletedStep() → snapshot.completedSteps 追加
- addProjectFact() 新增 → projectFacts 追加
- addProjectFact() 已有 key → 更新
- formatForPrompt() 有数据 → 输出格式化文本
- formatForPrompt() 空 → 输出"（黑板为空）"
- getVersion() 每次写入后递增
- reset() → 全部清空

- [ ] **Step 2：ConflictDetector 测试**

测试点：
- detect() 无冲突文件 → hasConflict = false
- detect() 两个步骤都修改 config.ts → hasConflict = true
- detect() 单步骤组 → 无冲突
- resolveConflicts() 有冲突 → 冲突步骤被拆到独立组
- resolveConflicts() 无冲突 → 组不变

- [ ] **Step 3：Orchestrator 测试**

测试点（mock ILLMClient）：
- plan() LLM 成功 → 返回正确的 ExecutionPlan
- plan() LLM 失败 → fallback 到串行计划
- topologicalSort() 线性依赖 → 正确排序
- topologicalSort() 无依赖 → 全部在第 0 层
- buildParallelGroups() 混合依赖 → 正确分层
- parseAnalysis() markdown code block 包裹 → 正确解析

- [ ] **Step 4：运行全部测试 → 提交**

```powershell
pnpm test
git add tests/agent/multi/
git commit -m "test(multi-agent): add tests for Blackboard, ConflictDetector, and Orchestrator"
```

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 275 个用例，Phase 13 的 256 + Phase 14 新增 ~20）
4. Orchestrator 能分析 GoalPlan 步骤依赖并生成 ExecutionPlan
5. 无依赖的步骤可以并行执行（Promise.all）
6. ConflictDetector 检测到文件冲突后自动将冲突步骤串行化
7. Blackboard 在 Worker 之间正确共享信息
8. Worker 的 system prompt 包含角色提示和 Blackboard 快照
9. Orchestrator 分析失败时 fallback 到串行执行（向后兼容 Phase 9）
10. /goal 执行时显示执行计划信息（执行组数、分析备注）
11. /pause 在并行执行时能中断所有并行步骤

## 注意事项

- **Worker 不是新进程**：WorkerExecutor 直接调用 `agentLoop.run()`，与 Phase 9 的 executeGoalPlan 共享同一个 ReActAgentLoop 实例。"并行"是指多个 `run()` 的 Promise 并发（LLM 调用是 I/O 操作，不阻塞事件循环）
- **ReAct loop 的 signal 传递**：并行执行时，所有 Worker 共享同一个 AbortController 的 signal。`/pause` 调用 `abort()` 后，所有并行 Worker 在下次循环检查 `signal.aborted` 时退出
- **Blackboard 是内存结构**：不持久化到磁盘。进程退出后丢失。如后续需要持久化，可序列化 `getSnapshot()` 到 JSON 文件
- **Orchestrator 用 classifierModel**：步骤分析不需要高质量模型，用分类器模型（默认 deepseek-v4-flash）即可
- **WORKER_ROLE_PROMPTS**：四种角色的 system prompt 片段。追加在基础 system prompt 之后，让模型知道自己扮演什么角色
- **向后兼容**：如果 Orchestrator 的 LLM 调用失败（网络错误、模型不可用等），`fallbackPlan()` 生成与 Phase 9 完全相同的串行执行计划。用户感知不到差异
- **并行执行的 token 消耗**：并行步骤的 token 消耗分别记录在各自的 WorkerResult 中。TokenTracker 在 WorkerExecutor 外部统一记录
- **conversationHistoryRef 共享**：并行 Worker 共享同一个对话历史。这可能导致历史消息顺序不严格（两个 Worker 同时 push）。Phase 14 中简化处理——并行 Worker 不写 conversationHistoryRef，只有它们的结论写入 Blackboard
- **likelyFiles 的准确性**：Orchestrator 从步骤描述中推断可能涉及的文件。推断不一定准确，但足以检测明显的文件冲突。ConflictDetector 宁可误判（将无冲突的步骤串行化）也不漏判
- **GoalStep.id 是 number**：Phase 10 中 GoalPlan 增加了 `id: string` 字段，但 GoalStep 的 `id` 仍然是 `number`（步骤序号）。Orchestrator 使用 stepId（number）引用步骤

---

*Phase 14 | 蓝图 V1.0 | 预估新增文件：~5 个 | 预估修改文件：~1 个（App.tsx）*
