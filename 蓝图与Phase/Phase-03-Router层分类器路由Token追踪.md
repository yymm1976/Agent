# Phase 3：Router 层（场景分类器 + 模型路由器 + Token 追踪）

**回应**：Phase 2 无 CONCERN（等待执行人报告）

**目标**：实现 Router 层三大核心模块——混合场景分类器（规则优先 + LLM 兜底）、模型路由器（选模型 + 降级 + 手动覆盖）、Token 追踪器（按多维度归因统计 + 预算控制）。

**蓝图参考**：第五节决策 3（混合分类器）、第六节（Router 层详细规格：6.1 分类器、6.2 路由器、6.3 Token 追踪器）、design-routedev-spec.md §1

**前置依赖**：Phase 2 的 `src/router/types.ts`、`src/router/llm/` 全部完成

---

## 具体任务

### Task 1：确认依赖

本 Phase 不需要新增依赖。TokenTracker 的每日重置使用 Node.js 原生 `setTimeout`，不引入 cron 包。

```powershell
pnpm build
pnpm typecheck
```

预期：BUILD SUCCESSFUL（无新依赖）

---

### Task 2：Token 追踪器

**文件：** 创建 `src/router/tracker.ts`

Token 追踪器负责记录所有 token 消耗，支持多维度归因（按模型/Agent/步骤/目标），检查预算是否超限，每日 0 点自动重置。

```typescript
// src/router/tracker.ts
import { logger } from '../utils/logger.js';
import type { TokenUsageInfo, TokenBudget, BudgetMode } from './types.js';

/** 单次 token 使用记录 */
export interface TokenUsageRecord {
  modelId: string;
  agentId: string;
  stepId: string;
  goalId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: number;
}

/** 日统计摘要 */
export interface DailyTokenSummary {
  date: string;
  total: number;
  byModel: Record<string, number>;
  goalCount: number;
}

/** Token 统计快照 */
export interface TokenStats {
  today: {
    total: number;
    byModel: Record<string, number>;
    byAgent: Record<string, number>;
    byStep: Record<string, number>;
    byGoal: Record<string, number>;
  };
  currentSession: {
    total: number;
    byModel: Record<string, number>;
  };
  history: DailyTokenSummary[];
}

/**
 * Token 追踪器
 * 记录所有 token 消耗，检查预算，每日自动重置
 */
export class TokenTracker {
  private budget: TokenBudget;
  private todayRecords: TokenUsageRecord[] = [];
  private sessionRecords: TokenUsageRecord[] = [];
  private history: DailyTokenSummary[] = [];
  private currentDateString: string;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(budget: TokenBudget) {
    this.budget = budget;
    this.currentDateString = this.getDateString();
    this.scheduleDailyReset();
    logger.info('TokenTracker initialized', { mode: budget.mode, dailyLimit: budget.dailyLimit });
  }

  /** 记录一次 token 消耗 */
  record(usage: TokenUsageInfo, meta: { modelId: string; agentId: string; stepId: string; goalId?: string }): void {
    const record: TokenUsageRecord = {
      modelId: meta.modelId,
      agentId: meta.agentId,
      stepId: meta.stepId,
      goalId: meta.goalId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      timestamp: Date.now(),
    };

    this.checkDateRollover();
    this.todayRecords.push(record);
    this.sessionRecords.push(record);

    logger.debug('Token usage recorded', {
      modelId: meta.modelId,
      total: usage.totalTokens,
      todayTotal: this.todayRecords.reduce((s, r) => s + r.totalTokens, 0),
    });
  }

  /** 获取当前统计快照 */
  getStats(): TokenStats {
    this.checkDateRollover();
    return {
      today: {
        total: this.todayRecords.reduce((s, r) => s + r.totalTokens, 0),
        byModel: this.groupBy(this.todayRecords, 'modelId'),
        byAgent: this.groupBy(this.todayRecords, 'agentId'),
        byStep: this.groupBy(this.todayRecords, 'stepId'),
        byGoal: this.groupBy(this.todayRecords.filter(r => r.goalId), 'goalId' as keyof TokenUsageRecord),
      },
      currentSession: {
        total: this.sessionRecords.reduce((s, r) => s + r.totalTokens, 0),
        byModel: this.groupBy(this.sessionRecords, 'modelId'),
      },
      history: [...this.history],
    };
  }

  /** 是否应该降级（日消耗超过阈值） */
  shouldDegrade(): boolean {
    if (this.budget.mode !== 'enforce') return false;
    const todayTotal = this.todayRecords.reduce((s, r) => s + r.totalTokens, 0);
    return todayTotal >= this.budget.dailyLimit * this.budget.degradationThreshold;
  }

  /** 是否超过日预算（强制停止） */
  isOverBudget(): boolean {
    if (this.budget.mode !== 'enforce') return false;
    const todayTotal = this.todayRecords.reduce((s, r) => s + r.totalTokens, 0);
    return todayTotal >= this.budget.dailyLimit;
  }

  /** 获取今日已用 token */
  getTodayTotal(): number {
    this.checkDateRollover();
    return this.todayRecords.reduce((s, r) => s + r.totalTokens, 0);
  }

  /** 重置日统计 */
  resetDaily(): void {
    // 将今天的记录压缩为摘要存入历史
    if (this.todayRecords.length > 0) {
      const summary: DailyTokenSummary = {
        date: this.currentDateString,
        total: this.todayRecords.reduce((s, r) => s + r.totalTokens, 0),
        byModel: this.groupBy(this.todayRecords, 'modelId'),
        goalCount: new Set(this.todayRecords.filter(r => r.goalId).map(r => r.goalId)).size,
      };
      this.history.push(summary);
      // 只保留最近 30 天
      if (this.history.length > 30) {
        this.history = this.history.slice(-30);
      }
    }
    this.todayRecords = [];
    this.currentDateString = this.getDateString();
    logger.info('TokenTracker daily reset');
  }

  /** 更新预算配置 */
  updateBudget(budget: TokenBudget): void {
    this.budget = budget;
  }

  /** 销毁（清理定时器） */
  destroy(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  // ===== 内部方法 =====

  private getDateString(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private checkDateRollover(): void {
    const now = this.getDateString();
    if (now !== this.currentDateString) {
      this.resetDaily();
    }
  }

  private scheduleDailyReset(): void {
    // 计算到下一个 0 点的毫秒数
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    this.resetTimer = setTimeout(() => {
      this.resetDaily();
      this.scheduleDailyReset(); // 重新调度
    }, msUntilMidnight);
  }

  private groupBy(records: TokenUsageRecord[], key: keyof TokenUsageRecord): Record<string, number> {
    const result: Record<string, number> = {};
    for (const r of records) {
      const k = String(r[key] ?? 'unknown');
      result[k] = (result[k] ?? 0) + r.totalTokens;
    }
    return result;
  }
}
```

