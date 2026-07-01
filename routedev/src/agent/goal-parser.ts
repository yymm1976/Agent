// src/agent/goal-parser.ts
// /goal 命令的目标分解器
// 用 LLM 把用户输入的目标描述拆成可执行的步骤列表
// Phase 31 Task 3：新增可选 requirements 参数，将需求摘要注入 LLM prompt

import type { ILLMClient, LLMMessage, LLMRequestOptions, RoutingResult, TokenUsageInfo } from '../router/types.js';
import type { Domain, GoalPlan, GoalStep } from './goal-types.js';
import type { RequirementsSummary } from './task-orchestrator-types.js';
import { logger } from '../utils/logger.js';
import crypto from 'node:crypto';
// Phase 53 Task 10：DAG 引擎（type-only import，避免运行时循环依赖）
import type { DagEngine } from './workflow/dag-engine.js';

// Phase 55：合法 domain 取值列表（与 goal-types.ts 的 Domain 类型保持一致，单一数据源）
const VALID_DOMAINS: readonly Domain[] = ['frontend', 'backend', 'config', 'docs', 'database', 'infra', 'test', 'general'];

const PARSER_SYSTEM_PROMPT = `你是 RouteDev 的目标分解助手。请把用户输入的目标拆分为可执行的步骤列表。

要求：
1. 步骤数：3-8 步（如果目标很简单，可以 1-2 步）
2. 步骤描述：使用祈使句，简洁明确（如 "读取 package.json"、"运行 pnpm test"）
3. 步骤之间通过 dependencies 字段显式声明依赖关系（空数组表示无依赖，可并行执行）
4. 如果用户提供了验证条件，请严格遵守
5. 每个步骤必须提供具体可验证的验收标准（Phase 54 Task 3）
   - 禁止"功能正常工作"这种空泛表述
   - 必须包含可检查的具体条件（如"命令能执行并输出 X"、"测试覆盖 Y"、"文件存在于 Z 路径"）
6. 每个步骤必须标注 suggestedRole（建议的子 Agent 角色）：
   - "researcher"：调研、搜索、收集资料、分析现状（只读）
   - "executor"：编写代码、修改文件、执行命令、运行测试（写操作）
   - "reviewer"：审查、验证、检查代码质量、确认验收标准（只读审查）
7. 每个步骤必须标注 domain（所属领域），用于 ExecutionRouter 路径判定

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
- domain：步骤所属领域，必须是以下枚举之一：frontend / backend / config / docs / database / infra / test / general`;

// Phase 31 Task 3：当传入 RequirementsSummary 时追加的需求上下文区块
const REQUIREMENTS_CONTEXT_TEMPLATE = (r: RequirementsSummary) => `

<requirements_context>
已知需求摘要（请在分解步骤时严格遵守）：
- 目标：${r.goal}
- 范围：${r.scope.join('、') || '未指定'}
- 约束：${r.constraints.join('；') || '无'}
- 验收标准：${r.acceptanceCriteria.join('；') || '无'}
- 预估复杂度：${r.estimatedComplexity}
</requirements_context>`;

interface GoalParserOptions {
  /** 验证条件（可空） */
  verificationCriteria?: string;
  /** 路由决策（用于选定 LLM） */
  routeDecision: RoutingResult;
  /** LLM 客户端 */
  llmClient: ILLMClient;
  /** 确认超时（毫秒） */
  timeoutMs?: number;
  /** Phase 31 Task 3：需求摘要，注入 prompt 让 LLM 在已知需求下分解任务 */
  requirements?: RequirementsSummary;
}

