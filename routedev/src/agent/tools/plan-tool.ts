// src/agent/tools/plan-tool.ts
// Phase 71 Task E2：5 个 plan 工具（plan_get / plan_set / plan_update_step / plan_add_step / plan_remove_step）
//
// 设计：
// - 每个工具实现 ITool 接口（与项目其他工具一致，如 VfsReadTool）
// - 构造函数注入 PlanState 实例（与 loop 共享同一 VFS 实例）
// - fail-open：plan 不存在 / step 不存在时仍返回 success=true，但 output 提示无 plan
// - category: 'system'，requiresApproval: false（纯内存操作，无副作用）
//
// 严禁死代码：5 个工具均由 app-init.ts 注册到 ToolRegistry，被 LLM 调用消费。

import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../../tools/types.js';
import type { PlanState, Plan, PlanStep } from '../context/plan-state.js';

/**
 * Plan 工具基类：共享 PlanState 实例引用
 */
abstract class BasePlanTool implements ITool {
  abstract readonly definition: ToolDefinition;
  protected readonly planState: PlanState;

  constructor(planState: PlanState) {
    this.planState = planState;
  }

  abstract validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] };
  abstract execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}

/**
 * plan_get：读取当前 plan
 * 无 plan 时返回 success=true + 空字符串（fail-open，便于 LLM 判定）
 */
export class PlanGetTool extends BasePlanTool {
  readonly definition: ToolDefinition = {
    name: 'plan_get',
    description: '读取当前显式 plan 状态（JSON 字符串）。无 plan 时返回空字符串。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    requiresApproval: false,
    category: 'system',
  };

  validateArgs(): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }

  async execute(): Promise<ToolResult> {
    const plan = this.planState.getPlan();
    if (!plan) {
      return {
        success: true,
        output: '',
        durationMs: 0,
        metadata: { hasPlan: false },
      };
    }
    return {
      success: true,
      output: JSON.stringify(plan, null, 2),
      durationMs: 0,
      metadata: { hasPlan: true, stepCount: plan.steps.length },
    };
  }
}

/**
 * plan_set：写入完整 plan（覆盖式）
 * 用于初始化或重置 plan 状态。调用方需提供完整的 Plan 对象。
 */
export class PlanSetTool extends BasePlanTool {
  readonly definition: ToolDefinition = {
    name: 'plan_set',
    description: '写入完整 plan（覆盖式）。用于初始化或重置 plan 状态。参数 plan 为完整的 Plan 对象。',
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          description: 'Plan 对象（含 id/goal/steps/status/createdAt/updatedAt）',
        },
      },
      required: ['plan'],
    },
    requiresApproval: false,
    category: 'system',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.plan || typeof args.plan !== 'object') {
      errors.push('缺少必需参数: plan (对象)');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const plan = args.plan as Plan;
    this.planState.setPlan(plan);
    return {
      success: true,
      output: `已写入 plan: ${plan.id} (${plan.steps?.length ?? 0} 步骤)`,
      durationMs: 0,
    };
  }
}

/**
 * plan_update_step：更新 plan 中指定步骤的字段（部分更新）
 * plan 不存在时仍返回 success=true，output 提示无 plan（fail-open）
 */
export class PlanUpdateStepTool extends BasePlanTool {
  readonly definition: ToolDefinition = {
    name: 'plan_update_step',
    description: '更新 plan 中指定步骤的字段（部分更新，如 status/description 等）。',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: '要更新的步骤 ID' },
        update: {
          type: 'object',
          description: '要更新的字段（description/status/dependsOn/failureReason 等）',
        },
      },
      required: ['stepId', 'update'],
    },
    requiresApproval: false,
    category: 'system',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.stepId || typeof args.stepId !== 'string') {
      errors.push('缺少必需参数: stepId');
    }
    if (!args.update || typeof args.update !== 'object') {
      errors.push('缺少必需参数: update (对象)');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const stepId = args.stepId as string;
    const update = args.update as Partial<PlanStep>;
    const before = this.planState.getPlan();
    this.planState.updateStep(stepId, update);
    if (!before) {
      return {
        success: true,
        output: `无 plan，跳过 updateStep: ${stepId}`,
        durationMs: 0,
      };
    }
    return {
      success: true,
      output: `已更新步骤: ${stepId}`,
      durationMs: 0,
    };
  }
}

/**
 * plan_add_step：追加一个步骤到 plan 末尾
 * plan 不存在时仍返回 success=true，output 提示无 plan（fail-open）
 */
export class PlanAddStepTool extends BasePlanTool {
  readonly definition: ToolDefinition = {
    name: 'plan_add_step',
    description: '追加一个步骤到 plan 末尾。',
    parameters: {
      type: 'object',
      properties: {
        step: {
          type: 'object',
          description: 'PlanStep 对象（id/description/status/dependsOn/failureReason）',
        },
      },
      required: ['step'],
    },
    requiresApproval: false,
    category: 'system',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.step || typeof args.step !== 'object') {
      errors.push('缺少必需参数: step (对象)');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const step = args.step as PlanStep;
    const before = this.planState.getPlan();
    this.planState.addStep(step);
    if (!before) {
      return {
        success: true,
        output: `无 plan，跳过 addStep: ${step.id}`,
        durationMs: 0,
      };
    }
    return {
      success: true,
      output: `已追加步骤: ${step.id}`,
      durationMs: 0,
    };
  }
}

/**
 * plan_remove_step：删除 plan 中指定步骤
 * plan 或 step 不存在时仍返回 success=true（fail-open）
 */
export class PlanRemoveStepTool extends BasePlanTool {
  readonly definition: ToolDefinition = {
    name: 'plan_remove_step',
    description: '删除 plan 中指定步骤。',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: '要删除的步骤 ID' },
      },
      required: ['stepId'],
    },
    requiresApproval: false,
    category: 'system',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.stepId || typeof args.stepId !== 'string') {
      errors.push('缺少必需参数: stepId');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const stepId = args.stepId as string;
    const before = this.planState.getPlan();
    this.planState.removeStep(stepId);
    if (!before) {
      return {
        success: true,
        output: `无 plan，跳过 removeStep: ${stepId}`,
        durationMs: 0,
      };
    }
    return {
      success: true,
      output: `已删除步骤: ${stepId}`,
      durationMs: 0,
    };
  }
}
