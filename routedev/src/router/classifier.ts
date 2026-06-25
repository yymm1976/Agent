// src/router/classifier.ts
// 混合场景分类器：规则引擎 + LLM 分类
// 优先级：命令匹配 > 确定性规则匹配 > LLM 分类 > 关键词匹配（仅作 LLM 不可用时的 fallback）
// I7 修复：原顺序为 命令 > 关键词 > LLM，导致复杂查询被关键词误分类
//          改为 LLM 分类优先，关键词匹配仅作为 LLM 不可用/失败时的 fallback
// Phase 40 Task 2：在命令匹配与 LLM 分类之间插入"确定性规则匹配"层，
//                  命中后返回 tier='deterministic'，跳过 LLM 调用

import type { ScenarioTier, ClassificationResult, ClassificationInput, ClassificationContext } from './types.js';
import type { ILLMClient, LLMMessage } from './types.js';
import { logger } from '../utils/logger.js';
import { matchDeterministicRule } from './deterministic-rules.js';

// Phase 40 Task 2：扩展 ScenarioTier，新增 'deterministic' 级别
// 由于 schema.ts 的 ScenarioTierSchema 无法修改，这里通过联合类型扩展
export type DeterministicTier = 'deterministic';
export type ExtendedScenarioTier = ScenarioTier | DeterministicTier;

/** 扩展的分类结果：支持 deterministic source 和 matchedRuleId */
export interface DeterministicClassificationResult
  extends Omit<ClassificationResult, 'tier' | 'source'> {
  tier: ExtendedScenarioTier;
  source: 'rule' | 'llm' | 'deterministic';
  /** deterministic 命中时携带的规则 ID，供路由层透传 */
  matchedRuleId?: string;
}

/** 规则匹配结果 */
interface RuleMatch {
  tier: ScenarioTier;
  confidence: number;
  reason: string;
}

/** 分类器配置 */
export interface ClassifierConfig {
  llmClient?: ILLMClient;
  classifierModel: string;
}

/**
 * 混合场景分类器
 * 策略（Phase 40 Task 2 更新）：
 * 1. 命令匹配（最高优先级）：/goal, /save, /status 等
 * 2. 确定性规则匹配（Phase 40 Task 2 新增）：命中后返回 tier='deterministic'，跳过 LLM
 * 3. LLM 分类（主要分类方式）：调用路由模型判断任务复杂度
 * 4. 关键词匹配（fallback）：LLM 不可用或失败时使用
 * 5. 兜底：返回 complex（保守策略）
 */
export class ScenarioClassifier {
  private config: ClassifierConfig;

  constructor(config: ClassifierConfig) {
    this.config = config;
  }