export class GoalParser {
  async parse(
    description: string,
    options: GoalParserOptions,
  ): Promise<GoalPlan> {
    const { verificationCriteria, routeDecision, llmClient, timeoutMs = 30000, requirements } = options;

    // Phase 31 Task 3：若有需求摘要，追加到 system prompt
    const systemPrompt = requirements
      ? PARSER_SYSTEM_PROMPT + REQUIREMENTS_CONTEXT_TEMPLATE(requirements)
      : PARSER_SYSTEM_PROMPT;

    logger.debug('GoalParser invoking LLM', {
      model: routeDecision.model.id,
      description: description.slice(0, 50),
      hasRequirements: !!requirements,
    });

    // Phase 54：步骤校验 + 重试循环
    // 校验失败时携带反馈重试，最多 maxRetries 次；耗尽后用 fillAcceptanceCriteria 兜底
    const maxRetries = 2;
    let lastPlan: GoalPlan | null = null;
    let lastReasons: string[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 首次正常构造 user message；重试时附加上次校验失败的原因，要求 LLM 修正
      const feedback = attempt > 0 && lastReasons.length > 0
        ? `\n\n上次分解存在以下问题，请修正后重新输出：\n${lastReasons.map(r => `- ${r}`).join('\n')}`
        : '';
      const userMessage = (verificationCriteria
        ? `目标: ${description}\n验证条件: ${verificationCriteria}`
        : `目标: ${description}`) + feedback;
      const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];

      const requestOptions: LLMRequestOptions = {
        model: routeDecision.model.id,
        messages,
        systemPrompt,
        maxTokens: 2000,
        timeoutMs,
        stream: false,
      };

      const response = await llmClient.complete(requestOptions);
      const { plan, fromJson } = await this.parseAndBuildPlan(
        description, verificationCriteria, response.content, response.usage, llmClient, routeDecision.model.id,
      );
      lastPlan = plan;

      // JSON 解析失败的单步兜底计划不参与校验/重试（LLM 未返回有效 JSON，重试无意义）
      if (!fromJson) {
        this.fillDerivedFields(plan);
        return plan;
      }

      // Phase 54：步骤校验
      const validation = this.validatePlan(plan.steps);
      if (validation.valid) {
        this.fillDerivedFields(plan);
        return plan;
      }

      lastReasons = validation.reasons;
      logger.warn('GoalParser 校验失败', { attempt: attempt + 1, maxRetries: maxRetries + 1, reasons: lastReasons });

      if (attempt === maxRetries) {
        // Phase 54 修复：重试耗尽后做兜底修复——
        // 1) 截断超限步骤（保留前 15 个，重排 id）
        // 2) 去重（Jaccard 相似度 >0.7 的步骤保留首个）
        // 3) 补全缺失的验收标准
        // 原缺陷：只调用 fillAcceptanceCriteria，不修复步骤数超限和重复问题
        logger.warn('GoalParser 重试耗尽，执行兜底修复（截断+去重+补全验收标准）', { reasons: lastReasons, originalStepCount: plan.steps.length });
        plan.steps = this.sanitizeSteps(plan.steps);
        await this.fillAcceptanceCriteria(plan, llmClient, routeDecision.model.id);
        this.fillDerivedFields(plan);
        return plan;
      }
    }

