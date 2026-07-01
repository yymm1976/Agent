// src/agent/self-evolution/framework.ts
// Phase 52 Task 5：自进化统一框架——反馈循环架构
//
// 来自 Self-Evolving AI Agents Survey (arXiv 2508.07407) 的四组件模型：
//   System Inputs → Agent System → Environment → Optimisers → (反馈到 Agent System)
//
// 本模块实现 SelfEvolutionFramework，统一协调 RouteDev 的自进化能力：
//   - 收集来自 LoopMemory/SkillMemory/ScoreCard/ProcessDefect/UserFeedback 的信号
//   - 根据信号类型和频率选择最需要优化的目标层
//   - 产出优化提案（不自动应用——Gödel 安全版思想）
//
// 与现有模块的关系：
//   - LoopMemory（src/agent/loop-memory.ts）：沉淀失败原因 → 信号源之一
//   - SkillMemory（src/skills/skill-lifecycle.ts）：Skill 级记忆 → 信号源之一
//   - ScoreCard（src/agent/multi/score-card.ts）：质量评分 → 信号源之一
//   - 具体信号源的接入由 src/cli/app-init.ts 完成（主 Agent 处理）

import type {
  EvolutionSignal,
  OptimizationTarget,
  OptimizationProposal,
  ProposedChange,
  SelfEvolutionConfig,
} from './types.js';
import { logger } from '../../utils/logger.js';
// CR-4b：接入过程级缺陷评估（classifyDefect / buildCalibratedScorecard）
import { classifyDefect, buildCalibratedScorecard, type DefectDetectionConfig } from '../../evaluation/process-defect-ontology.js';
// Phase 52 Task 8/9 深度接入：GodelProposer + SelfHarnessLoop
import type {
  GodelProposer,
  GodelProposal,
  ExecutionHistoryEntry,
  CurrentRuleEntry,
} from './godel-proposer.js';
import type {
  SelfHarnessLoop,
  WeaknessCategory,
  HarnessProposal,
} from './self-harness-loop.js';

// ============================================================
// 内部常量
// ============================================================

/**
 * 信号类型 → 候选优化目标（按优先级排序）
 *
 * 设计依据（Phase 52 Task 5.3 设计要点 1）：
 *   failure         → prompt 或 workflow（失败多说明 prompt 不清或流程有问题）
 *   quality_drop    → memory 或 prompt（质量下降说明记忆不足或 prompt 引导差）
 *   inefficiency    → tools 或 workflow（低效说明工具配置差或流程冗余）
 *   user_rejection  → communication 或 prompt（用户拒绝说明沟通或表达问题）
 *   success_pattern → 无（成功模式不触发优化，仅可强化）
 */
const SIGNAL_TYPE_TO_TARGETS: Readonly<
  Record<EvolutionSignal['type'], readonly OptimizationTarget[]>
> = {
  failure: ['prompt', 'workflow'],
  quality_drop: ['memory', 'prompt'],
  inefficiency: ['tools', 'workflow'],
  user_rejection: ['communication', 'prompt'],
  success_pattern: [],
};

/** 信号类型处理优先级（数量相同时按此顺序偏好） */
const SIGNAL_TYPE_PRIORITY: readonly EvolutionSignal['type'][] = [
  'failure',
  'quality_drop',
  'inefficiency',
  'user_rejection',
];

/** 严重度权重（用于排序） */
const SEVERITY_WEIGHT: Readonly<Record<EvolutionSignal['severity'], number>> = {
  high: 3,
  medium: 2,
  low: 1,
};

/** 目标层中文名（用于提案描述） */
const TARGET_DISPLAY_NAMES: Readonly<Record<OptimizationTarget, string>> = {
  prompt: 'System Prompt',
  memory: '记忆策略',
  tools: '工具配置',
  workflow: '工作流（SkillFlow）',
  communication: '子 Agent 通信',
};

