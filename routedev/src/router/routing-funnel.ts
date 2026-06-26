// src/router/routing-funnel.ts
// Phase 49 Task 6.2：意图路由四层漏斗
//
// 知识库原文：
//   "意图路由四层漏斗：L0 正则(<1ms, 拦截 60-80%) → L1 向量语义(30-100ms, 拦截 15-25%)
//    → L2 大模型(1-2s, 仅 5-15%) → SafeNet(置信度+OOD+熔断, <3%)。"
//   "效果：延迟降至全 LLM 方案的 1/3，成本降至 1/4。"
//
// 四条铁律（知识库）：
//   1. 规则优先模型兜底——能用正则/向量解决的不调大模型
//   2. 意图用枚举不用自由文本——避免 LLM 返回任意字符串导致下游解析失败
//   3. 低置信度反问不瞎猜——confidence < 阈值时标记 needsClarification 让 AI 反问用户
//   4. 上线第一天就埋监控——每层命中/未命中/耗时全部记录日志（由调用方聚合到 OnlineMonitor）
//
// 陷阱 #146：SafeNet 的熔断可能导致服务不可用
//   - 连续低置信度 > 5 次触发熔断
//   - 熔断期间所有请求回退到默认模型
//   - 5 分钟冷却期后自动恢复
//   - 熔断期间向用户显示"路由系统降级运行"提示

import { logger } from '../utils/logger.js';
import {
  matchDeterministicRule,
  type DeterministicRule,
} from './deterministic-rules.js';
import type { ScenarioTier } from './types.js';

// ============================================================
// 类型定义
// ============================================================

/** 路由来源（标注由哪一层命中） */
export type RoutingSource =
  | 'l0-regex' // L0 正则命中
  | 'l1-vector' // L1 向量语义命中
  | 'llm' // L2 大模型命中
  | 'safe-net'; // SafeNet 兜底

/** 路由结果（漏斗内部使用的精简结构，与 router/types.ts 的 RoutingResult 不同） */
export interface RoutingResult {
  /** 命中的场景等级（safe-net 时为兜底等级） */
  tier: ScenarioTier;
  /** 置信度 0~1，safe-net 兜底时为 0 */
  confidence: number;
  /** 命中来源层 */
  source: RoutingSource;
  /** 选中的模型（safe-net 兜底时为 {id:'unknown', provider:'safe-net'}） */
  model?: {
    id: string;
    provider: string;
  };
  /** 原始等级（safe-net 覆盖前 LLM 给出的等级，便于审计） */
  originalTier?: ScenarioTier;
  /** 是否需要向用户澄清（低置信度时为 true） */
  needsClarification?: boolean;
  /** 命中的 L0 规则 ID（仅 source='l0-regex' 时存在） */
  matchedRuleId?: string;
  /** 是否处于熔断降级状态 */
  circuitBreakerActive?: boolean;
}

/** L1 向量语义路由器接口（依赖注入，可选） */
export interface VectorRouter {
  /** 用 embedding + 余弦相似度匹配意图，返回结果或 null（未命中） */
  route(input: string): Promise<RoutingResult | null>;
}

/** L2 LLM 分类器接口（依赖注入） */
export interface LLMClassifier {
  /** 调用大模型分类，返回结果 */
  classify(input: string): Promise<RoutingResult>;
}

/** 漏斗配置 */
export interface RoutingFunnelConfig {
  /** L0 规则表（默认用内置规则） */
  l0Rules?: DeterministicRule[];
  /** L1 向量路由器（不传则跳过 L1） */
  vectorRouter?: VectorRouter;
  /** L2 LLM 分类器（必传） */
  llmClassifier: LLMClassifier;
  /** 兜底模型（熔断期间使用） */
  fallbackModel: { id: string; provider: string };
  /** 兜底等级（熔断/safe-net 时使用，默认 'complex' 保守策略） */
  fallbackTier?: ScenarioTier;
  /** L0 命中阈值（confidence > 此值直接返回，默认 0.9） */
  l0ConfidenceThreshold?: number;
  /** L1 命中阈值（confidence > 此值直接返回，默认 0.85） */
  l1ConfidenceThreshold?: number;
  /** L2 命中阈值（confidence > 此值直接返回，默认 0.7） */
  l2ConfidenceThreshold?: number;
  /** SafeNet 低置信度阈值（< 此值触发 needsClarification，默认 0.5） */
  safeNetConfidenceThreshold?: number;
  /** 触发熔断的连续低置信度次数（默认 5） */
  circuitBreakerThreshold?: number;
  /** 熔断冷却期毫秒数（默认 5 分钟） */
  circuitBreakerCooldownMs?: number;
}

// ============================================================
// 常量
// ============================================================

/** 默认 L0 置信度阈值（正则命中时给 1.0，超过阈值直接返回） */
export const DEFAULT_L0_CONFIDENCE_THRESHOLD = 0.9;
/** 默认 L1 置信度阈值 */
export const DEFAULT_L1_CONFIDENCE_THRESHOLD = 0.85;
/** 默认 L2 置信度阈值 */
export const DEFAULT_L2_CONFIDENCE_THRESHOLD = 0.7;
/** 默认 SafeNet 低置信度阈值 */
export const DEFAULT_SAFENET_CONFIDENCE_THRESHOLD = 0.5;
/** 默认熔断阈值（陷阱 #146） */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
/** 默认熔断冷却期 5 分钟（陷阱 #146） */
export const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