    // 理论上不会到达（for 循环已覆盖所有路径），防御性兜底
    if (lastPlan) {
      this.fillDerivedFields(lastPlan);
    }
    return lastPlan!;
  }

  /**
   * Phase 55：填充 GoalPlan 的推导字段（uniqueDomains 和 hasDependencies）
   * 在 parse() 的所有返回路径调用，确保 ExecutionRouter 拿到完整的推导数据
   */
  private fillDerivedFields(plan: GoalPlan): void {
    plan.uniqueDomains = [...new Set(plan.steps.map(s => s.domain))];
    plan.hasDependencies = plan.steps.some(s => s.dependencies.length > 0);
  }

  /**
   * Phase 54：校验步骤列表质量
   * - 步骤数上限：≤ 15 步（过多说明拆分粒度不合理）
   * - 重复检测：步骤描述 Jaccard 相似度 > 0.7 视为重复
   * - 验收标准非空：每个步骤必须有可验证的 acceptanceCriteria
   * @returns valid=true 通过；valid=false 时 reasons 列出所有问题
   */
  private validatePlan(steps: GoalStep[]): { valid: boolean; reasons: string[] } {
    const reasons: string[] = [];

    // 1. 步骤数上限
    const MAX_STEPS = 15;
    if (steps.length > MAX_STEPS) {
      reasons.push(`步骤数 ${steps.length} 超过上限 ${MAX_STEPS}，请合并相关步骤`);
    }

    // 2. 重复检测（Jaccard 相似度）
    const SIMILARITY_THRESHOLD = 0.7;
    for (let i = 0; i < steps.length; i++) {
      for (let j = i + 1; j < steps.length; j++) {
        const sim = jaccardSimilarity(steps[i].description, steps[j].description);
        if (sim > SIMILARITY_THRESHOLD) {
          reasons.push(`步骤 ${steps[i].id} 与步骤 ${steps[j].id} 描述过于相似（相似度 ${sim.toFixed(2)}），请合并或区分`);
        }
      }
    }

    // 3. 验收标准非空校验
    const missingCriteria = steps.filter(s => !s.acceptanceCriteria || s.acceptanceCriteria.trim().length === 0);
    if (missingCriteria.length > 0) {
      reasons.push(`以下步骤缺少验收标准：${missingCriteria.map(s => `#${s.id}`).join('、')}（每个步骤必须有具体可验证的验收标准）`);
    }

    // 4. Phase 55：依赖图无环校验（拓扑排序检测）
    if (hasCycle(steps)) {
      reasons.push('步骤依赖关系存在环，请检查 dependencies 字段');
    }

    // 5. Phase 55：domain 非空校验
    for (const step of steps) {
      if (!step.domain || !(VALID_DOMAINS as readonly string[]).includes(step.domain)) {
        reasons.push(`步骤 ${step.id} 的 domain 字段无效（${step.domain ?? '空'}），必须是 ${VALID_DOMAINS.join('/')} 之一`);
      }
    }

    return { valid: reasons.length === 0, reasons };
  }

  /**
   * Phase 54 修复：兜底清理步骤列表——截断超限 + 去重
   * 重试耗尽后调用，确保返回的 plan 不会因步骤数超限或重复阻塞后续流程
   * @returns 清理后的 steps（id 从 1 重排，dependencies 按新 id 重建）
   */
  private sanitizeSteps(steps: GoalStep[]): GoalStep[] {
    const MAX_STEPS = 15;
    const SIMILARITY_THRESHOLD = 0.7;

    // 1. 去重：Jaccard 相似度 >0.7 的步骤保留首个
    const deduped: GoalStep[] = [];
    for (const step of steps) {
      const isDuplicate = deduped.some(kept => jaccardSimilarity(step.description, kept.description) > SIMILARITY_THRESHOLD);
      if (!isDuplicate) deduped.push(step);
    }

    // 2. 截断：保留前 MAX_STEPS 个
    const truncated = deduped.slice(0, MAX_STEPS);

    // 3. 重排 id 和 dependencies（截断/去重后原 id 可能不连续）
    // Phase 55：基于原始依赖关系映射新 id，保留 LLM 输出的依赖结构（不再强制线性）
    const idMap = new Map<number, number>();
    truncated.forEach((step, i) => idMap.set(step.id, i + 1));
    const remapped = truncated.map((step, i) => ({
      ...step,
      id: i + 1,
      dependencies: step.dependencies
        .map(depId => idMap.get(depId))
        .filter((depId): depId is number => depId !== undefined && depId < i + 1),
    }));

    // 4. Phase 55：依赖图有环时断环（移除构成环的边）
    const acyclicSteps = breakCycles(remapped);

    // 5. Phase 55：domain 缺失时填充 'general'
    return acyclicSteps.map(step => ({
      ...step,
      domain: step.domain || 'general',
    }));
  }

  /**
   * 解析 LLM 响应并构建 GoalPlan
   * @returns plan + fromJson 标志（fromJson=true 表示从有效 JSON 解析；false 表示单步兜底）
   * Phase 54：fromJson 供 parse() 决定是否参与校验/重试——单步兜底不参与重试
   */
  private async parseAndBuildPlan(
    description: string,
    verificationCriteria: string | undefined,
    content: string,
    _usage: TokenUsageInfo,
    llmClient?: ILLMClient,
    modelId?: string,
  ): Promise<{ plan: GoalPlan; fromJson: boolean }> {
    const jsonStr = this.extractJson(content);
    if (!jsonStr) {
      logger.warn('GoalParser: no JSON found in LLM response, creating single-step plan', { content });
      const plan: GoalPlan = {
        id: this.generateId(),
        description,
        verificationCriteria,
        steps: [{
          id: 1,
          description,
          status: 'pending',
          dependencies: [],
          domain: 'general',  // Phase 55：单步兜底无 LLM 输出，固定为 general
        }],
        status: 'pending',
        createdAt: Date.now(),
      };
      // 单步兜底计划直接补全验收标准（不参与 parse() 的校验/重试）
      await this.fillAcceptanceCriteria(plan, llmClient, modelId);
      return { plan, fromJson: false };
    }

    try {
      const parsed = JSON.parse(jsonStr) as { steps: Array<{ id: number; description: string; acceptanceCriteria?: string; suggestedRole?: string; dependencies?: unknown; domain?: unknown }> };

      if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        throw new Error('steps 数组为空或无效');
      }

      const steps: GoalStep[] = parsed.steps.map((s, idx) => {
        // Phase 54：校验 suggestedRole 取值，无效值忽略（回退到 orchestrator 启发式推断）
        const validRoles = ['researcher', 'executor', 'reviewer'] as const;
        const suggestedRole = s.suggestedRole && validRoles.includes(s.suggestedRole as typeof validRoles[number])
          ? (s.suggestedRole as typeof validRoles[number])
          : undefined;
        // Phase 55：解析 LLM 输出的 dependencies（非数组时兜底为空数组）
        const rawDeps = Array.isArray(s.dependencies) ? s.dependencies : [];
        const dependencies = rawDeps.filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
        // Phase 55：解析 LLM 输出的 domain（非法或缺失时兜底为 'general'）
        const domain: Domain = typeof s.domain === 'string' && (VALID_DOMAINS as readonly string[]).includes(s.domain)
          ? (s.domain as Domain)
          : 'general';
        return {
          id: s.id ?? idx + 1,
          description: s.description,
          status: 'pending' as const,
          dependencies,
          acceptanceCriteria: s.acceptanceCriteria,  // Phase 54 Task 3：解析 LLM 输出的验收标准
          suggestedRole,  // Phase 54：解析 LLM 输出的建议角色
          domain,  // Phase 55：解析 LLM 输出的领域
        };
      });

      const plan: GoalPlan = {
        id: this.generateId(),
        description,
        verificationCriteria,
        steps,
        status: 'pending',
        createdAt: Date.now(),
      };
      // Phase 54：成功路径不再调用 fillAcceptanceCriteria——
      // 缺失验收标准由 parse() 的校验循环捕获并重试，重试耗尽后才在 parse() 中兜底补全
      return { plan, fromJson: true };
    } catch (error) {
      logger.error('GoalParser: failed to parse JSON, falling back to single-step plan', {
        error: error instanceof Error ? error.message : String(error),
        jsonStr: jsonStr.slice(0, 200),
      });

      const plan: GoalPlan = {
        id: this.generateId(),
        description,
        verificationCriteria,
        steps: [{
          id: 1,
          description,
          status: 'pending',
          dependencies: [],
          domain: 'general',  // Phase 55：单步兜底无 LLM 输出，固定为 general
        }],
        status: 'pending',
        createdAt: Date.now(),
      };
      // 单步兜底计划直接补全验收标准（不参与 parse() 的校验/重试）
      await this.fillAcceptanceCriteria(plan, llmClient, modelId);
      return { plan, fromJson: false };
    }
  }

  /**
   * Phase 54 Task 3：为缺失验收标准的步骤生成具体可验证的验收标准
   * - LLM 输出可能不包含 acceptanceCriteria 字段，需补全
   * - 强制具体化，防止"功能正常工作"这种空泛表述
   * - fail-open：LLM 调用失败时跳过，不阻塞 parse 流程
   */
  private async fillAcceptanceCriteria(
    plan: GoalPlan,
    llmClient?: ILLMClient,
    modelId?: string,
  ): Promise<void> {
    const missingSteps = plan.steps.filter(s => !s.acceptanceCriteria || s.acceptanceCriteria.trim().length === 0);
    if (missingSteps.length === 0) return;
    if (!llmClient || !modelId) {
      // 无 LLM 客户端时用简单兜底（基于步骤描述生成）
      for (const step of missingSteps) {
        step.acceptanceCriteria = `步骤完成：${step.description}`;
      }
      return;
    }

    const prompt = `为以下步骤生成具体可验证的验收标准（禁止"功能正常工作"这种空泛表述）：
目标：${plan.description}
${missingSteps.map(s => `步骤${s.id}：${s.description}`).join('\n')}

要求：每个验收标准必须包含可检查的具体条件（如"命令能执行并输出 X"、"测试覆盖 Y"、"文件存在于 Z 路径"）。
输出 JSON 数组，每个元素：{ "stepId": 数字, "acceptanceCriteria": "具体标准" }`;

    try {
      const response = await llmClient.complete({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1000,
        temperature: 0.2,
      });
      const jsonStr = this.extractJson(response.content);
      if (!jsonStr) {
        throw new Error('LLM 响应中未找到 JSON，触发兜底逻辑');
      }
      const parsed = JSON.parse(jsonStr) as Array<{ stepId: number; acceptanceCriteria: string }>;
      for (const item of parsed) {
        const step = plan.steps.find(s => s.id === item.stepId);
        if (step && item.acceptanceCriteria) {
          step.acceptanceCriteria = item.acceptanceCriteria;
        }
      }
    } catch (error) {
      logger.warn('GoalParser.fillAcceptanceCriteria failed (non-blocking, using fallback)', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 兜底：用步骤描述生成
      for (const step of missingSteps) {
        if (!step.acceptanceCriteria) {
          step.acceptanceCriteria = `步骤完成：${step.description}`;
        }
      }
    }
  }

  /** 从 LLM 响应中提取 JSON（处理 markdown 代码块） */
  private extractJson(content: string): string | null {
    // 尝试提取 ```json ... ``` 代码块
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // 尝试找第一个 { 到最后一个 } 的内容
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return content.slice(firstBrace, lastBrace + 1);
    }

    return null;
  }

  private generateId(): string {
    return crypto.randomUUID().slice(0, 8);
  }
}