构建验证 → 提交。

---

### Task 3：混合场景分类器

**文件：** 创建 `src/router/classifier.ts`

混合分类器：规则引擎零延迟快速分类，置信度 <0.6 时才调用 LLM 兜底。

```typescript
// src/router/classifier.ts
import type {
  ScenarioTier,
  ClassifyInput,
  ClassifyResult,
  LLMClient,
  LLMMessage,
} from './types.js';
import { TIER_WEIGHT } from './types.js';
import { logger } from '../utils/logger.js';

/** 分类器配置 */
export interface ClassifierConfig {
  /** 规则引擎置信度阈值，低于此值才调用 LLM */
  llmFallbackThreshold: number; // 默认 0.6
  /** LLM 分类使用的客户端 */
  llmClient?: LLMClient;
  /** LLM 分类使用的模型 ID */
  llmModelId?: string;
  /** 用户偏好级别（影响 baseline tier） */
  userPreference: 'saving' | 'balanced' | 'premium';
}

/** 规则匹配结果 */
interface RuleMatch {
  tier: ScenarioTier;
  confidence: number;
  reason: string;
}

/**
 * 混合场景分类器
 * 规则引擎优先（零延迟），LLM 兜底（仅在不确定时）
 */
export class ScenarioClassifier {
  private config: ClassifierConfig;

  constructor(config: ClassifierConfig) {
    this.config = config;
  }

  /** 分类用户输入 */
  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    // 1. 规则引擎快速分类
    const ruleResult = this.applyRules(input);

    logger.debug('Rule engine result', {
      tier: ruleResult.tier,
      confidence: ruleResult.confidence,
      reason: ruleResult.reason,
    });

    // 2. 置信度足够高，直接返回
    if (ruleResult.confidence >= this.config.llmFallbackThreshold) {
      return {
        tier: this.applyUserPreference(ruleResult.tier),
        confidence: ruleResult.confidence,
        reasoning: `[规则] ${ruleResult.reason}`,
      };
    }

    // 3. 置信度低，调用 LLM 兜底
    if (this.config.llmClient && this.config.llmModelId) {
      try {
        const llmResult = await this.classifyWithLLM(input);
        logger.debug('LLM classifier result', {
          tier: llmResult.tier,
          confidence: llmResult.confidence,
        });
        return {
          tier: this.applyUserPreference(llmResult.tier),
          confidence: llmResult.confidence,
          reasoning: `[LLM] ${llmResult.reasoning}`,
        };
      } catch (error) {
        // LLM 分类失败，回退到规则结果
        logger.warn('LLM classifier failed, falling back to rule result', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 4. 无 LLM 客户端或 LLM 失败，使用规则结果
    return {
      tier: this.applyUserPreference(ruleResult.tier),
      confidence: ruleResult.confidence,
      reasoning: `[规则+兜底] ${ruleResult.reason}`,
    };
  }

  // ===== 规则引擎 =====

  private applyRules(input: ClassifyInput): RuleMatch {
    const msg = input.userMessage.trim();

    // 命令匹配（最高优先级）
    if (msg.startsWith('/goal')) {
      return { tier: 'complex', confidence: 0.95, reason: '命令: /goal' };
    }
    if (msg.startsWith('/status') || msg.startsWith('/config') || msg.startsWith('/memory')) {
      return { tier: 'simple', confidence: 0.95, reason: `命令: ${msg.split(' ')[0]}` };
    }
    if (msg.startsWith('/model') || msg.startsWith('/auto') || msg.startsWith('/semi') || msg.startsWith('/manual')) {
      return { tier: 'simple', confidence: 0.95, reason: `命令: ${msg.split(' ')[0]}` };
    }
    if (msg.startsWith('/build') || msg.startsWith('/plan') || msg.startsWith('/compose')) {
      return { tier: 'simple', confidence: 0.95, reason: `命令: ${msg.split(' ')[0]}` };
    }
    if (msg.startsWith('/rollback') || msg.startsWith('/undo') || msg.startsWith('/retry')) {
      return { tier: 'simple', confidence: 0.9, reason: `命令: ${msg.split(' ')[0]}` };
    }
    if (msg.startsWith('/init')) {
      return { tier: 'complex', confidence: 0.95, reason: '命令: /init (项目分析)' };
    }
    if (msg.startsWith('/dream')) {
      return { tier: 'medium', confidence: 0.9, reason: '命令: /dream (记忆整理)' };
    }
    if (msg.startsWith('/')) {
      return { tier: 'simple', confidence: 0.85, reason: `未知命令: ${msg.split(' ')[0]}` };
    }

    // 关键词匹配
    const simpleKeywords = ['解释', '什么是', '查看', '看看', '帮我查', '怎么理解', '什么意思'];
    const mediumKeywords = ['修改', '添加', '实现', '创建', '写一个', '帮我写', '新增', '删除'];
    const complexKeywords = ['重构', '架构', '设计', '规划', '迁移', '拆分', '整合'];
    const reasoningKeywords = ['调试', '优化', '性能', '为什么', '原因', '分析', '排查', '瓶颈'];

    for (const kw of simpleKeywords) {
      if (msg.includes(kw)) {
        return { tier: 'simple', confidence: 0.7, reason: `关键词: ${kw}` };
      }
    }
    for (const kw of reasoningKeywords) {
      if (msg.includes(kw)) {
        return { tier: 'reasoning', confidence: 0.65, reason: `关键词: ${kw}` };
      }
    }
    for (const kw of complexKeywords) {
      if (msg.includes(kw)) {
        return { tier: 'complex', confidence: 0.65, reason: `关键词: ${kw}` };
      }
    }
    for (const kw of mediumKeywords) {
      if (msg.includes(kw)) {
        return { tier: 'medium', confidence: 0.6, reason: `关键词: ${kw}` };
      }
    }

    // 消息长度启发式
    if (msg.length > 500) {
      return { tier: 'medium', confidence: 0.4, reason: `消息较长(${msg.length}字)` };
    }

    // 文件引用数启发式（@引用）
    const atRefs = (msg.match(/@[\w\-./\\]+/g) || []).length;
    if (atRefs > 3) {
      return { tier: 'medium', confidence: 0.4, reason: `引用${atRefs}个文件` };
    }

    // 默认：不确定
    return { tier: 'medium', confidence: 0.3, reason: '无明确特征，默认 medium' };
  }

  /** 根据用户偏好调整 tier */
  private applyUserPreference(tier: ScenarioTier): ScenarioTier {
    // saving: 倾向降级（complex→medium, reasoning→complex）
    // premium: 倾向升级（simple→medium, medium→complex）
    // balanced: 不调整
    if (this.config.userPreference === 'saving') {
      if (tier === 'reasoning') return 'complex';
      if (tier === 'complex') return 'medium';
    } else if (this.config.userPreference === 'premium') {
      if (tier === 'simple') return 'medium';
      if (tier === 'medium') return 'complex';
    }
    return tier;
  }

  // ===== LLM 兜底分类 =====

  private async classifyWithLLM(input: ClassifyInput): Promise<ClassifyResult> {
    if (!this.config.llmClient || !this.config.llmModelId) {
      throw new Error('LLM classifier not configured');
    }

    const systemPrompt = `你是一个场景分类器。根据用户消息判断任务复杂度等级。