  /**
   * 分类用户输入
   * Phase 40 Task 2：在命令匹配后插入确定性规则匹配层
   * 命中确定性规则时返回 tier='deterministic'（通过类型断言，因为 schema.ts 的
   * ScenarioTier 无法修改），调用方通过判断 tier === 'deterministic' 跳过 LLM 调用
   *
   * 返回类型保持 ClassificationResult 以兼容现有调用方，
   * deterministic 结果通过类型断言返回（tier/source/matchedRuleId 字段在运行时存在）
   */
  async classify(input: ClassificationInput): Promise<ClassificationResult> {
    const query = input.query.trim();

    // 1. 命令匹配
    const commandMatch = this.matchCommand(query);
    if (commandMatch) {
      return {
        tier: commandMatch.tier,
        confidence: commandMatch.confidence,
        reasoning: commandMatch.reason,
        source: 'rule',
      };
    }

    // 2. 确定性规则匹配（Phase 40 Task 2 新增）
    // 命中后直接返回 tier='deterministic'，跳过 LLM 分类
    // 通过类型断言返回，因为 'deterministic' 不在 schema.ts 的 ScenarioTier 枚举中
    const deterministicRule = matchDeterministicRule(query);
    if (deterministicRule) {
      return {
        tier: 'deterministic',
        confidence: 1.0,
        reasoning: `Deterministic rule matched: ${deterministicRule.id}`,
        source: 'deterministic',
        matchedRuleId: deterministicRule.id,
      } as unknown as ClassificationResult;
    }

    // 3. LLM 分类（主要分类方式）
    // I7 修复：LLM 分类优先于关键词匹配，避免复杂查询被关键词误分类
    // 已移除长度启发式：用字符数量判断复杂度不可靠（"你是谁"只有3字符但需要完整回答）
    if (this.config.llmClient) {
      try {
        return await this.classifyWithLLM(query, input.context);
      } catch (err) {
        logger.error('LLM classification failed, falling back to keyword matching', {
          error: err instanceof Error ? err.message : String(err),
        });
        // LLM 失败时 fallback 到关键词匹配
        const keywordMatch = this.matchKeywords(query);
        if (keywordMatch) {
          return {
            tier: keywordMatch.tier,
            confidence: keywordMatch.confidence,
            reasoning: keywordMatch.reason,
            source: 'rule',
          };
        }
      }
    } else {
      // 4. LLM 不可用时直接用关键词匹配作为 fallback
      const keywordMatch = this.matchKeywords(query);
      if (keywordMatch) {
        return {
          tier: keywordMatch.tier,
          confidence: keywordMatch.confidence,
          reasoning: keywordMatch.reason,
          source: 'rule',
        };
      }
    }

    // 5. 兜底：LLM 不可用且关键词未匹配时返回 complex（保守策略：不确定时用强模型兜底）
    return {
      tier: 'complex',
      confidence: 0.3,
      reasoning: 'Fallback tier (LLM classifier unavailable, conservative strategy)',
      source: 'rule',
    };
  }

  /**
   * 命令匹配
   */
  private matchCommand(query: string): RuleMatch | null {
    const commands: Array<{ pattern: RegExp; tier: ScenarioTier; reason: string }> = [
      { pattern: /^\/(goal|status|help|version|config)/i, tier: 'simple', reason: 'Simple command' },
      { pattern: /^\/(save|load|resume)/i, tier: 'medium', reason: 'State management command' },
      { pattern: /^\/(verify|checkpoint)/i, tier: 'complex', reason: 'Verification command' },
    ];

    for (const cmd of commands) {
      if (cmd.pattern.test(query)) {
        return { tier: cmd.tier, confidence: 0.95, reason: cmd.reason };
      }
    }
    return null;
  }

  /**
   * 关键词匹配
   */
  private matchKeywords(query: string): RuleMatch | null {
    const lowerQuery = query.toLowerCase();

    // reasoning 关键词
    const reasoningKeywords = ['分析', 'architecture', '设计', 'strategy', '复杂', 'complex', 'debug', '排查'];
    for (const keyword of reasoningKeywords) {
      if (lowerQuery.includes(keyword)) {
        return { tier: 'reasoning', confidence: 0.8, reason: `Keyword: ${keyword}` };
      }
    }

    // complex 关键词
    const complexKeywords = ['重构', 'refactor', '优化', 'optimize', 'review', '审查', '实现', 'implement'];
    for (const keyword of complexKeywords) {
      if (lowerQuery.includes(keyword)) {
        return { tier: 'complex', confidence: 0.75, reason: `Keyword: ${keyword}` };
      }
    }

    // medium 关键词（使用词边界匹配，避免子串误匹配如 "what is git" 误判为 medium）
    // \b 确保匹配完整单词而非子串；支持关键词出现在句首、句中、句尾
    const mediumKeywords = ['git', 'npm', 'pnpm', 'yarn', 'build', 'test', 'lint', 'install'];
    for (const keyword of mediumKeywords) {
      const re = new RegExp(`\\b${keyword}\\b`, 'i');
      if (re.test(lowerQuery)) {
        return { tier: 'medium', confidence: 0.7, reason: `Keyword: ${keyword}` };
      }
    }

    // simple 关键词
    const simpleKeywords = [
      '读取', 'read', '查看', 'view', '显示', 'show', '帮助', 'help',
      '你是谁', '你是', '自我介绍', '你好', 'hello', 'hi', '谢谢', 'thanks',
      '是什么', '什么', '怎么', '如何', '为什么', '哪里', '哪个',
      'who', 'what', 'where', 'when', 'why', 'how',
    ];
    for (const keyword of simpleKeywords) {
      if (lowerQuery.includes(keyword)) {
        return { tier: 'simple', confidence: 0.7, reason: `Keyword: ${keyword}` };
      }
    }

    return null;
  }

