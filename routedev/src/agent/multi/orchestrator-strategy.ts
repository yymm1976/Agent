// src/agent/multi/orchestrator-strategy.ts
// 编排策略：根据任务复杂度选择执行策略，并提供并行分组能力
//
// 解决问题：当前 Orchestrator 只用 LLM 分析依赖关系，缺少基于复杂度的
// 策略选择（简单任务串行即可，复杂任务才需要并行/自适应）。
//
// 策略类型：
//   - sequential：串行执行（简单任务）
//   - parallel：并行执行（中等任务，独立步骤多）
//   - adaptive：自适应（复杂任务，动态选择）
//
// 模式：
//   - plan_upfront：先规划后执行
//   - conversational：边对话边执行

/** 编排策略 */
export type OrchestrationStrategy = 'sequential' | 'parallel' | 'adaptive';

/** 编排模式 */
export type OrchestrationMode = 'plan_upfront' | 'conversational';

/** 编排器配置 */
export interface OrchestratorConfig {
  strategy: OrchestrationStrategy;
  mode: OrchestrationMode;
  maxParallelism: number;
  allowRetry: boolean;
  requireReview: boolean;
}

/** 默认配置 */
export const DEFAULT_CONFIG: OrchestratorConfig = {
  strategy: 'adaptive',
  mode: 'plan_upfront',
  maxParallelism: 3,
  allowRetry: true,
  requireReview: false,
};

/** 步骤依赖关系（用于策略分析） */
export interface StepWithDependencies {
  id: string;
  dependencies: string[];
}

export class StrategySelector {
  /**
   * 根据任务复杂度自动选择策略
   * - low → sequential（简单任务串行即可，避免并行开销）
   * - medium → parallel（中等任务并行加速）
   * - high → adaptive（复杂任务动态选择，兼顾依赖与并行）
   */
  static selectStrategy(complexity: 'low' | 'medium' | 'high'): OrchestrationStrategy {
    switch (complexity) {
      case 'low':
        return 'sequential';
      case 'medium':
        return 'parallel';
      case 'high':
        return 'adaptive';
      default:
        return 'adaptive';
    }
  }

  /**
   * 根据步骤依赖图判断是否可以并行
   * 如果所有步骤都没有互相依赖，可以并行
   * @param steps 步骤列表（含依赖关系）
   * @returns 是否可以并行
   */
  static canParallelize(steps: StepWithDependencies[]): boolean {
    if (steps.length <= 1) return false;

    // 统计有依赖的步骤数量
    const stepsWithDeps = steps.filter(s => s.dependencies.length > 0);
    // 如果所有步骤都有依赖 → 无法并行（纯串行链）
    // 如果有部分步骤无依赖 → 可以并行执行无依赖的部分
    return stepsWithDeps.length < steps.length;
  }

  /**
   * 获取可并行的步骤组
   * 按拓扑层级分组：同一层级的步骤可以并行执行
   *
   * 算法：
   *   1. 计算每个步骤的层级（最大依赖层级 + 1）
   *   2. 同一层级的步骤归为一组
   *   3. 按层级顺序输出
   *
   * @param steps 步骤列表（含依赖关系）
   * @returns 步骤 ID 分组（每组内可并行）
   */
  static getParallelGroups(steps: StepWithDependencies[]): string[][] {
    if (steps.length === 0) return [];

    const stepMap = new Map<string, StepWithDependencies>();
    for (const s of steps) {
      stepMap.set(s.id, s);
    }

    // 计算每个步骤的层级
    const level = new Map<string, number>();
    const visited = new Set<string>();
    const visiting = new Set<string>(); // 用于检测循环

    const computeLevel = (id: string): number => {
      if (level.has(id)) return level.get(id)!;
      if (visiting.has(id)) {
        // 循环依赖，返回 0 避免无限递归
        return 0;
      }
      visiting.add(id);

      const step = stepMap.get(id);
      if (!step || step.dependencies.length === 0) {
        level.set(id, 0);
        visited.add(id);
        visiting.delete(id);
        return 0;
      }

      const depLevels = step.dependencies
        .filter(depId => stepMap.has(depId))
        .map(depId => computeLevel(depId));

      const maxDepLevel = depLevels.length > 0 ? Math.max(...depLevels) : 0;
      const myLevel = maxDepLevel + 1;
      level.set(id, myLevel);
      visited.add(id);
      visiting.delete(id);
      return myLevel;
    };

    for (const s of steps) {
      computeLevel(s.id);
    }

    // 按层级分组
    const groups = new Map<number, string[]>();
    for (const [id, lvl] of level) {
      if (!groups.has(lvl)) groups.set(lvl, []);
      groups.get(lvl)!.push(id);
    }

    // 按层级排序输出
    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, ids]) => ids);
  }

  /**
   * 根据配置和步骤特征推荐策略
   * 综合 maxParallelism 和步骤数量给出建议
   */
  static recommendConfig(
    complexity: 'low' | 'medium' | 'high',
    stepCount: number,
  ): OrchestratorConfig {
    const strategy = StrategySelector.selectStrategy(complexity);

    // 根据步骤数量调整并行度
    let maxParallelism = DEFAULT_CONFIG.maxParallelism;
    if (complexity === 'low') {
      maxParallelism = 1; // 简单任务串行
    } else if (complexity === 'high' && stepCount > 10) {
      maxParallelism = 5; // 复杂任务提高并行度
    }

    // 复杂任务需要审查
    const requireReview = complexity === 'high';

    return {
      strategy,
      mode: complexity === 'high' ? 'conversational' : 'plan_upfront',
      maxParallelism,
      allowRetry: true,
      requireReview,
    };
  }
}
