import type { ILLMClient } from '../router/types.js';
import type { GoalPlan } from './goal-types.js';

export type DifficultyLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export interface DifficultyAssessment {
  level: DifficultyLevel;
  confidence: number;
  reasoning: string;
  suggestedPath?: 'single' | 'dag' | 'compose';
  risks: string[];
}

export const DIFFICULTY_LEVEL_DEFINITIONS: Record<DifficultyLevel, string> = {
  L1: '单步或极小改动，可由单 Agent 直接完成',
  L2: '少量步骤、低耦合，可由单 Agent 串行完成',
  L3: '多步骤或存在依赖，适合 DAG 执行',
  L4: '跨领域、多模块协作，适合组合式多 Agent',
  L5: '高风险、强不确定或架构级任务，需要研究和批判阶段',
};

export interface DifficultyAssessorOptions {
  llmClient?: ILLMClient;
  modelId?: string;
  confidenceThreshold?: number;
}

export class DifficultyAssessor {
  constructor(private readonly options: DifficultyAssessorOptions = {}) {}

  async assess(requirement: string): Promise<DifficultyAssessment> {
    if (!this.options.llmClient?.isReady()) {
      return this.fallbackAssessment(requirement);
    }
    try {
      const response = await this.options.llmClient.complete({
        model: this.options.modelId ?? 'auto',
        temperature: 0.1,
        messages: [{ role: 'user', content: this.buildPrompt(requirement) }],
      });
      const parsed = this.parseAssessmentResponse(response.content);
      if (parsed.confidence < (this.options.confidenceThreshold ?? 0.6)) {
        return this.fallbackAssessment(requirement, parsed.reasoning);
      }
      return parsed;
    } catch {
      return this.fallbackAssessment(requirement);
    }
  }

  refineAssessment(initial: DifficultyAssessment, plan: GoalPlan): DifficultyAssessment {
    const domainCount = plan.uniqueDomains?.length ?? new Set(plan.steps.map((step) => step.domain)).size;
    if (domainCount >= 3 && (initial.level === 'L1' || initial.level === 'L2' || initial.level === 'L3')) {
      return { ...initial, level: 'L4', reasoning: `${initial.reasoning}; 跨领域计划升级到 L4` };
    }
    if (plan.steps.length <= 2 && !plan.hasDependencies && domainCount <= 1 && (initial.level === 'L4' || initial.level === 'L5')) {
      return { ...initial, level: 'L2', reasoning: `${initial.reasoning}; 小型计划降级到 L2` };
    }
    return initial;
  }

  parseAssessmentResponse(response: string): DifficultyAssessment {
    const json = this.extractJson(response);
    const data = JSON.parse(json) as Partial<DifficultyAssessment>;
    const level = this.normalizeLevel(data.level);
    return {
      level,
      confidence: typeof data.confidence === 'number' ? Math.max(0, Math.min(1, data.confidence)) : 0.6,
      reasoning: data.reasoning || DIFFICULTY_LEVEL_DEFINITIONS[level],
      suggestedPath: data.suggestedPath,
      risks: Array.isArray(data.risks) ? data.risks.map(String) : [],
    };
  }

  private buildPrompt(requirement: string): string {
    return `请评估这个 /goal 任务难度，只输出 JSON：{"level":"L1|L2|L3|L4|L5","confidence":0.0-1.0,"reasoning":"...","suggestedPath":"single|dag|compose","risks":["..."]}\n难度定义：${Object.entries(DIFFICULTY_LEVEL_DEFINITIONS).map(([k, v]) => `${k}: ${v}`).join('; ')}\n任务：${requirement}`;
  }

  private extractJson(response: string): string {
    const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return (fenced?.[1] ?? response).trim();
  }

  private normalizeLevel(level: unknown): DifficultyLevel {
    return ['L1', 'L2', 'L3', 'L4', 'L5'].includes(String(level)) ? String(level) as DifficultyLevel : 'L2';
  }

  private fallbackAssessment(requirement: string, reason?: string): DifficultyAssessment {
    const lower = requirement.toLowerCase();
    const level: DifficultyLevel = /架构|重构|迁移|多模块|architecture|refactor|migration/.test(lower) ? 'L4' : 'L2';
    return {
      level,
      confidence: 0.55,
      reasoning: reason ?? 'LLM 难度评估不可用，使用启发式降级判定',
      suggestedPath: level === 'L4' ? 'compose' : 'single',
      risks: [],
    };
  }
}
