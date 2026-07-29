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

/**
 * 扩展的分类结果：支持 deterministic source 和 matchedRuleId
 * TD-13：ClassificationResult 已统一支持 deterministic 路径（tier/source/matchedRuleId），
 *        本接口现与 ClassificationResult 结构等价，保留以维持向后兼容（下游 router.ts 仍在 import）
 */
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
  /**
   * Phase 81 Task 2：三级路由简化开关（默认 true）
   * 启用后分类 tier 收敛为 simple/complex 二分（medium/reasoning → complex）
   * 关闭时回退到原始四级 tier 分类
   */
  simpleRoutingEnabled?: boolean;
  /**
   * Phase 81 Task 2：LLM 兜底分类器开关（默认 false，旁路）
   * 启用后调用 LLM 分类；旁路时跳过 LLM，直接走关键词匹配
   * 保留 classifyWithLLM 源码，通过此开关守卫，默认不调用
   */
  llmClassifierEnabled?: boolean;
}

/**
 * 混合场景分类器
 * 策略（Phase 81 Task 2 更新：三级路由简化）：
 * 1. 命令匹配（最高优先级）：/goal, /save, /status 等
 * 2. 确定性规则匹配（Phase 40 Task 2）：命中后返回 tier='deterministic'，跳过 LLM
 * 3. LLM 分类（Phase 81 Task 2：默认旁路，llmClassifierEnabled 控制启用）
 * 4. 关键词匹配（默认主分类方式）：LLM 旁路或失败时使用
 * 5. 兜底：返回 complex（保守策略）
 *
 * Phase 81 Task 2：simpleRoutingEnabled（默认 true）开启时，
 * medium/reasoning tier 收敛为 complex，仅保留 simple/complex 二分 + deterministic + override 三级路由
 */
export class ScenarioClassifier {
  private config: ClassifierConfig;

  constructor(config: ClassifierConfig) {
    this.config = config;
  }

  /**
   * Phase 81 Task 2：tier 收敛（三级路由简化）
   * simpleRoutingEnabled（默认 true）开启时，medium/reasoning → complex
   * 关闭时保持原 tier 不变（回退四级路由）
   * 参数兼容 'deterministic'（LLM 结果类型联合），但 deterministic 路径不参与收敛
   */
  private collapseTier(tier: ScenarioTier | 'deterministic'): ScenarioTier | 'deterministic' {
    // 默认启用简化；显式 false 时回退原始四级 tier
    if (this.config.simpleRoutingEnabled === false) return tier;
    // 三级路由简化：medium/reasoning 收敛为 complex，simple/deterministic 保持
    if (tier === 'medium' || tier === 'reasoning') return 'complex';
    return tier;
  }