/** 目标层修改风险基线 */
const TARGET_RISK_BASELINE: Readonly<Record<OptimizationTarget, 'low' | 'medium' | 'high'>> = {
  prompt: 'low', // prompt 修改风险低，易回滚
  memory: 'medium', // 记忆策略影响后续行为
  tools: 'medium', // 工具配置影响执行能力
  workflow: 'high', // 工作流修改影响全局
  communication: 'high', // 通信修改影响多 Agent 协作
};

// ============================================================
// 信号源接口
// ============================================================

/**
 * 信号收集器接口
 *
 * 由主 Agent 接入具体实现（如 LoopMemorySignalSource、SkillMemorySignalSource 等）。
 * 框架通过 registerSignalSource 注册多个源，collectSignals 时统一拉取。
 */
export interface SignalSource {
  /** 信号源名称（用于日志） */
  readonly name: string;
  /** 收集当前可用的自进化信号 */
  collect(): EvolutionSignal[];
}

// ============================================================
// 纯函数
// ============================================================

/**
 * 按信号类型计数
 *
 * 纯函数：无副作用，输入决定输出。
 */
function countSignalsByType(signals: EvolutionSignal[]): Record<EvolutionSignal['type'], number> {
  const counts: Record<EvolutionSignal['type'], number> = {
    failure: 0,
    quality_drop: 0,
    success_pattern: 0,
    inefficiency: 0,
    user_rejection: 0,
  };
  for (const s of signals) {
    counts[s.type]++;
  }
  return counts;
}

/**
 * 根据信号类型选择优化目标（纯函数，不考虑配置开关）
 *
 * 逻辑：
 *   1. 按信号类型计数
 *   2. 找出数量最多的信号类型（相同时按 failure > quality_drop > inefficiency > user_rejection 优先）
 *   3. 返回该类型对应的主选目标（候选列表的第一个）
 *
 * @returns 主选优化目标；无信号或仅有 success_pattern 时返回 null
 */
export function selectTargetBySignalType(signals: EvolutionSignal[]): OptimizationTarget | null {
  if (signals.length === 0) return null;

  const counts = countSignalsByType(signals);

  // 按优先级找出数量最多的信号类型
  let bestType: EvolutionSignal['type'] | null = null;
  let bestCount = 0;
  for (const t of SIGNAL_TYPE_PRIORITY) {
    if (counts[t] > bestCount) {
      bestCount = counts[t];
      bestType = t;
    }
  }

  if (bestType === null || bestCount === 0) return null;

  // 返回主选目标（候选列表的第一个）
  const candidates = SIGNAL_TYPE_TO_TARGETS[bestType];
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * 根据信号频率和严重度排序（纯函数）
 *
 * 排序规则：
 *   1. 严重度降序（high > medium > low）
 *   2. 相同严重度按时间戳降序（最新的优先）
 *
 * @returns 排序后的信号副本（不修改原数组）
 */
export function rankSignalsByImpact(signals: EvolutionSignal[]): EvolutionSignal[] {
  return [...signals].sort((a, b) => {
    const w = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (w !== 0) return w;
    return b.timestamp - a.timestamp;
  });
}

/**
 * 生成提案 ID
 *
 * 格式：proposal-<timestamp>-<random6>
 * 注：使用时间戳+随机串保证唯一性，不维护可变全局计数器
 */
export function generateProposalId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `proposal-${Date.now()}-${random}`;
}

// ============================================================
// 自进化框架
// ============================================================

/**
 * 自进化统一框架
 *
 * 职责：
 *   - 注册并收集多个信号源的反馈信号
 *   - 根据信号类型和频率选择最需要优化的目标层
 *   - 判断是否触发优化（基于 trigger 配置）
 *   - 产出优化提案（不自动应用——Gödel 安全版思想）
 *   - 追踪提案的应用状态
 *
 * 不职责：
 *   - 直接修改 Prompt/Memory/Tools/Workflow/Communication（仅产出建议）
 *   - 实现具体信号源的采集逻辑（由主 Agent 接入）
 *
 * 用法：
 *   const framework = new SelfEvolutionFramework(config);
 *   framework.registerSignalSource(loopMemorySource);
 *   framework.registerSignalSource(skillMemorySource);
 *   const signals = framework.collectSignals();
 *   const { trigger, reason } = framework.shouldTriggerOptimization(signals);
 *   if (trigger) {
 *     const target = framework.selectOptimizationTarget(signals);
 *     if (target) {
 *       const proposal = framework.optimize(target, signals);
 *       // proposal.applied === false；上层审批后调用 markProposalApplied
 *     }
 *   }
 */
