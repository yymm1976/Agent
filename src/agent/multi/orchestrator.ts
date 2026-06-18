// src/agent/multi/orchestrator.ts
// Orchestrator：分析 /goal 步骤的依赖关系，生成执行计划

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

const VALID_ROLES: WorkerRole[] = ['coder', 'searcher', 'tester', 'reviewer'];

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
      if (!analysis || analysis.length === 0) {
        return this.fallbackPlan(goalPlan);
      }

      const executionOrder = this.topologicalSort(analysis);
      const parallelGroups = this.buildParallelGroups(analysis, executionOrder);
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
      if (!Array.isArray(parsed) || parsed.length === 0) return null;

      const result: StepDependency[] = [];
      for (let i = 0; i < steps.length; i++) {
        const item = parsed.find((p: any) => Number(p.stepId) === i + 1) ?? parsed[i];
        if (!item) {
          result.push({
            stepId: i + 1,
            dependsOn: i > 0 ? [i] : [],
            assignedRole: 'coder',
            likelyFiles: [],
          });
          continue;
        }
        result.push({
          stepId: i + 1,
          dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(Number) : [],
          assignedRole: VALID_ROLES.includes(item.assignedRole) ? item.assignedRole : 'coder',
          likelyFiles: Array.isArray(item.likelyFiles) ? item.likelyFiles : [],
        });
      }
      return result;
    } catch {
      return null;
    }
  }

  private extractJson(content: string): string {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    return match ? match[1].trim() : content.trim();
  }

  /** 拓扑排序（Kahn 算法） */
  topologicalSort(dependencies: StepDependency[]): number[] {
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

    // 处理循环依赖（fallback：追加未访问节点）
    if (order.length < dependencies.length) {
      for (const dep of dependencies) {
        if (!order.includes(dep.stepId)) order.push(dep.stepId);
      }
    }

    return order;
  }

  /** 构建并行组 */
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
        const maxLevel = Math.max(
          ...dep.dependsOn.map(d => level.get(d) ?? 0),
        );
        level.set(id, maxLevel + 1);
      }
    }

    const groups = new Map<number, number[]>();
    for (const [id, lvl] of level) {
      if (!groups.has(lvl)) groups.set(lvl, []);
      groups.get(lvl)!.push(id);
    }

    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, ids]) => ids);
  }

  /** Fallback：全部串行执行 */
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
      analysisNotes: 'Fallback: LLM 分析失败或不可用，使用串行执行',
    };
  }
}