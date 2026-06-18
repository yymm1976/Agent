// src/router/classifier.ts
// 混合场景分类器：规则引擎 + LLM 分类
// 优先级：命令匹配 > 关键词匹配 > 长度启发式 > LLM 分类

import type { ScenarioTier, ClassificationResult, ClassificationInput } from './types.js';
import type { ILLMClient, LLMMessage } from './types.js';
import { logger } from '../utils/logger.js';

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
 * 策略：
 * 1. 命令匹配（最高优先级）：/goal, /save, /status 等
 * 2. 关键词匹配：git, npm, 文件操作等
 * 3. 长度启发式：短消息 → simple，长消息 → complex
 * 4. LLM 分类（最低优先级）：调用 LLM 判断任务复杂度
 */
export class ScenarioClassifier {
  private config: ClassifierConfig;

  constructor(config: ClassifierConfig) {
    this.config = config;
  }

  /**
   * 分类用户输入
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

    // 2. 关键词匹配
    const keywordMatch = this.matchKeywords(query);
    if (keywordMatch) {
      return {
        tier: keywordMatch.tier,
        confidence: keywordMatch.confidence,
        reasoning: keywordMatch.reason,
        source: 'rule',
      };
    }

    // 3. 长度启发式
    const lengthMatch = this.matchLength(query);
    if (lengthMatch) {
      return {
        tier: lengthMatch.tier,
        confidence: lengthMatch.confidence,
        reasoning: lengthMatch.reason,
        source: 'rule',
      };
    }

    // 4. LLM 分类
    if (this.config.llmClient) {
      try {
        return await this.classifyWithLLM(query);
      } catch (err) {
        logger.error('LLM classification failed, fallback to complex (conservative)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 29 Task 4：默认返回 complex（保守策略：不确定时用强模型兜底）
    // 原策略返回 simple 会导致复杂任务用弱模型，输出质量差
    // 保守策略宁可高估任务难度，也不低估
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

    // medium 关键词
    const mediumKeywords = ['git', 'npm', 'pnpm', 'build', 'test', 'lint', 'install'];
    for (const keyword of mediumKeywords) {
      if (lowerQuery.includes(keyword)) {
        return { tier: 'medium', confidence: 0.7, reason: `Keyword: ${keyword}` };
      }
    }

    // simple 关键词
    const simpleKeywords = ['读取', 'read', '查看', 'view', '显示', 'show', '帮助', 'help'];
    for (const keyword of simpleKeywords) {
      if (lowerQuery.includes(keyword)) {
        return { tier: 'simple', confidence: 0.7, reason: `Keyword: ${keyword}` };
      }
    }

    return null;
  }

  /**
   * 长度启发式
   */
  private matchLength(query: string): RuleMatch | null {
    const len = query.length;

    if (len < 20) {
      return { tier: 'simple', confidence: 0.6, reason: `Short query (${len} chars)` };
    }
    if (len > 500) {
      return { tier: 'complex', confidence: 0.6, reason: `Long query (${len} chars)` };
    }

    return null;
  }

  /**
   * LLM 分类
   */
  private async classifyWithLLM(query: string): Promise<ClassificationResult> {
    const systemPrompt = `你是一个任务复杂度分类器。根据用户输入判断任务属于哪个等级：
- simple: 简单查询、状态查看、短文本处理
- medium: 文件操作、命令执行、多步骤任务
- complex: 代码重构、架构设计、复杂调试
- reasoning: 深度分析、策略规划、多方案对比

只返回 JSON 格式：{"tier": "simple|medium|complex|reasoning", "confidence": 0.0-1.0, "reasoning": "判断理由"}`;

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
    // 尝试直接解析
    try {
      const parsed = JSON.parse(content);
      return {
        tier: parsed.tier || 'simple',
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || 'LLM classification',
      };
    } catch {
      // 尝试从 markdown 代码块中提取
      const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          return {
            tier: parsed.tier || 'simple',
            confidence: parsed.confidence || 0.5,
            reasoning: parsed.reasoning || 'LLM classification',
          };
        } catch {
          // 忽略
        }
      }
    }

    // 解析失败，返回默认
    return {
      tier: 'simple',
      confidence: 0.3,
      reasoning: 'Failed to parse LLM response',
    };
  }
}