export class SelfEvolutionFramework {
  /** 已注册的信号源 */
  private readonly signalSources: SignalSource[] = [];
  /** 历史提案列表（按创建顺序） */
  private readonly proposals: OptimizationProposal[] = [];
  /** 自构造/上次优化以来的收集次数（用于 evaluationInterval 判定） */
  private collectionCount = 0;
  /** 配置（运行时不可变） */
  private readonly config: SelfEvolutionConfig;
  /** CR-4b：过程级缺陷评估配置（由 app-init 按 config.phase52Integration.processEvaluation.enabled 注入，未注入时不评估） */
  private processDefectConfig: { enabled: boolean; config: DefectDetectionConfig } | null = null;
  /**
   * Phase 52 Task 8 深度接入：Gödel 提案器（可选）。
   * 由 setGodelProposer 注入；注入后 optimize 完成时异步触发 proposeModifications 产出 Gödel 提案。
   * 异步结果存到 lastGodelProposals，供 getLastGodelProposals() 查询。
   */
  private godelProposer?: GodelProposer;
  /** Gödel 提案器输入：执行历史快照（由调用方持续更新） */
  private godelExecutionHistory?: ExecutionHistoryEntry[];
  /** Gödel 提案器输入：当前规则快照（由调用方持续更新） */
  private godelCurrentRules?: CurrentRuleEntry[];
  /** 最近一轮 Gödel 提案结果（由异步任务填充） */
  private lastGodelProposals: GodelProposal[] = [];
  /**
   * Phase 52 Task 9 深度接入：Self-Harness 循环（可选）。
   * 由 setSelfHarnessLoop 注入；注入后 optimize 完成时异步触发弱点挖掘 + 提案生成。
   * 异步结果存到 lastHarnessWeaknesses / lastHarnessProposals，供 getter 查询。
   */
  private selfHarnessLoop?: SelfHarnessLoop;
  /** 最近一轮 Self-Harness 弱点挖掘结果（由异步任务填充） */
  private lastHarnessWeaknesses: WeaknessCategory[] = [];
  /** 最近一轮 Self-Harness 提案生成结果（由异步任务填充） */
  private lastHarnessProposals: HarnessProposal[] = [];

  constructor(config: SelfEvolutionConfig) {
    this.config = config;
  }

  /**
   * CR-4b：注入过程级缺陷评估配置
   * 由 app-init.ts 按 config.phase52Integration.processEvaluation.enabled 守护调用；
   * 未调用时 optimize 不会执行缺陷分类与评分卡生成（向后兼容，退回旧行为）。
   */
  setProcessDefectIntegration(enabled: boolean, defectConfig: DefectDetectionConfig): void {
    this.processDefectConfig = enabled ? { enabled: true, config: defectConfig } : null;
  }

  /**
   * Phase 52 Task 8 深度接入：注入 Gödel 提案器
   *
   * 注入后，optimize 完成时会异步调用 godelProposer.proposeModifications，
   * 把 EvolutionSignal 中的失败信号转换为 ExecutionHistoryEntry 喂给提案器。
   * 异步产出的提案存到 lastGodelProposals，供 getLastGodelProposals() 查询。
   *
   * @param proposer        Gödel 提案器实例（须已配置 enabled=true）
   * @param executionHistory 执行历史快照（由调用方持有，会被 mutate 读取最新值）
   * @param currentRules    当前规则快照（由调用方持有，会被 mutate 读取最新值）
   */
  setGodelProposer(
    proposer: GodelProposer,
    executionHistory?: ExecutionHistoryEntry[],
    currentRules?: CurrentRuleEntry[],
  ): void {
    this.godelProposer = proposer;
    this.godelExecutionHistory = executionHistory;
    this.godelCurrentRules = currentRules;
  }

