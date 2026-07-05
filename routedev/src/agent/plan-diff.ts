// src/agent/plan-diff.ts
// Plan 修订前后 diff 引擎——对比两个 GoalPlan 版本的步骤差异
// 纯逻辑，无 IO，无副作用
// 以 step.id 为 key 匹配，识别 added / removed / modified / unchanged

/**
 * Plan 步骤（diff 引擎内部表示）
 * 注：与 goal-types.ts 的 PlanStep（= GoalStep）不同——
 * 此处 id 为 string（统一 key 类型），acceptanceCriteria 为 string[]（结构化验收标准数组）
 */
export interface PlanStep {
  id: string;
  description: string;
  acceptanceCriteria?: string[];
}

/** 字段变更类型 */
export type FieldChange = 'description' | 'acceptanceCriteria';

/** 单个 modified 步骤的对比结果 */
export interface ModifiedStep {
  id: string;
  before: PlanStep;
  after: PlanStep;
  fieldChanges: FieldChange[];
}

/** 完整 diff 结果 */
export interface PlanDiff {
  added: PlanStep[];
  removed: PlanStep[];
  modified: ModifiedStep[];
  unchanged: PlanStep[];
}

/**
 * Plan diff 引擎
 * 纯函数实现，对比两个步骤列表的差异
 */
export class PlanDiffEngine {
  /**
   * 对比前后两个步骤列表
   * @param before 修订前的步骤
   * @param after  修订后的步骤
   * @returns diff 结果，包含 added/removed/modified/unchanged 四类
   */
  diff(before: PlanStep[], after: PlanStep[]): PlanDiff {
    const beforeMap = new Map<string, PlanStep>();
    for (const step of before) {
      beforeMap.set(step.id, step);
    }

    const afterMap = new Map<string, PlanStep>();
    for (const step of after) {
      afterMap.set(step.id, step);
    }

    const added: PlanStep[] = [];
    const removed: PlanStep[] = [];
    const modified: ModifiedStep[] = [];
    const unchanged: PlanStep[] = [];

    // 以 after 为主序遍历，识别 added 和 modified/unchanged
    for (const afterStep of after) {
      const beforeStep = beforeMap.get(afterStep.id);
      if (!beforeStep) {
        // after 中存在但 before 中不存在 → added
        added.push(afterStep);
        continue;
      }
      // 两边都存在，对比字段
      const fieldChanges = this.detectFieldChanges(beforeStep, afterStep);
      if (fieldChanges.length > 0) {
        modified.push({
          id: afterStep.id,
          before: beforeStep,
          after: afterStep,
          fieldChanges,
        });
      } else {
        unchanged.push(afterStep);
      }
    }

    // 识别 removed：before 中存在但 after 中不存在
    for (const beforeStep of before) {
      if (!afterMap.has(beforeStep.id)) {
        removed.push(beforeStep);
      }
    }

    return { added, removed, modified, unchanged };
  }

  /**
   * 检测单个步骤的字段变更
   * @returns 变更字段列表（空数组表示无变更）
   */
  private detectFieldChanges(before: PlanStep, after: PlanStep): FieldChange[] {
    const changes: FieldChange[] = [];

    // description 变更
    if (before.description !== after.description) {
      changes.push('description');
    }

    // acceptanceCriteria 变更（数组内容差异）
    if (!this.criteriaEqual(before.acceptanceCriteria, after.acceptanceCriteria)) {
      changes.push('acceptanceCriteria');
    }

    return changes;
  }

  /**
   * 比较两个 acceptanceCriteria 数组是否等价
   * - 同为 undefined/null 视为等价
   * - 长度不同 → 不等价
   * - 顺序敏感（验收标准的顺序通常有意义）
   */
  private criteriaEqual(
    a: string[] | undefined,
    b: string[] | undefined,
  ): boolean {
    const aArr = a ?? [];
    const bArr = b ?? [];
    if (aArr.length !== bArr.length) return false;
    for (let i = 0; i < aArr.length; i++) {
      if (aArr[i] !== bArr[i]) return false;
    }
    return true;
  }
}

/**
 * 工具函数：把任意步骤对象转换为 diff 引擎可消费的 PlanStep
 * 用于把项目内 GoalStep（id: number, acceptanceCriteria?: string）适配到 diff 引擎格式
 */
export function toDiffPlanStep(step: {
  id: number | string;
  description: string;
  acceptanceCriteria?: string;
}): PlanStep {
  // acceptanceCriteria 在项目中是单个字符串，按换行/分号拆分为数组
  let criteria: string[] | undefined;
  if (step.acceptanceCriteria && step.acceptanceCriteria.trim().length > 0) {
    criteria = step.acceptanceCriteria
      .split(/[\n;；]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (criteria.length === 0) criteria = undefined;
  }
  return {
    id: String(step.id),
    description: step.description,
    acceptanceCriteria: criteria,
  };
}