输出严格 JSON 格式（不要 markdown 代码块）：
{"tier": "simple|medium|complex|reasoning", "confidence": 0.0-1.0, "reasoning": "一句话理由"}

分类标准：
- simple: 简单问答、查看状态、单步操作
- medium: 需要修改文件、多步操作、需要上下文理解
- complex: 重构、架构设计、跨文件修改、目标分解
- reasoning: 调试、性能优化、根因分析、需要深度推理`;

    const userContent = `用户消息：${input.userMessage}
上下文消息数：${input.conversationContext.length}
${input.projectContext ? `项目上下文：${input.projectContext}` : ''}`;

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];

    const response = await this.config.llmClient.chat({
      model: this.config.llmModelId,
      messages,
      maxTokens: 200,
      temperature: 0,
      timeout: 5000, // 分类请求快速返回
    });

    // 解析 JSON 响应
    try {
      const text = response.content.trim();
      // 尝试提取 JSON（可能被 markdown 包裹）
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`No JSON found in response: ${text}`);
      }
      const parsed = JSON.parse(jsonMatch[0]);

      const validTiers: ScenarioTier[] = ['simple', 'medium', 'complex', 'reasoning'];
      if (!validTiers.includes(parsed.tier)) {
        throw new Error(`Invalid tier: ${parsed.tier}`);
      }

      return {
        tier: parsed.tier,
        confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5)),
        reasoning: parsed.reasoning || 'LLM 分类',
      };
    } catch (error) {
      throw new Error(`Failed to parse LLM classification: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