  /**
   * LLM 分类
   * Phase 32 Task 4.6：接受可选的上下文信息，在 prompt 中提供给 LLM 以提高分类准确率
   */
  private async classifyWithLLM(query: string, context?: ClassificationContext): Promise<ClassificationResult> {
    let systemPrompt = `你是一个任务复杂度分类器。根据用户输入判断任务属于哪个等级：
- simple: 简单查询、状态查看、短文本处理
- medium: 文件操作、命令执行、多步骤任务
- complex: 代码重构、架构设计、复杂调试
- reasoning: 深度分析、策略规划、多方案对比

只返回 JSON 格式：{"tier": "simple|medium|complex|reasoning", "confidence": 0.0-1.0, "reasoning": "判断理由"}`;

    // Phase 32 Task 4.6：将上下文信息附加到 prompt，帮助 LLM 做出更准确的判断
    if (context) {
      const contextParts: string[] = [];
      if (context.projectType) contextParts.push(`项目类型: ${context.projectType}`);
      if (context.recentTools?.length) contextParts.push(`最近工具: ${context.recentTools.join(', ')}`);
      if (context.hasGitChanges !== undefined) contextParts.push(`Git 有未提交更改: ${context.hasGitChanges}`);
      if (contextParts.length > 0) {
        systemPrompt += `\n\n当前项目上下文：\n${contextParts.join('\n')}`;
      }
    }

    const messages: LLMMessage[] = [
      { role: 'user', content: query },
    ];

    const response = await this.config.llmClient!.complete({
      model: this.config.classifierModel,
      messages,
      systemPrompt,
      maxTokens: 200,
      temperature: 0,
    });

    // 解析 JSON 响应
    const result = this.parseLLMResponse(response.content);
    return {
      tier: result.tier,
      confidence: result.confidence,
      reasoning: result.reasoning,
      source: 'llm',
    };
  }

  /**
   * 解析 LLM 响应
   */
  private parseLLMResponse(content: string): { tier: ScenarioTier; confidence: number; reasoning: string } {
    // 修复：合法的 tier 枚举值，用于校验 LLM 返回的 tier 字段
    const validTiers = ['simple', 'medium', 'complex', 'reasoning'];
    // 尝试直接解析
    try {
      const parsed = JSON.parse(content);
      // 修复：校验 tier 枚举，非法值回退到 'simple'
      const rawTier = parsed.tier || 'simple';
      const tier = validTiers.includes(rawTier) ? rawTier : 'simple';
      return {
        tier,
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || 'LLM classification',
      };
    } catch {
      // 尝试从 markdown 代码块中提取
      const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          // 修复：校验 tier 枚举，非法值回退到 'simple'
          const rawTier = parsed.tier || 'simple';
          const tier = validTiers.includes(rawTier) ? rawTier : 'simple';
          return {
            tier,
            confidence: parsed.confidence || 0.5,
            reasoning: parsed.reasoning || 'LLM classification',
          };
        } catch {
          // 忽略
        }
      }
    }

    // I14 修复：解析失败回退到 complex（保守策略），与 classify() 中 LLM 不可用时的回退一致
    // 原 simple 回退会导致复杂任务用弱模型，输出质量差
    return {
      tier: 'complex',
      confidence: 0.3,
      reasoning: 'Failed to parse LLM response, conservative fallback',
    };
  }
}