// ============================================================
// RoutingFunnel
// ============================================================

/**
 * 意图路由四层漏斗
 *
 * 设计：
 *   - L0 正则：复用 matchDeterministicRule，<1ms，拦截高频意图
 *   - L1 向量语义：依赖注入的 VectorRouter，30-100ms，可选
 *   - L2 大模型：依赖注入的 LLMClassifier，1-2s
 *   - SafeNet：置信度检查 + OOD 检测 + 熔断
 *
 * 通过依赖注入接收各层组件，便于单元测试 mock。
 */
export class RoutingFunnel {
  /**
   * 内部配置——所有可选字段在构造时填充默认值，仅 l0Rules / vectorRouter 保留可选
   * （l0Rules 为 undefined 时 matchDeterministicRule 自动用内置规则）
   */
  private readonly config: {
    l0Rules?: DeterministicRule[];
    vectorRouter?: VectorRouter;
    llmClassifier: LLMClassifier;
    fallbackModel: { id: string; provider: string };
    fallbackTier: ScenarioTier;
    l0ConfidenceThreshold: number;
    l1ConfidenceThreshold: number;
    l2ConfidenceThreshold: number;
    safeNetConfidenceThreshold: number;
    circuitBreakerThreshold: number;
    circuitBreakerCooldownMs: number;
  };

  /** 连续低置信度计数（用于熔断判定） */
  private consecutiveLowConfidence = 0;
  /** 熔断触发时间戳（毫秒），0 表示未熔断 */
  private circuitBreakerTriggeredAt = 0;

  constructor(config: RoutingFunnelConfig) {
    this.config = {
      l0Rules: config.l0Rules,
      vectorRouter: config.vectorRouter,
      llmClassifier: config.llmClassifier,
      fallbackModel: config.fallbackModel,
      fallbackTier: config.fallbackTier ?? 'complex',
      l0ConfidenceThreshold: config.l0ConfidenceThreshold ?? DEFAULT_L0_CONFIDENCE_THRESHOLD,
      l1ConfidenceThreshold: config.l1ConfidenceThreshold ?? DEFAULT_L1_CONFIDENCE_THRESHOLD,
      l2ConfidenceThreshold: config.l2ConfidenceThreshold ?? DEFAULT_L2_CONFIDENCE_THRESHOLD,
      safeNetConfidenceThreshold:
        config.safeNetConfidenceThreshold ?? DEFAULT_SAFENET_CONFIDENCE_THRESHOLD,
      circuitBreakerThreshold:
        config.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
      circuitBreakerCooldownMs:
        config.circuitBreakerCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
    };
  }

  /**
   * 四层漏斗路由主入口
   *
   * 流程：L0 → L1（可选）→ L2 → SafeNet
   *
   * 铁律 1：规则优先模型兜底——L0/L1 命中即返回，不调 LLM
   * 铁律 3：低置信度反问不瞎猜——SafeNet 标记 needsClarification
   */
  async route(input: string): Promise<RoutingResult> {
    // 0. 先检查熔断状态：熔断期间直接回退默认模型（陷阱 #146）
    if (this.isCircuitBreakerActive()) {
      logger.warn('RoutingFunnel: 熔断降级中，回退默认模型', {
        input: input.slice(0, 100),
        fallbackModel: this.config.fallbackModel,
      });
      return {
        tier: this.config.fallbackTier,
        confidence: 0,
        source: 'safe-net',
        model: this.config.fallbackModel,
        originalTier: this.config.fallbackTier,
        circuitBreakerActive: true,
      };
    }

    // ===== L0：正则匹配（<1ms）=====
    const l0Result = this.l0RegexRoute(input);
    if (l0Result && l0Result.confidence >= this.config.l0ConfidenceThreshold) {
      this.resetLowConfidenceCounter();
      logger.debug('RoutingFunnel: L0 命中', {
        ruleId: l0Result.matchedRuleId,
        input: input.slice(0, 100),
      });
      return l0Result;
    }

    // ===== L1：向量语义路由（30-100ms，可选）=====
    if (this.config.vectorRouter) {
      const l1Result = await this.l1VectorRoute(input);
      if (l1Result && l1Result.confidence >= this.config.l1ConfidenceThreshold) {
        this.resetLowConfidenceCounter();
        logger.debug('RoutingFunnel: L1 命中', {
          confidence: l1Result.confidence,
          input: input.slice(0, 100),
        });
        return l1Result;
      }
    }

    // ===== L2：大模型路由（1-2s）=====
    const l2Result = await this.l2LLMRoute(input);
    if (l2Result.confidence >= this.config.l2ConfidenceThreshold) {
      this.resetLowConfidenceCounter();
      logger.debug('RoutingFunnel: L2 命中', {
        tier: l2Result.tier,
        confidence: l2Result.confidence,
      });
      return l2Result;
    }

    // ===== SafeNet：低置信度兜底 =====
    return this.safeNet(input, l2Result);
  }