```

构建验证 → 提交。

---

### Task 4：模型路由器

**文件：** 创建 `src/router/router.ts`

路由器根据分类结果选择具体模型，处理降级、手动覆盖、预算检查。

```typescript
// src/router/router.ts
import type {
  ScenarioTier,
  ModelConfig,
  RouterRule,
  TokenBudget,
  RouteOptions,
  RouteDecision,
  RouterStatus,
} from './types.js';
import { TIER_WEIGHT } from './types.js';
import { TokenTracker } from './tracker.js';
import { logger } from '../utils/logger.js';

/** 路由器配置 */
export interface RouterConfig {
  rules: RouterRule[];
  budget: TokenBudget;
  models: ModelConfig[];
}

/**
 * 模型路由器
 * 根据场景等级 + 配置选择模型，处理降级和覆盖
 */
export class ModelRouter {
  private rules: RouterRule[];
  private models: Map<string, ModelConfig>;
  private tracker: TokenTracker;
  private recentDecisions: RouteDecision[] = [];
  private lastDecision: RouteDecision | null = null;

  constructor(config: RouterConfig, tracker: TokenTracker) {
    this.rules = config.rules;
    this.models = new Map(config.models.map(m => [m.id, m]));
    this.tracker = tracker;
    logger.info('ModelRouter initialized', {
      rules: config.rules.length,
      models: config.models.size ?? config.models.length,
    });
  }

  /** 根据场景等级选择模型 */
  selectModel(tier: ScenarioTier, options?: RouteOptions): RouteDecision {
    // 1. 检查预算
    if (this.tracker.isOverBudget()) {
      logger.warn('Over budget, forcing lowest tier');
      return this.forceLowestTier('日预算已耗尽');
    }

    // 2. 手动覆盖
    if (options?.forceModelId) {
      const model = this.models.get(options.forceModelId);
      if (model && model.available) {
        const decision: RouteDecision = {
          modelId: model.id,
          providerId: model.providerId,
          tier,
          isOverride: true,
          isDegraded: false,
          reason: `用户手动指定: ${model.name}`,
        };
        this.recordDecision(decision);
        return decision;
      }
      logger.warn(`Override model not available: ${options.forceModelId}`);
    }

    // 3. 查找规则匹配
    const rule = this.rules.find(r => r.tier === tier);
    if (!rule) {
      logger.warn(`No rule for tier: ${tier}, falling back to medium`);
      return this.selectModel('medium', options);
    }

    // 4. 检查默认模型是否可用
    const defaultModel = this.models.get(rule.modelId);
    if (defaultModel && defaultModel.available) {
      // 检查单次请求 token 上限
      if (rule.maxTokensPerRequest && options?.maxTokens && options.maxTokens > rule.maxTokensPerRequest) {
        logger.warn(`Request exceeds max tokens for tier ${tier}`);
      }

      // 检查是否需要降级（预算阈值）
      if (this.tracker.shouldDegrade()) {
        return this.degrade(rule, tier, '预算阈值触发降级');
      }

      const decision: RouteDecision = {
        modelId: defaultModel.id,
        providerId: defaultModel.providerId,
        tier,
        isOverride: false,
        isDegraded: false,
        reason: `规则匹配: ${tier} → ${defaultModel.name}`,
      };
      this.recordDecision(decision);
      return decision;
    }

    // 5. 默认模型不可用，尝试降级
    return this.degrade(rule, tier, `默认模型不可用: ${rule.modelId}`);
  }

  /** 手动覆盖路由 */
  override(modelId: string): RouteDecision {
    return this.selectModel('medium', { forceModelId: modelId });
  }

  /** 获取路由状态 */
  getStatus(): RouterStatus {
    const stats = this.tracker.getStats();
    return {
      currentModel: this.lastDecision?.modelId ?? 'none',
      currentTier: this.lastDecision?.tier ?? 'medium',
      isDegraded: this.lastDecision?.isDegraded ?? false,
      todayTokensUsed: stats.today.total,
      todayTokensLimit: this.tracker.getTodayTotal() > 0 ? this.budget.dailyLimit : undefined,
      recentDecisions: [...this.recentDecisions],
    };
  }

  /** 更新模型列表（模型可用性变化时调用） */
  updateModels(models: ModelConfig[]): void {
    this.models = new Map(models.map(m => [m.id, m]));
  }

  /** 更新路由规则 */
  updateRules(rules: RouterRule[]): void {
    this.rules = rules;
  }