/**
 * Phase 54：计算两个文本的 Jaccard 相似度（基于字符级 bigram）
 * 用于步骤描述重复检测——纯文本处理，不调用 LLM
 * @returns 0-1 之间的相似度值（1 表示完全相同）
 */
function jaccardSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  // 字符级 bigram 集合
  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));

  // 交集大小
  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  // 并集大小 = |A| + |B| - |A∩B|
  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Phase 55：检测步骤依赖图是否存在环（Kahn 算法拓扑排序）
 * 若排序后已处理节点数 < 总节点数，则存在环（含自环）
 * @returns true 表示有环
 */
function hasCycle(steps: GoalStep[]): boolean {
  const n = steps.length;
  if (n === 0) return false;

  // id → 索引映射（dependencies 存的是 id，需转成索引建图）
  const idToIndex = new Map<number, number>();
  steps.forEach((s, i) => idToIndex.set(s.id, i));

  // 入度表 + 邻接表：依赖边 depIdx → idx（被依赖节点指向依赖节点）
  const inDegree = new Array<number>(n).fill(0);
  const adj: number[][] = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    for (const depId of steps[i].dependencies) {
      const depIdx = idToIndex.get(depId);
      if (depIdx !== undefined) {
        adj[depIdx].push(i);
        inDegree[i]++;
      }
    }
  }

  // Kahn 拓扑排序：入度为 0 的节点入队，处理后邻居入度 -1
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  let sorted = 0;
  while (queue.length > 0) {
    const idx = queue.shift()!;
    sorted++;
    for (const next of adj[idx]) {
      inDegree[next]--;
      if (inDegree[next] === 0) queue.push(next);
    }
  }

  return sorted < n;
}