  /**
   * Phase 52 Task 9 深度接入：注入 Self-Harness 循环
   *
   * 注入后，optimize 完成时会异步调用 selfHarnessLoop.discoverWeaknesses + proposeModifications，
   * 把 EvolutionSignal 中的失败信号转换为 Self-Harness 失败日志喂给循环。
   * 异步产出的弱点/提案存到 lastHarnessWeaknesses / lastHarnessProposals，供 getter 查询。
   *
   * @param loop Self-Harness 循环实例（须已配置 enabled=true）
   */
  setSelfHarnessLoop(loop: SelfHarnessLoop): void {
    this.selfHarnessLoop = loop;
  }

  /**
   * Phase 52 Task 8：获取最近一轮 Gödel 提案结果
   *
   * optimize 异步触发后才会填充；初始为空数组。
   * 返回副本，外部修改不影响内部状态。
   */
  getLastGodelProposals(): GodelProposal[] {
    return [...this.lastGodelProposals];
  }

  /**
   * Phase 52 Task 9：获取最近一轮 Self-Harness 弱点挖掘结果
   *
   * optimize 异步触发后才会填充；初始为空数组。
   * 返回副本，外部修改不影响内部状态。
   */
  getLastHarnessWeaknesses(): WeaknessCategory[] {
    return [...this.lastHarnessWeaknesses];
  }

  /**
   * Phase 52 Task 9：获取最近一轮 Self-Harness 提案生成结果
   *
   * optimize 异步触发后才会填充；初始为空数组。
   * 返回副本，外部修改不影响内部状态。
   */
  getLastHarnessProposals(): HarnessProposal[] {
    return [...this.lastHarnessProposals];
  }

  // ----------------------------------------------------------
  // 信号源管理
  // ----------------------------------------------------------

  /**
   * 注册信号源
   *
   * 允许注册多个同名源（不去重），collectSignals 时依次拉取。
   */
  registerSignalSource(source: SignalSource): void {
    this.signalSources.push(source);
    logger.debug('SelfEvolution: registered signal source', { name: source.name });
  }