  // ===== 内部方法 =====

  private degrade(rule: RouterRule, tier: ScenarioTier, reason: string): RouteDecision {
    // 尝试 fallback 模型
    if (rule.fallbackModelId) {
      const fallback = this.models.get(rule.fallbackModelId);
      if (fallback && fallback.available) {
        const decision: RouteDecision = {
          modelId: fallback.id,
          providerId: fallback.providerId,
          tier,
          isOverride: false,
          isDegraded: true,
          originalModelId: rule.modelId,
          reason: `${reason} → fallback: ${fallback.name}`,
        };
        this.recordDecision(decision);
        return decision;
      }
    }

    // 尝试降级到下一 tier
    const nextTier = this.getNextLowerTier(tier);
    if (nextTier) {
      logger.info(`Degrading from ${tier} to ${nextTier}`);
      return this.selectModel(nextTier);
    }

    // 已经是最低 tier，强制使用最低可用模型
    return this.forceLowestTier(reason);
  }

  private forceLowestTier(reason: string): RouteDecision {
    // 找最低 tier 中可用的模型
    const tierOrder: ScenarioTier[] = ['simple', 'medium', 'complex', 'reasoning'];
    for (const tier of tierOrder) {
      const rule = this.rules.find(r => r.tier === tier);
      if (rule) {
        const model = this.models.get(rule.modelId);
        if (model && model.available) {
          const decision: RouteDecision = {
            modelId: model.id,
            providerId: model.providerId,
            tier,
            isOverride: false,
            isDegraded: true,
            reason: `强制最低 tier: ${reason}`,
          };
          this.recordDecision(decision);
          return decision;
        }
      }
    }

    // 没有任何模型可用
    throw new Error('No models available for routing');
  }

  private getNextLowerTier(tier: ScenarioTier): ScenarioTier | null {
    const order: ScenarioTier[] = ['simple', 'medium', 'complex', 'reasoning'];
    const idx = order.indexOf(tier);
    return idx > 0 ? order[idx - 1] : null;
  }

  private recordDecision(decision: RouteDecision): void {
    this.lastDecision = decision;
    this.recentDecisions.push(decision);
    if (this.recentDecisions.length > 10) {
      this.recentDecisions = this.recentDecisions.slice(-10);
    }
  }
}
```

构建验证 → 提交。

---

### Task 5：路由配置加载（桥接 config → router）

**文件：** 创建 `src/router/config.ts`

这个模块负责将 `src/config/schema.ts` 的 Zod 配置转换为 Router 层的运行时对象。

```typescript
// src/router/config.ts
// 桥接层：将 Zod 配置转换为 Router 层的运行时对象
import type { AppConfig } from '../config/schema.js';
import type { ModelConfig, RouterRule, TokenBudget, ProviderConfig } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * 从 AppConfig 提取 Router 层需要的配置
 */
export function extractRouterConfig(config: AppConfig): {
  rules: RouterRule[];
  budget: TokenBudget;
  models: ModelConfig[];
  providers: ProviderConfig[];
  classifierModelId: string;
  userPreference: 'saving' | 'balanced' | 'premium';
} {
  // 转换路由规则
  const rules: RouterRule[] = config.router.rules.map(r => ({
    tier: r.tier,
    modelId: r.modelId,
    fallbackModelId: r.fallbackModelId,
    maxTokensPerRequest: r.maxTokensPerRequest,
  }));

  // 转换预算配置
  const budget: TokenBudget = {
    mode: config.router.budget.mode,
    dailyLimit: config.router.budget.dailyLimit,
    perRequestLimit: config.router.budget.perRequestLimit,
    degradationThreshold: config.router.budget.degradationThreshold,
  };

  // 从 providers 中提取模型列表
  const models: ModelConfig[] = [];
  const providers: ProviderConfig[] = [];

  for (const p of config.providers) {
    providers.push({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      models: [], // 模型列表从下方统一填充
    });

    // 注意：Phase 1 的 ProviderConfigSchema 没有 models 字段
    // 模型列表从路由规则中推断（每个 rule 的 modelId 对应一个模型）
  }

  // 从路由规则推断模型
  for (const rule of rules) {
    // 查找模型所属的 provider
    // 优先：从 provider.models 数组中匹配（如果配置中有定义）
    // 回退：如果只有一个 provider，直接归属（单 provider 场景）
    // TODO(Phase 6+)：配置文件应支持显式的 provider-model 映射
    let providerId = 'default';
    if (providers.length === 1) {
      providerId = providers[0].id;
    } else {
      // 多 provider：检查哪个 provider 的 models 列表包含此模型
      const matchedProvider = providers.find(p =>
        p.models.some(m => m.id === rule.modelId),
      );
      if (matchedProvider) {
        providerId = matchedProvider.id;
      } else {
        // 多 provider 但无匹配，使用第一个并记录警告
        providerId = providers[0]?.id ?? 'default';
        logger.warn(`Model ${rule.modelId} not matched to any provider, defaulting to ${providerId}`);
      }
    }

    // 默认模型
    if (!models.find(m => m.id === rule.modelId)) {
      models.push({
        id: rule.modelId,
        name: rule.modelId, // 显示名暂用 ID
        providerId,
        tier: rule.tier,
        contextWindow: 128000, // 默认上下文窗口，后续可配置
        capabilities: [],
        latencyMs: 0,
        available: true,
        fallbackModelId: rule.fallbackModelId,
      });
    }

    // fallback 模型
    if (rule.fallbackModelId && !models.find(m => m.id === rule.fallbackModelId)) {
      models.push({
        id: rule.fallbackModelId,
        name: rule.fallbackModelId,
        providerId,
        tier: rule.tier,
        contextWindow: 128000,
        capabilities: [],
        latencyMs: 0,
        available: true,
      });
    }
  }

  logger.debug('Router config extracted', {
    rules: rules.length,
    models: models.length,
    providers: providers.length,
  });

  return {
    rules,
    budget,
    models,
    providers,
    classifierModelId: config.router.classifierModel,
    userPreference: config.router.userPreference,
  };
}
```

构建验证 → 提交。

---

### Task 6：Router 层单元测试

**文件：**
- 创建 `tests/router/classifier.test.ts`
- 创建 `tests/router/router.test.ts`
- 创建 `tests/router/tracker.test.ts`

- [ ] **Step 1：TokenTracker 测试**

```typescript
// tests/router/tracker.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenTracker } from '../../src/router/tracker.js';