/**
 * Phase 55：移除依赖图中构成环的边（DFS 检测回边并移除）
 * 节点颜色：WHITE 未访问 / GRAY 在当前 DFS 栈中 / BLACK 已完成
 * 遇到 GRAY 的依赖节点即为回边（环），移除该依赖
 * @returns 新的 steps 数组（不修改入参），依赖图保证无环
 */
function breakCycles(steps: GoalStep[]): GoalStep[] {
  const n = steps.length;
  if (n === 0) return steps;

  const idToIndex = new Map<number, number>();
  steps.forEach((s, i) => idToIndex.set(s.id, i));

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Array<number>(n).fill(WHITE);
  // 深拷贝 dependencies，避免修改入参
  const result: GoalStep[] = steps.map(s => ({ ...s, dependencies: [...s.dependencies] }));

  const dfs = (idx: number): void => {
    color[idx] = GRAY;
    const newDeps: number[] = [];
    for (const depId of result[idx].dependencies) {
      const depIdx = idToIndex.get(depId);
      if (depIdx === undefined) {
        continue;  // 无效依赖 id，移除
      }
      if (color[depIdx] === GRAY) {
        continue;  // 回边 → 环，移除该依赖边
      }
      newDeps.push(depId);
      if (color[depIdx] === WHITE) {
        dfs(depIdx);
      }
    }
    result[idx].dependencies = newDeps;
    color[idx] = BLACK;
  };

  for (let i = 0; i < n; i++) {
    if (color[i] === WHITE) {
      dfs(i);
    }
  }

  return result;
}