  /** 当前是否处于熔断状态（含冷却期判定） */
  isCircuitBreakerActive(): boolean {
    if (this.circuitBreakerTriggeredAt === 0) return false;
    const elapsed = Date.now() - this.circuitBreakerTriggeredAt;
    if (elapsed >= this.config.circuitBreakerCooldownMs) {
      // 冷却期过，自动恢复
      this.circuitBreakerTriggeredAt = 0;
      this.consecutiveLowConfidence = 0;
      logger.info('RoutingFunnel: 熔断冷却期结束，恢复正常路由');
      return false;
    }
    return true;
  }

  /** 获取当前连续低置信度计数（用于测试/监控） */
  getConsecutiveLowConfidence(): number {
    return this.consecutiveLowConfidence;
  }

  /** 手动重置熔断状态（管理员干预时使用） */
  resetCircuitBreaker(): void {
    this.circuitBreakerTriggeredAt = 0;
    this.consecutiveLowConfidence = 0;
  }

  // ============================================================
  // 内部：各层实现
  // ============================================================

  /**
   * L0：正则路由——复用 matchDeterministicRule
   *
   * 命中确定性规则时给 confidence=1.0（铁律 2：意图用枚举，规则 ID 即意图）
   */
  private l0RegexRoute(input: string): RoutingResult | null {
    const rule = matchDeterministicRule(input, this.config.l0Rules);
    if (!rule) return null;

    // 根据 handler 推断 tier（确定性规则按 simple 处理，不调 LLM）
    return {
      tier: 'simple',
      confidence: 1.0,
      source: 'l0-regex',
      matchedRuleId: rule.id,
      // L0 不直接选模型，由上层根据 handler 决定（direct-response 不调模型）
    };
  }

  /**
   * L1：向量语义路由——依赖注入的 VectorRouter
   *
   * 返回 null 表示未命中或不可用
   */
  private async l1VectorRoute(input: string): Promise<RoutingResult | null> {
    try {
      return await this.config.vectorRouter!.route(input);
    } catch (err) {
      // L1 失败不阻断流程，降级到 L2
      logger.warn('RoutingFunnel: L1 向量路由失败，降级到 L2', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * L2：大模型路由——依赖注入的 LLMClassifier
   *
   * 铁律 2：意图用枚举——LLMClassifier 内部应返回 ScenarioTier 枚举而非自由文本
   */
  private async l2LLMRoute(input: string): Promise<RoutingResult> {
    try {
      return await this.config.llmClassifier.classify(input);
    } catch (err) {
      // L2 失败：返回极低置信度结果，由 SafeNet 兜底
      logger.error('RoutingFunnel: L2 LLM 分类失败，交给 SafeNet 兜底', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        tier: this.config.fallbackTier,
        confidence: 0,
        source: 'llm',
      };
    }
  }

  /**
   * SafeNet——置信度检查 + 熔断
   *
   * 铁律 3：低置信度反问不瞎猜
   *   - confidence < safeNetConfidenceThreshold → needsClarification=true
   *   - model 标记为 {id:'unknown', provider:'safe-net'}
   *
   * 陷阱 #146：连续低置信度 > threshold 次触发熔断
   *   - 熔断期间所有请求回退默认模型
   *   - 5 分钟冷却期后自动恢复
   */
  private safeNet(input: string, llmResult: RoutingResult): RoutingResult {
    const isLowConfidence = llmResult.confidence < this.config.safeNetConfidenceThreshold;

    if (isLowConfidence) {
      this.consecutiveLowConfidence++;
      logger.warn('RoutingFunnel: SafeNet 拦截低置信度请求', {
        confidence: llmResult.confidence,
        consecutiveLowConfidence: this.consecutiveLowConfidence,
        input: input.slice(0, 100),
      });

      // 检查熔断触发条件（> threshold 次，注意严格大于）
      if (this.consecutiveLowConfidence > this.config.circuitBreakerThreshold) {
        this.triggerCircuitBreaker();
      }

      return {
        tier: llmResult.tier,
        confidence: 0,
        source: 'safe-net',
        model: { id: 'unknown', provider: 'safe-net' },
        originalTier: llmResult.tier,
        needsClarification: true,
      };
    }

    // 中等置信度（safeNet 阈值 ≤ confidence < l2 阈值）：放行但记录
    this.resetLowConfidenceCounter();
    return {
      ...llmResult,
      source: 'llm',
    };
  }

  /** 触发熔断 */
  private triggerCircuitBreaker(): void {
    this.circuitBreakerTriggeredAt = Date.now();
    logger.error('RoutingFunnel: 触发熔断，进入降级模式', {
      consecutiveLowConfidence: this.consecutiveLowConfidence,
      cooldownMs: this.config.circuitBreakerCooldownMs,
    });
  }

  /** 重置连续低置信度计数 */
  private resetLowConfidenceCounter(): void {
    if (this.consecutiveLowConfidence > 0) {
      this.consecutiveLowConfidence = 0;
    }
  }
}