describe('TokenTracker', () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = new TokenTracker({
      mode: 'enforce',
      dailyLimit: 100000,
      degradationThreshold: 0.8,
    });
  });

  afterEach(() => {
    tracker.destroy();
  });

  it('should record and sum token usage', () => {
    tracker.record(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { modelId: 'test-model', agentId: 'worker-1', stepId: 'step-1' },
    );
    expect(tracker.getTodayTotal()).toBe(150);
  });

  it('should accumulate across multiple records', () => {
    tracker.record(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { modelId: 'model-a', agentId: 'worker-1', stepId: 'step-1' },
    );
    tracker.record(
      { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      { modelId: 'model-b', agentId: 'worker-2', stepId: 'step-2' },
    );
    expect(tracker.getTodayTotal()).toBe(450);
  });

  it('should not degrade when under threshold', () => {
    tracker.record(
      { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      { modelId: 'test', agentId: 'w', stepId: 's' },
    );
    expect(tracker.shouldDegrade()).toBe(false);
  });

  it('should degrade when over threshold', () => {
    // 阈值 80% of 100000 = 80000
    tracker.record(
      { inputTokens: 40000, outputTokens: 41000, totalTokens: 81000 },
      { modelId: 'test', agentId: 'w', stepId: 's' },
    );
    expect(tracker.shouldDegrade()).toBe(true);
  });

  it('should report over budget', () => {
    tracker.record(
      { inputTokens: 50000, outputTokens: 51000, totalTokens: 101000 },
      { modelId: 'test', agentId: 'w', stepId: 's' },
    );
    expect(tracker.isOverBudget()).toBe(true);
  });

  it('should return stats with breakdown', () => {
    tracker.record(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { modelId: 'model-a', agentId: 'worker-1', stepId: 'step-1' },
    );
    const stats = tracker.getStats();
    expect(stats.today.total).toBe(150);
    expect(stats.today.byModel['model-a']).toBe(150);
    expect(stats.today.byAgent['worker-1']).toBe(150);
  });

  it('should reset daily', () => {
    tracker.record(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { modelId: 'test', agentId: 'w', stepId: 's' },
    );
    tracker.resetDaily();
    expect(tracker.getTodayTotal()).toBe(0);
    expect(tracker.getStats().history.length).toBe(1);
  });

  it('track_only mode never degrades', () => {
    const trackOnly = new TokenTracker({
      mode: 'track_only',
      dailyLimit: 100,
      degradationThreshold: 0.5,
    });
    trackOnly.record(
      { inputTokens: 999, outputTokens: 999, totalTokens: 1998 },
      { modelId: 'test', agentId: 'w', stepId: 's' },
    );
    expect(trackOnly.shouldDegrade()).toBe(false);
    expect(trackOnly.isOverBudget()).toBe(false);
    trackOnly.destroy();
  });
});
```

- [ ] **Step 2：ScenarioClassifier 测试**

```typescript
// tests/router/classifier.test.ts
import { describe, it, expect } from 'vitest';
import { ScenarioClassifier } from '../../src/router/classifier.js';