  /**
   * 分类用户输入
   * Phase 40 Task 2：在命令匹配后插入确定性规则匹配层
   * 命中确定性规则时返回 tier='deterministic'，调用方通过判断 tier === 'deterministic' 跳过 LLM 调用
   *
   * TD-13：ClassificationResult 已统一支持 deterministic 路径（tier 联合 'deterministic'、
   *        source 联合 'deterministic'、可选 matchedRuleId），无需 as unknown as 断言
   * 返回类型保持 ClassificationResult 以兼容现有调用方
   */
  async classify(input: ClassificationInput): Promise<ClassificationResult> {
    const query = input.query.trim();
    // Phase 94：任务形状检测（一次计算，所有分支复用）
    const taskShape = this.detectTaskShape(query);

    // 1. 命令匹配
    const commandMatch = this.matchCommand(query);
    if (commandMatch) {
      // Phase 81 Task 2：命令匹配结果经 tier 收敛（medium/reasoning → complex）
      return {
        tier: this.collapseTier(commandMatch.tier),
        confidence: commandMatch.confidence,
        reasoning: commandMatch.reason,
        source: 'rule',
        taskShape,
      };
    }

    // 2. 确定性规则匹配（Phase 40 Task 2 新增）
    // 命中后直接返回 tier='deterministic'，跳过 LLM 分类
    // TD-13：ClassificationResult.tier 已扩展为 ScenarioTier | 'deterministic'，
    //        source 已扩展为 'rule' | 'llm' | 'deterministic'，无需类型断言
    // Phase 81 Task 2：deterministic 路径不参与 tier 收敛（命令派发，不调用 LLM）
    const deterministicRule = matchDeterministicRule(query);
    if (deterministicRule) {
      return {
        tier: 'deterministic',
        confidence: 1.0,
        reasoning: `Deterministic rule matched: ${deterministicRule.id}`,
        source: 'deterministic',
        matchedRuleId: deterministicRule.id,
        taskShape,
      };
    }

    // 3. LLM 分类（Phase 81 Task 2：默认旁路，llmClassifierEnabled 控制启用）
    // I7 修复：LLM 分类优先于关键词匹配，避免复杂查询被关键词误分类
    // 已移除长度启发式：用字符数量判断复杂度不可靠（"你是谁"只有3字符但需要完整回答）
    // Phase 81 Task 2：llmClassifierEnabled 默认 false，旁路 LLM 兜底分类器
    //                  保留 classifyWithLLM 源码，启用时走 LLM 分类，失败仍 fallback 到关键词
    if (this.config.llmClassifierEnabled && this.config.llmClient) {
      try {
        const llmResult = await this.classifyWithLLM(query, input.context);
        // Phase 81 Task 2：LLM 分类结果经 tier 收敛
        return { ...llmResult, tier: this.collapseTier(llmResult.tier), taskShape };
      } catch (err) {
        logger.error('LLM classification failed, falling back to keyword matching', {
          error: err instanceof Error ? err.message : String(err),
        });
        // LLM 失败时 fallback 到关键词匹配
        const keywordMatch = this.matchKeywords(query);
        if (keywordMatch) {
          return {
            tier: this.collapseTier(keywordMatch.tier),
            confidence: keywordMatch.confidence,
            reasoning: keywordMatch.reason,
            source: 'rule',
            taskShape,
          };
        }
      }
    } else {
      // 4. LLM 旁路或不可用时直接用关键词匹配作为主分类方式
      // Phase 81 Task 2：默认走此分支（llmClassifierEnabled 默认 false）
      const keywordMatch = this.matchKeywords(query);
      if (keywordMatch) {
        return {
          tier: this.collapseTier(keywordMatch.tier),
          confidence: keywordMatch.confidence,
          reasoning: keywordMatch.reason,
          source: 'rule',
          taskShape,
        };
      }
    }

    // 5. 兜底：LLM 旁路且关键词未匹配时返回 complex（保守策略：不确定时用强模型兜底）
    // Phase 81 Task 2：complex 已是收敛后目标，无需再次 collapseTier
    return {
      tier: 'complex',
      confidence: 0.3,
      reasoning: 'Fallback tier (LLM classifier bypassed, conservative strategy)',
      source: 'rule',
      taskShape,
    };
  }

  /**
   * Phase 94：任务形状检测
   *
   * 基于关键词启发式判断任务形状，驱动 spawn_agent 分发策略：
   *   - multi-step-impl：多文件实现 / 重构 / 加版本管理 / 审阅链流程 → 主 Agent 必须分发
   *   - investigation：调查 / 排查 / 为什么 / debug → 鼓励 spawn_agent(researcher)
   *   - single-step：单文件修改 / 改一行 / 加注释
   *   - qa：问答 / 解释 / 是什么
   *
   * 命中优先级：multi-step-impl > investigation > single-step > qa（保守策略）
   */
  private detectTaskShape(query: string): 'single-step' | 'multi-step-impl' | 'investigation' | 'qa' {
    const lower = query.toLowerCase();

    // 多步实现：实现 + 给 X 加 / 版本管理 / 重构 / 审阅链 / Skill 流程
    const multiStepPatterns = [
      /给\s+.+\s+(加|添加|实现)/,
      /版本管理|版本化/,
      /重构|refactor/i,
      /审阅链|审查链|review\s*chain|reviewchain/i,
      /按\s+.+\s+skill\s*(流程)?\s*(执行|跑)/i,
      /spawn_agent|spawn-agent/i,
      /多文件|多个文件/,
    ];
    if (multiStepPatterns.some(p => p.test(query) || p.test(lower))) {
      return 'multi-step-impl';
    }

    // 调查：为什么 / 排查 / 调试 / 失败 / 报错
    const investigationPatterns = [
      /为什么|排查|调试|debug/i,
      /失败|报错|挂了|不工作/,
      /为什么.*不|怎么.*不/,
    ];
    if (investigationPatterns.some(p => p.test(query) || p.test(lower))) {
      return 'investigation';
    }

    // 单步：改 / 加 / 删（短指令）
    if (/^(改|加|删|修|去掉)/.test(query) && query.length < 30) {
      return 'single-step';
    }

    // 默认：问答
    return 'qa';
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
        } catch (e) {
          // JSON 解析失败：LLM 返回的 JSON 格式错误，回退到 complex
          logger.warn('[classifier] LLM 响应 JSON 解析失败', {
            error: e instanceof Error ? e.message : String(e),
          });
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