  /**
   * 收集所有信号源的信号
   *
   * 副作用：递增 collectionCount（用于 shouldTriggerOptimization 的 evaluationInterval 判定）
   *
   * @returns 所有信号源本次收集到的信号（按注册顺序合并）
   */
  collectSignals(): EvolutionSignal[] {
    this.collectionCount++;
    const all: EvolutionSignal[] = [];
    for (const source of this.signalSources) {
      try {
        const signals = source.collect();
        // 校验返回值为数组，非数组时跳过该源
        if (!Array.isArray(signals)) {
          logger.warn('SelfEvolution: signal source 返回非数组，跳过', {
            name: source.name,
            type: typeof signals,
          });
          continue;
        }
        all.push(...signals);
      } catch (error) {
        // 单个信号源失败不阻塞其他源
        logger.warn('SelfEvolution: signal source collect failed', {
          name: source.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.debug('SelfEvolution: collected signals', {
      sourceCount: this.signalSources.length,
      signalCount: all.length,
      collectionCount: this.collectionCount,
    });
    return all;
  }

  // ----------------------------------------------------------
  // 优化目标选择
  // ----------------------------------------------------------

  /**
   * 根据信号选择最需要优化的目标层
   *
   * 逻辑（设计要点 1）：
   *   1. 按信号类型计数，找数量最多的类型
   *   2. 按候选优先级选择第一个在 config.targets 中启用的目标
   *   3. 候选目标都未启用时，回退到任意启用的目标
   *
   * @returns 优化目标；无信号或所有目标都未启用时返回 null
   */
  selectOptimizationTarget(signals: EvolutionSignal[]): OptimizationTarget | null {
    if (signals.length === 0) return null;

    const counts = countSignalsByType(signals);

    // 按优先级找出数量最多的信号类型
    let bestType: EvolutionSignal['type'] | null = null;
    let bestCount = 0;
    for (const t of SIGNAL_TYPE_PRIORITY) {
      if (counts[t] > bestCount) {
        bestCount = counts[t];
        bestType = t;
      }
    }

    if (bestType !== null && bestCount > 0) {
      // 按候选优先级选择第一个启用的目标
      for (const candidate of SIGNAL_TYPE_TO_TARGETS[bestType]) {
        if (this.config.targets[candidate]) {
          return candidate;
        }
      }
    }

    // 无主导信号或候选目标都未启用 → 回退到任意启用的目标
    return this.selectAnyEnabledTarget();
  }

  /**
   * 选择任意启用的目标（回退策略）
   *
   * 优先级：prompt > memory > workflow > tools > communication
   */
  private selectAnyEnabledTarget(): OptimizationTarget | null {
    const order: OptimizationTarget[] = ['prompt', 'memory', 'workflow', 'tools', 'communication'];
    for (const t of order) {
      if (this.config.targets[t]) return t;
    }
    return null;
  }

  // ----------------------------------------------------------
  // 触发判定
  // ----------------------------------------------------------

  /**
   * 判断是否触发优化（基于 trigger 配置）
   *
   * 逻辑（设计要点 2）：
   *   1. config.enabled=false → 不触发
   *   2. 失败次数 >= failureThreshold → 触发
   *   3. 质量下降比例 >= qualityDropThreshold → 触发
   *   4. 距上次优化的收集次数 >= evaluationInterval → 触发评估
   *
   * @returns trigger=true 时 reason 说明触发了哪条规则
   */
  shouldTriggerOptimization(
    signals: EvolutionSignal[],
  ): { trigger: boolean; reason: string } {
    // 陷阱：config.enabled=false 时不执行自进化
    if (!this.config.enabled) {
      return { trigger: false, reason: 'self-evolution disabled (config.enabled=false)' };
    }

    // 规则 1：失败次数 >= failureThreshold
    const failureCount = signals.filter((s) => s.type === 'failure').length;
    if (failureCount >= this.config.trigger.failureThreshold) {
      return {
        trigger: true,
        reason: `failure count ${failureCount} >= threshold ${this.config.trigger.failureThreshold}`,
      };
    }

    // 规则 2：质量下降比例 >= qualityDropThreshold
    if (signals.length > 0) {
      const qualityDropCount = signals.filter((s) => s.type === 'quality_drop').length;
      const ratio = qualityDropCount / signals.length;
      if (ratio >= this.config.trigger.qualityDropThreshold) {
        return {
          trigger: true,
          reason: `quality drop ratio ${ratio.toFixed(2)} >= threshold ${this.config.trigger.qualityDropThreshold}`,
        };
      }
    }

    // 规则 3：距上次优化的收集次数 >= evaluationInterval
    if (this.collectionCount >= this.config.trigger.evaluationInterval) {
      return {
        trigger: true,
        reason: `collection count ${this.collectionCount} >= evaluation interval ${this.config.trigger.evaluationInterval}`,
      };
    }

    return { trigger: false, reason: 'no trigger condition met' };
  }

  // ----------------------------------------------------------
  // 优化执行
  // ----------------------------------------------------------

  /**
   * 执行优化（产出建议，不自动应用）
   *
   * Gödel 安全版思想：
   *   - 框架仅产出 OptimizationProposal，不直接修改 Agent System
   *   - proposal.applied 默认 false
   *   - 上层审批后调用 markProposalApplied 标记
   *
   * 副作用：
   *   - 提案追加到内部 proposals 列表
   *   - 重置 collectionCount（优化后重新计数）
   *
   * @param target 优化目标层
   * @param signals 用于生成建议的信号（通常为 collectSignals 的结果）
   * @returns 优化提案（applied=false）
   */
  optimize(
    target: OptimizationTarget,
    signals: EvolutionSignal[],
  ): OptimizationProposal {
    // 按影响排序，取 top 5 作为建议依据
    const ranked = rankSignalsByImpact(signals);
    const topSignals = ranked.slice(0, 5);

    // CR-4b：过程级缺陷评估——对失败信号调用 classifyDefect 分类，
    // 用 buildCalibratedScorecard 生成校准评分卡（processDefectConfig 守护，未注入时跳过退回旧行为）
    let processGradeSummary = '';
    if (this.processDefectConfig?.enabled) {
      try {
        const failureSignals = signals.filter((s) => s.type === 'failure');
        // 把每条失败信号当作一条执行日志条目（description 作为 error 文本）
        const executionLog = failureSignals.map((s, idx) => ({
          stepIndex: idx,
          error: s.description,
          output: '',
        }));
        // 直接调用 classifyDefect 分类每条失败信号（外部接线，消除孤立调用）
        const categorizedDefects = executionLog
          .map((entry) => classifyDefect(entry, this.processDefectConfig!.config))
          .filter((d) => d !== null);
        // 生成校准评分卡（内部亦调用 classifyDefect）
        const scorecard = buildCalibratedScorecard(
          executionLog,
          /* outcomePassed */ failureSignals.length === 0,
          this.processDefectConfig!.config,
        );
        processGradeSummary = `；过程分级=${scorecard.processGrade}（风险=${scorecard.overallRisk.toFixed(2)}，控制保持度=${scorecard.controlPreservation.toFixed(2)}，缺陷类别=${scorecard.defects.length}，直分类=${categorizedDefects.length}）`;
        logger.info('CR-4b: process-defect 评分卡已生成', {
          processGrade: scorecard.processGrade,
          overallRisk: scorecard.overallRisk,
          controlPreservation: scorecard.controlPreservation,
          defectCount: scorecard.defects.length,
          categorizedCount: categorizedDefects.length,
        });
      } catch (error) {
        logger.warn('CR-4b: process-defect 评估失败 (non-blocking)', { error: String(error) });
      }
    }

    const description = this.buildDescription(target, topSignals) + processGradeSummary;
    const rationale = this.buildRationale(topSignals);
    const proposedChanges = this.buildProposedChanges(target, topSignals);
    const expectedImpact = this.assessImpact(topSignals);
    const riskLevel = TARGET_RISK_BASELINE[target];

    const proposal: OptimizationProposal = {
      id: generateProposalId(),
      target,
      description,
      rationale,
      expectedImpact,
      riskLevel,
      proposedChanges,
      createdAt: Date.now(),
      applied: false,
    };

    this.proposals.push(proposal);
    // I-8 修复：无界集合淘汰，避免长期运行内存泄漏
    if (this.proposals.length > 100) this.proposals.shift();
    this.collectionCount = 0; // 重置收集计数器

    logger.info('SelfEvolution: optimization proposal created', {
      proposalId: proposal.id,
      target,
      expectedImpact,
      riskLevel,
      signalCount: signals.length,
      changeCount: proposedChanges.length,
    });

    // Phase 52 Task 8 深度接入：异步触发 GodelProposer.proposeModifications
    // config 守护：未注入 godelProposer 时跳过；try/catch 降级：异步失败不阻塞主流程
    // fire-and-forget 模式——主流程已返回 proposal，异步结果存到 lastGodelProposals 供查询
    this.triggerGodelProposerAsync(signals).catch((err) => {
      logger.warn('SelfEvolution: GodelProposer 异步任务失败 (non-blocking)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Phase 52 Task 9 深度接入：异步触发 SelfHarnessLoop（弱点挖掘 + 提案生成）
    // config 守护：未注入 selfHarnessLoop 时跳过；try/catch 降级：异步失败不阻塞主流程
    this.triggerSelfHarnessLoopAsync(signals).catch((err) => {
      logger.warn('SelfEvolution: SelfHarnessLoop 异步任务失败 (non-blocking)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return proposal;
  }

  /**
   * Phase 52 Task 8 深度接入：异步触发 GodelProposer.proposeModifications
   *
   * 流程：
   *   1. 把 EvolutionSignal 中的 failure 信号合并到外部注入的 godelExecutionHistory（如有）
   *   2. 调用 godelProposer.proposeModifications 产出提案
   *   3. 把结果存到 lastGodelProposals
   *
   * 失败不抛出（由调用方的 .catch 兜底）；未注入 godelProposer 时直接 resolve。
   */
  private async triggerGodelProposerAsync(signals: EvolutionSignal[]): Promise<void> {
    if (!this.godelProposer) return;
    try {
      // 把外部注入的执行历史作为基线；如未注入则用空数组
      const baseHistory = this.godelExecutionHistory ?? [];
      // 把 EvolutionSignal 中的 failure 信号转换为 ExecutionHistoryEntry 追加
      // 类型映射：EvolutionSignal.description → task；EvolutionSignal.severity 高 → outcome 'failure'
      // 注：EvolutionSignal 与 ExecutionHistoryEntry 字段语义不完全对齐，
      // 这里做最小映射，仅取 description 作为 task，type==='failure' 视为 outcome 'failure'
      const signalDerivedHistory: ExecutionHistoryEntry[] = signals
        .filter((s) => s.type === 'failure')
        .map((s) => ({
          task: s.description,
          outcome: 'failure' as const,
          failurePoint: s.description,
          tokensUsed: 0,   // EvolutionSignal 无 token 字段，用 0 占位
          durationMs: 0,    // EvolutionSignal 无 duration 字段，用 0 占位
        }));
      const mergedHistory = [...baseHistory, ...signalDerivedHistory];

      // 当前规则快照：未注入时传空数组（GodelProposer 内部会跳过规则匹配）
      const currentRules = this.godelCurrentRules ?? [];

      const proposals = await this.godelProposer.proposeModifications(mergedHistory, currentRules);
      this.lastGodelProposals = proposals;
      // I-8 修复：无界集合淘汰
      if (this.lastGodelProposals.length > 100) {
        this.lastGodelProposals = this.lastGodelProposals.slice(-100);
      }
      logger.debug('SelfEvolution: GodelProposals 已更新', {
        count: proposals.length,
      });
    } catch (err) {
      // 内部 catch 防止异常冒泡到调用方的 .catch
      logger.warn('SelfEvolution: triggerGodelProposerAsync 内部失败', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Phase 52 Task 9 深度接入：异步触发 SelfHarnessLoop（弱点挖掘 + 提案生成）
   *
   * 流程：
   *   1. 把 EvolutionSignal 中的 failure 信号转换为 Self-Harness 失败日志格式
   *   2. 调用 selfHarnessLoop.discoverWeaknesses 进行聚类
   *   3. 调用 selfHarnessLoop.proposeModifications 生成 Harness 修改提案
   *   4. 把结果存到 lastHarnessWeaknesses / lastHarnessProposals
   *
   * 失败不抛出（由调用方的 .catch 兜底）；未注入 selfHarnessLoop 时直接 resolve。
   * 注：当前 Harness 状态（rules/prompts/checkpoints）暂传空对象，由后续 Phase 53 接入实际状态。
   */
  private async triggerSelfHarnessLoopAsync(signals: EvolutionSignal[]): Promise<void> {
    if (!this.selfHarnessLoop) return;
    try {
      // 把 EvolutionSignal 中的 failure 信号转换为 Self-Harness 失败日志
      const failureLogs = signals
        .filter((s) => s.type === 'failure')
        .map((s) => ({
          timestamp: s.timestamp,
          task: s.description,
          failurePoint: s.description,
          errorType: s.source,  // 用 source 作为 errorType 近似分类
          component: undefined as string | undefined,
        }));

      // 阶段 1：弱点挖掘
      const weaknesses = await this.selfHarnessLoop.discoverWeaknesses(failureLogs);
      this.lastHarnessWeaknesses = weaknesses;
      // I-8 修复：无界集合淘汰
      if (this.lastHarnessWeaknesses.length > 100) {
        this.lastHarnessWeaknesses = this.lastHarnessWeaknesses.slice(-100);
      }

      // 阶段 2：提案生成（currentHarness 暂传空对象，后续 Phase 53 接入实际 Harness 状态）
      const proposals = await this.selfHarnessLoop.proposeModifications(weaknesses, {
        rules: [],
        prompts: [],
        checkpoints: [],
      });
      this.lastHarnessProposals = proposals;
      if (this.lastHarnessProposals.length > 100) {
        this.lastHarnessProposals = this.lastHarnessProposals.slice(-100);
      }

      logger.debug('SelfEvolution: HarnessWeaknesses/Proposals 已更新', {
        weaknessCount: weaknesses.length,
        proposalCount: proposals.length,
      });
    } catch (err) {
      logger.warn('SelfEvolution: triggerSelfHarnessLoopAsync 内部失败', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 构建提案描述
   */
  private buildDescription(target: OptimizationTarget, signals: EvolutionSignal[]): string {
    const name = TARGET_DISPLAY_NAMES[target];
    return `针对 ${name} 的优化建议（基于 ${signals.length} 条高影响信号）`;
  }

  /**
   * 构建提案理由（基于哪些信号）
   */
  private buildRationale(signals: EvolutionSignal[]): string {
    if (signals.length === 0) {
      return '无明确信号（基于周期性评估触发）';
    }
    return signals
      .map((s) => `[${s.source}/${s.type}/${s.severity}] ${s.description}`)
      .join('；');
  }

  /**
   * 根据目标层和信号构建拟修改内容
   */
  private buildProposedChanges(
    target: OptimizationTarget,
    signals: EvolutionSignal[],
  ): ProposedChange[] {
    const topIssues = signals.slice(0, 3).map((s) => s.description);
    const issuesText = topIssues.length > 0 ? topIssues.join('；') : '无具体信号';

    switch (target) {
      case 'prompt':
        return [
          {
            type: 'modify',
            target: 'system-prompt',
            description: `根据失败模式调整 system prompt，强化对以下问题的引导：${issuesText}`,
          },
        ];
      case 'memory':
        return [
          {
            type: 'modify',
            target: 'memory-strategy',
            description: `优化记忆的保留/淘汰/注入策略，覆盖以下场景：${issuesText}`,
          },
        ];
      case 'tools':
        return [
          {
            type: 'add',
            target: 'tool-registry',
            description: `增加或调整工具配置以解决低效：${issuesText}`,
          },
        ];
      case 'workflow':
        return [
          {
            type: 'modify',
            target: 'skill-flow',
            description: `优化 SkillFlow 定义以减少失败/低效：${issuesText}`,
          },
        ];
      case 'communication':
        return [
          {
            type: 'modify',
            target: 'sub-agent-config',
            description: `调整子 Agent 通信配置，改善协作效果：${issuesText}`,
          },
        ];
      default:
        return [];
    }
  }

  /**
   * 评估预期影响
   *
   * 基于信号严重度：
   *   - high 信号 >= 2 → high
   *   - high 信号 >= 1 或 medium 信号 >= 2 → medium
   *   - 其他 → low
   */
  private assessImpact(signals: EvolutionSignal[]): 'low' | 'medium' | 'high' {
    const highCount = signals.filter((s) => s.severity === 'high').length;
    const mediumCount = signals.filter((s) => s.severity === 'medium').length;
    if (highCount >= 2) return 'high';
    if (highCount >= 1 || mediumCount >= 2) return 'medium';
    return 'low';
  }

  // ----------------------------------------------------------
  // 提案管理
  // ----------------------------------------------------------

  /**
   * 获取所有历史提案（按创建顺序）
   *
   * @returns 提案副本（外部修改不影响内部状态）
   */
  getProposals(): OptimizationProposal[] {
    return [...this.proposals];
  }

  /**
   * 获取未应用的提案（applied=false）
   *
   * @returns 待审批/待应用的提案副本
   */
  getPendingProposals(): OptimizationProposal[] {
    return this.proposals.filter((p) => !p.applied);
  }

  /**
   * 标记提案为已应用
   *
   * @param proposalId 提案 ID（由 optimize 返回的 proposal.id）
   * 注：提案不存在时仅记录警告日志（不抛出，避免阻塞上层流程）
   */
  markProposalApplied(proposalId: string): void {
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (!proposal) {
      logger.warn('SelfEvolution: markProposalApplied failed (not found)', { proposalId });
      return;
    }
    proposal.applied = true;
    logger.info('SelfEvolution: proposal marked as applied', { proposalId });
  }
}