describe('ScenarioClassifier', () => {
  const classifier = new ScenarioClassifier({
    llmFallbackThreshold: 0.6,
    userPreference: 'balanced',
  });

  it('should classify /goal as complex', async () => {
    const result = await classifier.classify({
      userMessage: '/goal "重构 Entry.java"',
      conversationContext: [],
    });
    expect(result.tier).toBe('complex');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('should classify /status as simple', async () => {
    const result = await classifier.classify({
      userMessage: '/status',
      conversationContext: [],
    });
    expect(result.tier).toBe('simple');
  });

  it('should classify "解释" as simple', async () => {
    const result = await classifier.classify({
      userMessage: '解释一下这个函数的作用',
      conversationContext: [],
    });
    expect(result.tier).toBe('simple');
  });

  it('should classify "重构" as complex', async () => {
    const result = await classifier.classify({
      userMessage: '帮我重构这个模块',
      conversationContext: [],
    });
    expect(result.tier).toBe('complex');
  });

  it('should classify "调试" as reasoning', async () => {
    const result = await classifier.classify({
      userMessage: '帮我调试这个性能问题',
      conversationContext: [],
    });
    expect(result.tier).toBe('reasoning');
  });

  it('should classify "修改" as medium', async () => {
    const result = await classifier.classify({
      userMessage: '修改这个文件的配置',
      conversationContext: [],
    });
    expect(result.tier).toBe('medium');
  });

  it('should default to medium for ambiguous input', async () => {
    const result = await classifier.classify({
      userMessage: 'hello',
      conversationContext: [],
    });
    expect(result.tier).toBe('medium');
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('should apply saving preference (downgrade)', async () => {
    const savingClassifier = new ScenarioClassifier({
      llmFallbackThreshold: 0.6,
      userPreference: 'saving',
    });
    const result = await savingClassifier.classify({
      userMessage: '/goal "重构整个项目"',
      conversationContext: [],
    });
    // complex → medium (saving 降级)
    expect(result.tier).toBe('medium');
  });

  it('should apply premium preference (upgrade)', async () => {
    const premiumClassifier = new ScenarioClassifier({
      llmFallbackThreshold: 0.6,
      userPreference: 'premium',
    });
    const result = await premiumClassifier.classify({
      userMessage: '查看一下状态',
      conversationContext: [],
    });
    // simple → medium (premium 升级)
    expect(result.tier).toBe('medium');
  });
});
```

- [ ] **Step 3：ModelRouter 测试**

```typescript
// tests/router/router.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { ModelRouter } from '../../src/router/router.js';
import { TokenTracker } from '../../src/router/tracker.js';
import type { ModelConfig, RouterRule, TokenBudget } from '../../src/router/types.js';

describe('ModelRouter', () => {
  const models: ModelConfig[] = [
    { id: 'flash', name: 'Flash', providerId: 'p1', tier: 'simple', contextWindow: 128000, capabilities: ['fast', 'cheap'], latencyMs: 200, available: true },
    { id: 'medium-model', name: 'Medium', providerId: 'p1', tier: 'medium', contextWindow: 128000, capabilities: ['code'], latencyMs: 500, available: true },
    { id: 'pro', name: 'Pro', providerId: 'p1', tier: 'complex', contextWindow: 128000, capabilities: ['reasoning', 'code'], latencyMs: 1000, available: true },
    { id: 'kimi', name: 'Kimi', providerId: 'p1', tier: 'reasoning', contextWindow: 128000, capabilities: ['reasoning'], latencyMs: 2000, available: true, fallbackModelId: 'deepseek-pro' },
    { id: 'deepseek-pro', name: 'DeepSeek Pro', providerId: 'p1', tier: 'reasoning', contextWindow: 128000, capabilities: ['reasoning'], latencyMs: 1500, available: true },
  ];

  const rules: RouterRule[] = [
    { tier: 'simple', modelId: 'flash' },
    { tier: 'medium', modelId: 'medium-model' },
    { tier: 'complex', modelId: 'pro' },
    { tier: 'reasoning', modelId: 'kimi', fallbackModelId: 'deepseek-pro' },
  ];

  const budget: TokenBudget = { mode: 'track_only', dailyLimit: 500000, degradationThreshold: 0.8 };

  const tracker = new TokenTracker(budget);
  const router = new ModelRouter({ rules, budget, models }, tracker);

  afterEach(() => {
    tracker.destroy();
  });

  it('should select correct model for tier', () => {
    const decision = router.selectModel('simple');
    expect(decision.modelId).toBe('flash');
    expect(decision.isOverride).toBe(false);
    expect(decision.isDegraded).toBe(false);
  });

  it('should handle manual override', () => {
    const decision = router.selectModel('simple', { forceModelId: 'pro' });
    expect(decision.modelId).toBe('pro');
    expect(decision.isOverride).toBe(true);
  });

  it('should degrade to fallback when model unavailable', () => {
    // 让 kimi 不可用
    const unavailableModels = models.map(m =>
      m.id === 'kimi' ? { ...m, available: false } : m
    );
    const degradedRouter = new ModelRouter({ rules, budget, models: unavailableModels }, tracker);
    const decision = degradedRouter.selectModel('reasoning');
    expect(decision.modelId).toBe('deepseek-pro');
    expect(decision.isDegraded).toBe(true);
    expect(decision.originalModelId).toBe('kimi');
  });

  it('should force lowest tier when over budget', () => {
    const strictTracker = new TokenTracker({ mode: 'enforce', dailyLimit: 100, degradationThreshold: 0.5 });
    strictTracker.record(
      { inputTokens: 50, outputTokens: 51, totalTokens: 101 },
      { modelId: 'test', agentId: 'w', stepId: 's' },
    );
    const strictRouter = new ModelRouter({ rules, budget: { mode: 'enforce', dailyLimit: 100, degradationThreshold: 0.5 }, models }, strictTracker);
    const decision = strictRouter.selectModel('reasoning');
    expect(decision.isDegraded).toBe(true);
    expect(decision.tier).toBe('simple');
    strictTracker.destroy();
  });

  it('should return router status', () => {
    router.selectModel('complex');
    const status = router.getStatus();
    expect(status.currentModel).toBe('pro');
    expect(status.currentTier).toBe('complex');
    expect(status.recentDecisions.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4：运行全部测试**

```powershell
pnpm test
```

预期：所有测试通过

- [ ] **Step 5：提交**

```powershell
git add tests/router/
git commit -m "test(router): add unit tests for classifier, router, and token tracker"
```

---

### Task 7：集成到 CLI 入口

**文件：** 修改 `src/index.ts`

将 Router 层集成到入口，展示完整的 配置→分类→路由→Token追踪 链路。

```typescript
// src/index.ts
#!/usr/bin/env node

import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';
import { LLMClientManager } from './router/llm/index.js';
import { TokenTracker } from './router/tracker.js';
import { ScenarioClassifier } from './router/classifier.js';
import { ModelRouter } from './router/router.js';
import { extractRouterConfig } from './router/config.js';

const VERSION = '0.3.0';

async function main(): Promise<void> {
  console.log(`RouteDev v${VERSION}`);
  console.log('---');

  try {
    // 1. 加载配置
    const config = loadConfig();
    console.log(`Providers:  ${config.providers.length} configured`);
    console.log(`Router:     ${config.router.rules.length} rules, preference=${config.router.userPreference}`);

    // 2. 初始化 LLM 客户端
    const clientManager = new LLMClientManager();
    clientManager.initializeFromConfig(
      config.providers.map(p => ({
        id: p.id,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
      })),
    );

    // 3. 提取 Router 配置
    const routerConfig = extractRouterConfig(config);

    // 4. 初始化 Token 追踪器
    const tracker = new TokenTracker(routerConfig.budget);

    // 5. 初始化分类器（如果有 LLM 客户端可用分类）
    const classifierClient = routerConfig.classifierModelId
      ? clientManager.listAll().values().next().value  // 用第一个可用的客户端
      : undefined;

    const classifier = new ScenarioClassifier({
      llmFallbackThreshold: 0.6,
      llmClient: classifierClient,
      llmModelId: routerConfig.classifierModelId,
      userPreference: routerConfig.userPreference,
    });

    // 6. 初始化路由器
    const modelRouter = new ModelRouter(
      { rules: routerConfig.rules, budget: routerConfig.budget, models: routerConfig.models },
      tracker,
    );

    // 7. 演示：分类一条消息
    const demoResult = await classifier.classify({
      userMessage: '帮我解释一下 ReAct 循环',
      conversationContext: [],
    });
    console.log(`\nDemo classification: "${demoResult.tier}" (confidence: ${demoResult.confidence})`);
    console.log(`Reasoning: ${demoResult.reasoning}`);

    // 8. 演示：路由决策
    const routeDecision = modelRouter.selectModel(demoResult.tier);
    console.log(`Route decision: ${routeDecision.modelId} (${routeDecision.reason})`);

    console.log('---');
    console.log('Router layer initialized. (CLI interface in Phase 4)');

    // 清理
    tracker.destroy();

    logger.info('RouteDev started', { version: VERSION });
  } catch (err) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
      logger.error('Startup failed', { error: err.message, stack: err.stack });
    }
    process.exit(1);
  }
}

main();
```

构建验证 → 运行验证 → 提交。

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 30 个用例）
4. TokenTracker 支持多维度归因统计 + 每日自动重置 + 预算检查
5. ScenarioClassifier 规则引擎覆盖所有命令 + 关键词 + 长度启发式
6. ModelRouter 支持降级（fallback → 降 tier → 强制最低）+ 手动覆盖
7. `pnpm start` 演示分类→路由的完整链路
8. 所有代码无 `any`

## 注意事项

- **分类器 LLM 调用**：LLM 分类的 JSON 解析要容错（可能被 markdown 代码块包裹）
- **路由器降级链**：fallback 模型 → 降 tier → 强制最低可用模型，三级降级
- **TokenTracker 定时器**：`destroy()` 必须被调用以清理 setTimeout，否则进程不会退出
- **config.ts 桥接**：当前 ProviderConfigSchema 没有 models 字段，模型从路由规则推断。后续 Phase 可能需要在配置中显式定义模型
- **Phase 1 踩坑清单**：pnpm 11 allowBuilds、TS 6 ignoreDeprecations、Zod 4 preprocess 模式

---

*Phase 3 | 蓝图 V1.0 | 预估新增文件：~6 个 | 预估修改文件：~1 个（index.ts）*
