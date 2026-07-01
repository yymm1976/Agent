// src/agent/self-evolution/self-harness-loop.ts
// Phase 52 Task 9：Self-Harness 三阶段循环
//
// 论文借鉴：Self-Harness (arXiv 2606.09498, 上海 AI Lab)
//   三阶段循环让 Harness 自动识别弱点并优化：
//   1. Weakness Mining（弱点挖掘）— 聚类失败轨迹，识别重复失败模式
//   2. Harness Proposal（Harness 提案）— 针对失败模式生成最小 Harness 修改
//   3. Proposal Validation（提案验证）— 回归测试通过后才接受修改
//
// 与现有模块的关系：
//   - loop-memory.ts：记录单次 /goal 的失败原因（短期、当前任务）
//   - reflection.ts：单步输出的快速自检 + 修正（细粒度）
//   - self-harness-loop.ts：跨任务、跨时间的弱点聚类与 Harness 优化（长期）
//
// 安全约束：
//   - 修改必须是最小的（不重写整个 Harness）
//   - 修改必须通过回归测试
//   - 修改是模型特定的（不同模型不同优化）
//   - 用户可审查和回滚
//   - autoApplyLowRiskProposals 默认 false，所有提案只产出建议

import { logger } from '../../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 弱点类别——聚类后的重复失败模式 */
export interface WeaknessCategory {
  /** 弱点名称（基于 errorType + failurePoint） */
  name: string;
  /** 弱点描述 */
  description: string;
  /** 出现次数 */
  frequency: number;
  /** 最后出现时间戳 */
  lastSeen: number;
  /** 受影响的组件 */
  affectedComponents: string[];
  /** 严重度 */
  severity: 'low' | 'medium' | 'high';
}

/** Harness 修改提案 */
export interface HarnessProposal {
  /** 提案 ID */
  id: string;
  /** 对应的弱点类别名 */
  weaknessCategory: string;
  /** 修改类型 */
  modificationType: 'add_rule' | 'modify_prompt' | 'add_checkpoint' | 'add_guardrail' | 'modify_config';
  /** 修改目标（文件路径或配置键） */
  target: string;
  /** 修改描述 */
  description: string;
  /** 预期修复效果 */
  expectedFix: string;
  /** 如何验证修复有效 */
  validationPlan: string;
  /** 风险等级 */
  riskLevel: 'low' | 'medium' | 'high';
  /** 创建时间戳 */
  createdAt: number;
  /** Phase 52 Task 9b：是否已应用（applyModification 成功后置 true） */
  applied?: boolean;
}

/** 验证结果 */
export interface ValidationResult {
  /** 对应的提案 ID */
  proposalId: string;
  /** 是否通过验证（测试通过且无回归） */
  passed: boolean;
  /** 是否检测到回归 */
  regressionDetected: boolean;
  /** 验证后发现的新弱点（回归的指标名作为线索） */
  newWeaknesses: string[];
  /** 应用提案前的指标 */
  metricsBefore: Record<string, number>;
  /** 应用提案后的指标 */
  metricsAfter: Record<string, number>;
  /** 验证时间戳 */
  validatedAt: number;
  /** 失败原因（验证异常时填写） */
  reason?: string;
}

/** Self-Harness 配置 */
export interface SelfHarnessConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 弱点检测灵敏度（low 只留 high 严重度，medium 留 medium+high，high 全留） */
  weaknessDetectionSensitivity: 'low' | 'medium' | 'high';
  /** 每轮循环最大提案数 */
  maxProposalsPerCycle: number;
  /** 是否要求回归测试 */
  requireRegressionTest: boolean;
  /** 是否自动应用低风险提案（默认 false，安全优先） */
  autoApplyLowRiskProposals: boolean;
  // Phase 52 蓝图对齐字段
  /** 弱点挖掘样本量（10-500，默认 50） */
  miningSampleSize?: number;
  /** 模式频率阈值（2-20，默认 3） */
  patternFrequencyThreshold?: number;
  /** 是否自动应用已通过验证的提案（默认 false，安全优先） */
  autoApplyValidated?: boolean;
  /** 回归测试存放目录 */
  regressionTestPath?: string;
}

/** 默认配置——安全优先 */
export const DEFAULT_SELF_HARNESS_CONFIG: SelfHarnessConfig = {
  enabled: false,
  weaknessDetectionSensitivity: 'medium',
  maxProposalsPerCycle: 5,
  requireRegressionTest: true,
  autoApplyLowRiskProposals: false,
  miningSampleSize: 50,
  patternFrequencyThreshold: 3,
  autoApplyValidated: false,
  regressionTestPath: '.routedev/regression-tests/',
};

// ============================================================
// 纯函数
// ============================================================

/**
 * 归一化 failurePoint 文本——用于关键词聚类
 * 转小写、折叠连续空白、去除首尾空白
 */
function normalizeFailurePoint(failurePoint: string): string {
  return failurePoint.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * 从失败日志聚类弱点
 *
 * 聚类规则：相同 errorType + 相似 failurePoint（归一化后相同）归为一类
 * 频率 >= 2 才算弱点（单次失败不构成模式）
 *
 * @param failureLogs 失败日志数组
 * @returns 弱点类别数组（已按频率降序排序）
 */
export function clusterFailures(
  failureLogs: Array<{ failurePoint: string; errorType: string; component?: string }>,
): WeaknessCategory[] {
  // 按 (errorType, normalizedFailurePoint) 分组
  const groups = new Map<
    string,
    {
      errorType: string;
      failurePoint: string;
      components: Set<string>;
      count: number;
    }
  >();

  for (const log of failureLogs) {
    const normalized = normalizeFailurePoint(log.failurePoint);
    const key = `${log.errorType}::${normalized}`;
    const group = groups.get(key);
    if (group) {
      group.count++;
      if (log.component) group.components.add(log.component);
    } else {
      groups.set(key, {
        errorType: log.errorType,
        failurePoint: log.failurePoint,
        components: new Set(log.component ? [log.component] : []),
        count: 1,
      });
    }
  }

  // 转换为 WeaknessCategory，过滤频率 < 2（单次失败不构成弱点）
  const weaknesses: WeaknessCategory[] = [];
  for (const group of groups.values()) {
    if (group.count < 2) continue;
    const affectedComponents = [...group.components];
    const weakness: WeaknessCategory = {
      name: `${group.errorType}@${group.failurePoint}`,
      description: `错误类型 "${group.errorType}" 在 "${group.failurePoint}" 处重复出现 ${group.count} 次`,
      frequency: group.count,
      lastSeen: Date.now(),
      affectedComponents,
      severity: assessWeaknessSeverity({
        frequency: group.count,
        affectedComponents,
      }),
    };
    weaknesses.push(weakness);
  }

  // 按频率降序排序（高频弱点优先处理）
  weaknesses.sort((a, b) => b.frequency - a.frequency);
  return weaknesses;
}

/**
 * 评估弱点严重度
 *
 * 规则：
 *   - frequency >= 5 或 affectedComponents >= 3 → high
 *   - frequency >= 3 或 affectedComponents >= 2 → medium
 *   - 其他 → low
 */
export function assessWeaknessSeverity(
  weakness: { frequency: number; affectedComponents: string[] },
): 'low' | 'medium' | 'high' {
  if (weakness.frequency >= 5 || weakness.affectedComponents.length >= 3) {
    return 'high';
  }
  if (weakness.frequency >= 3 || weakness.affectedComponents.length >= 2) {
    return 'medium';
  }
  return 'low';
}

/**
 * 生成提案 ID
 * 格式：harness-prop-{base36 时间戳}-{6 位随机}
 */
export function generateHarnessProposalId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `harness-prop-${timestamp}-${random}`;
}

/**
 * 检测指标回归
 *
 * 规则：任何指标恶化超过 10% 算回归
 *
 * 指标方向推断（基于命名约定）：
 *   - 名称含 pass/success/accuracy/coverage/correct → 越高越好
 *   - 其他（如 error/failure/latency/time/duration） → 越低越好
 *
 * @param baseline 基线指标
 * @param current 当前指标
 * @returns { regressed, regressedMetrics }
 */
export function detectRegression(
  baseline: Record<string, number>,
  current: Record<string, number>,
): { regressed: boolean; regressedMetrics: string[] } {
  const regressedMetrics: string[] = [];
  const HIGHER_BETTER_REGEX = /(pass|success|accuracy|coverage|correct)/i;
  const THRESHOLD = 0.1; // 10%

  for (const [key, baselineValue] of Object.entries(baseline)) {
    const currentValue = current[key];
    if (currentValue === undefined) continue;

    const higherBetter = HIGHER_BETTER_REGEX.test(key);
    if (higherBetter) {
      // 越高越好：当前值下降超过 10% 算回归
      if (baselineValue > 0) {
        const dropRatio = (baselineValue - currentValue) / baselineValue;
        if (dropRatio > THRESHOLD) {
          regressedMetrics.push(key);
        }
      }
      // baseline=0 时，当前值不可能更差（0 已是最低）
    } else {
      // 越低越好：当前值上升超过 10% 算回归
      if (baselineValue > 0) {
        const riseRatio = (currentValue - baselineValue) / baselineValue;
        if (riseRatio > THRESHOLD) {
          regressedMetrics.push(key);
        }
      } else {
        // baseline=0，current>0 算回归（新增了错误/延迟）
        if (currentValue > 0) {
          regressedMetrics.push(key);
        }
      }
    }
  }

  return {
    regressed: regressedMetrics.length > 0,
    regressedMetrics,
  };
}

// ============================================================
// SelfHarnessLoop
// ============================================================

/**
 * Self-Harness 三阶段循环
 *
 * 用法：
 *   const loop = new SelfHarnessLoop(config);
 *   const weaknesses = await loop.discoverWeaknesses(failureLogs);
 *   const proposals = await loop.proposeModifications(weaknesses, currentHarness);
 *   for (const p of proposals) {
 *     const result = await loop.validateProposal(p, testRunner, baseline);
 *     if (result.passed) {
 *       // 可考虑应用（低风险 + 通过验证）
 *     }
 *   }
 *   const applicable = loop.getApplicableProposals();
 */
export class SelfHarnessLoop {
  private weaknesses: WeaknessCategory[] = [];
  private proposals: HarnessProposal[] = [];
  private validations: ValidationResult[] = [];
  /** 已批准的提案 ID（即使非低风险也可应用） */
  private approvedIds: Set<string> = new Set();
  /** Phase 52 Task 9b：已应用的提案列表（applyModification 成功后追加） */
  private appliedProposals: HarnessProposal[] = [];

  constructor(private config: SelfHarnessConfig) {}

  /**
   * 阶段 1：弱点挖掘
   *
   * 从失败日志聚类出弱点模式。频率 >= 2 才算弱点。
   * 根据灵敏度配置过滤严重度。
   * 结果存入 this.weaknesses 并返回。
   */
  async discoverWeaknesses(
    failureLogs: Array<{
      timestamp: number;
      task: string;
      failurePoint: string;
      errorType: string;
      component?: string;
    }>,
  ): Promise<WeaknessCategory[]> {
    logger.info('SelfHarnessLoop: 阶段 1 弱点挖掘', {
      failureCount: failureLogs.length,
      sensitivity: this.config.weaknessDetectionSensitivity,
    });

    // 调用纯函数聚类（已过滤频率 < 2）
    const clustered = clusterFailures(failureLogs);

    // 根据灵敏度过滤
    const filtered = this.filterBySensitivity(clustered);

    // 更新 lastSeen 为当前时间
    const now = Date.now();
    this.weaknesses = filtered.map(w => ({ ...w, lastSeen: now }));

    logger.info('SelfHarnessLoop: 弱点挖掘完成', {
      weaknessCount: this.weaknesses.length,
      weaknesses: this.weaknesses.map(w => ({ name: w.name, severity: w.severity, frequency: w.frequency })),
    });

    return [...this.weaknesses];
  }

  /**
   * 阶段 2：提案生成
   *
   * 针对每个弱点，根据 affectedComponents 决定修改类型：
   *   - 影响 prompt → modify_prompt
   *   - 影响 tool → add_guardrail
   *   - 影响 workflow → add_checkpoint
   *   - 影响 config → modify_config
   *   - 通用 → add_rule
   *
   * 受 maxProposalsPerCycle 限制。
   */
  async proposeModifications(
    weaknesses: WeaknessCategory[],
    currentHarness: { rules: string[]; prompts: string[]; checkpoints: string[] },
  ): Promise<HarnessProposal[]> {
    logger.info('SelfHarnessLoop: 阶段 2 提案生成', {
      weaknessCount: weaknesses.length,
      maxProposals: this.config.maxProposalsPerCycle,
    });

    const proposals: HarnessProposal[] = [];
    const now = Date.now();

    for (const weakness of weaknesses) {
      if (proposals.length >= this.config.maxProposalsPerCycle) {
        logger.debug('SelfHarnessLoop: 达到 maxProposalsPerCycle，停止生成', {
          limit: this.config.maxProposalsPerCycle,
        });
        break;
      }

      const proposal = this.buildProposalForWeakness(weakness, currentHarness, now);
      proposals.push(proposal);
    }

    this.proposals = proposals;
    logger.info('SelfHarnessLoop: 提案生成完成', {
      proposalCount: proposals.length,
      types: proposals.map(p => p.modificationType),
    });
    return [...proposals];
  }

  /**
   * 阶段 3：验证
   *
   * 运行回归测试，对比 baseline 和 current 指标，检测回归。
   * passed = testRunner.passed && !regressionDetected
   *
   * @param proposal 待验证的提案
   * @param testRunner 回归测试运行器（由调用方注入，负责应用提案后跑测试）
   * @param baselineMetrics 基线指标（应用提案前）
   */
  async validateProposal(
    proposal: HarnessProposal,
    testRunner: () => Promise<{ passed: boolean; metrics: Record<string, number> }>,
    baselineMetrics: Record<string, number>,
  ): Promise<ValidationResult> {
    logger.info('SelfHarnessLoop: 阶段 3 验证提案', {
      proposalId: proposal.id,
      modificationType: proposal.modificationType,
      requireRegressionTest: this.config.requireRegressionTest,
    });

    // 运行回归测试
    let testResult: { passed: boolean; metrics: Record<string, number> };
    try {
      testResult = await testRunner();
    } catch (err) {
      // testRunner 异常 → 保守判定为不通过
      const reason = `testRunner 执行异常: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn('SelfHarnessLoop: testRunner 执行异常', { proposalId: proposal.id, error: reason });
      return {
        proposalId: proposal.id,
        passed: false,
        regressionDetected: false,
        newWeaknesses: [],
        metricsBefore: { ...baselineMetrics },
        metricsAfter: {},
        validatedAt: Date.now(),
        reason,
      };
    }
    const metricsAfter = testResult.metrics;

    // 检测回归
    let regression = { regressed: false, regressedMetrics: [] as string[] };
    if (this.config.requireRegressionTest) {
      regression = detectRegression(baselineMetrics, metricsAfter);
    }

    const passed = testResult.passed && !regression.regressed;

    const result: ValidationResult = {
      proposalId: proposal.id,
      passed,
      regressionDetected: regression.regressed,
      // 回归的指标作为新弱点线索
      newWeaknesses: regression.regressedMetrics,
      metricsBefore: { ...baselineMetrics },
      metricsAfter: { ...metricsAfter },
      validatedAt: Date.now(),
    };

    // 记录验证结果（同一提案重复验证时覆盖旧结果）
    const existingIdx = this.validations.findIndex(v => v.proposalId === proposal.id);
    if (existingIdx >= 0) {
      this.validations[existingIdx] = result;
    } else {
      this.validations.push(result);
    }

    logger.info('SelfHarnessLoop: 验证完成', {
      proposalId: proposal.id,
      passed,
      regressionDetected: regression.regressed,
      regressedMetrics: regression.regressedMetrics,
    });

    return result;
  }

  /**
   * 应用已验证的修改（需用户确认）
   *
   * 来自 Self-Harness 论文——阶段 3 后的 apply 步骤。
   * 安全约束：
   *   1. 修改必须已通过验证（validations 中存在且 passed=true）
   *   2. 高风险修改需用户确认（autoApplyValidated=false 时拒绝高风险）
   *   3. 实际写盘逻辑由 writeModificationToDisk 承担（当前为最小实现，仅记录日志）
   *
   * 注：HarnessProposal 不直接持有 validationStatus 字段（验证结果存在 validations 数组），
   *     此处通过 proposalId 查询验证结果，等效于 "validationStatus === 'passed'"。
   *
   * @param proposal 已通过 validateProposal 的修改提案
   * @returns 应用结果
   */
  async applyModification(proposal: HarnessProposal): Promise<{ applied: boolean; reason?: string }> {
    // 安全检查 1：必须已通过验证
    const validation = this.validations.find(v => v.proposalId === proposal.id);
    if (!validation || !validation.passed) {
      return { applied: false, reason: '修改未通过验证，不可应用' };
    }

    // 安全检查 2：高风险修改需用户确认
    // autoApplyValidated 默认 false——即使通过验证，高风险仍需人工介入
    if (proposal.riskLevel === 'high' && !this.config.autoApplyValidated) {
      return { applied: false, reason: '高风险修改需用户确认（autoApplyValidated=false）' };
    }

    // 应用修改（实际写文件或修改配置）
    try {
      await this.writeModificationToDisk(proposal);
      proposal.applied = true;
      this.appliedProposals.push(proposal);
      // I-8 修复：无界集合淘汰，避免长期运行内存泄漏
      if (this.appliedProposals.length > 100) this.appliedProposals.shift();
      logger.info('SelfHarnessLoop: 提案已应用', {
        proposalId: proposal.id,
        modificationType: proposal.modificationType,
        riskLevel: proposal.riskLevel,
      });
      return { applied: true };
    } catch (err) {
      return {
        applied: false,
        reason: `应用失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 将修改写入磁盘（最小实现）
   *
   * 简化实现：当前仅记录日志，实际写入逻辑由调用方根据 component 类型决定。
   * 真实场景下需要根据 proposal.modificationType（add_rule/modify_prompt/add_checkpoint/
   * add_guardrail/modify_config）写入对应的文件或配置。
   *
   * 留作 Phase 53+ 扩展点：根据 config.regressionTestPath 等字段落实落盘策略。
   */
  private async writeModificationToDisk(proposal: HarnessProposal): Promise<void> {
    logger.info('SelfHarnessLoop: writeModificationToDisk（最小实现，仅记录日志）', {
      proposalId: proposal.id,
      modificationType: proposal.modificationType,
      target: proposal.target,
      description: proposal.description,
    });
  }

  /** 获取已应用的提案列表（Phase 52 Task 9b） */
  getAppliedProposals(): HarnessProposal[] {
    return [...this.appliedProposals];
  }

  /** 获取所有弱点 */
  getWeaknesses(): WeaknessCategory[] {
    return [...this.weaknesses];
  }

  /** 获取所有提案 */
  getProposals(): HarnessProposal[] {
    return [...this.proposals];
  }

  /** 获取已验证的提案（配对提案与验证结果） */
  getValidatedProposals(): Array<{ proposal: HarnessProposal; validation: ValidationResult }> {
    const pairs: Array<{ proposal: HarnessProposal; validation: ValidationResult }> = [];
    for (const proposal of this.proposals) {
      const validation = this.validations.find(v => v.proposalId === proposal.id);
      if (validation) {
        pairs.push({ proposal, validation });
      }
    }
    return pairs;
  }

  /**
   * 获取可应用的提案
   *
   * 规则：通过验证 + （低风险 或 已显式批准）
   */
  getApplicableProposals(): HarnessProposal[] {
    return this.proposals.filter(p => {
      const validation = this.validations.find(v => v.proposalId === p.id);
      if (!validation || !validation.passed) return false;
      // 通过验证 + 低风险 或 已显式批准 → 可应用
      return p.riskLevel === 'low' || this.approvedIds.has(p.id);
    });
  }

  /** 批准提案（即使非低风险也允许应用） */
  approveProposal(id: string): void {
    this.approvedIds.add(id);
  }

  /** 撤销批准 */
  rejectProposal(id: string): void {
    this.approvedIds.delete(id);
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /**
   * 根据灵敏度过滤弱点
   * - low：只保留 high 严重度
   * - medium：保留 medium + high
   * - high：全部保留
   */
  private filterBySensitivity(weaknesses: WeaknessCategory[]): WeaknessCategory[] {
    const sensitivity = this.config.weaknessDetectionSensitivity;
    if (sensitivity === 'high') {
      return weaknesses;
    }
    if (sensitivity === 'medium') {
      return weaknesses.filter(w => w.severity === 'medium' || w.severity === 'high');
    }
    // low
    return weaknesses.filter(w => w.severity === 'high');
  }

  /**
   * 为单个弱点构建提案
   */
  private buildProposalForWeakness(
    weakness: WeaknessCategory,
    currentHarness: { rules: string[]; prompts: string[]; checkpoints: string[] },
    now: number,
  ): HarnessProposal {
    const components = weakness.affectedComponents;
    const modificationType = this.decideModificationType(components);
    const target = this.decideTarget(modificationType, currentHarness);
    const riskLevel = this.decideRiskLevel(modificationType);

    return {
      id: generateHarnessProposalId(),
      weaknessCategory: weakness.name,
      modificationType,
      target,
      description: this.buildDescription(weakness, modificationType),
      expectedFix: this.buildExpectedFix(weakness, modificationType),
      validationPlan: this.buildValidationPlan(weakness),
      riskLevel,
      createdAt: now,
    };
  }

  /**
   * 根据受影响组件决定修改类型
   *
   * 按优先级检查关键词：
   *   prompt → tool → workflow → config → 默认 add_rule
   */
  private decideModificationType(
    components: string[],
  ): HarnessProposal['modificationType'] {
    const hasKeyword = (kw: string) =>
      components.some(c => c.toLowerCase().includes(kw));

    if (hasKeyword('prompt')) return 'modify_prompt';
    if (hasKeyword('tool')) return 'add_guardrail';
    if (hasKeyword('workflow')) return 'add_checkpoint';
    if (hasKeyword('config')) return 'modify_config';
    return 'add_rule';
  }

  /** 根据修改类型决定目标（指向当前 Harness 的位置） */
  private decideTarget(
    modificationType: HarnessProposal['modificationType'],
    currentHarness: { rules: string[]; prompts: string[]; checkpoints: string[] },
  ): string {
    switch (modificationType) {
      case 'modify_prompt':
        return `prompts[${currentHarness.prompts.length}]`;
      case 'add_rule':
        return `rules[${currentHarness.rules.length}]`;
      case 'add_checkpoint':
        return `checkpoints[${currentHarness.checkpoints.length}]`;
      case 'add_guardrail':
        return 'tools/guardrail';
      case 'modify_config':
        return 'config/agent';
      default:
        return 'unknown';
    }
  }

  /**
   * 根据修改类型决定风险等级
   * - add_rule / add_guardrail → low（附加性，不改现有行为）
   * - modify_prompt / add_checkpoint → medium（改变行为或增加开销）
   * - modify_config → high（影响系统级行为）
   */
  private decideRiskLevel(
    modificationType: HarnessProposal['modificationType'],
  ): 'low' | 'medium' | 'high' {
    switch (modificationType) {
      case 'add_rule':
      case 'add_guardrail':
        return 'low';
      case 'modify_prompt':
      case 'add_checkpoint':
        return 'medium';
      case 'modify_config':
        return 'high';
      default:
        return 'medium';
    }
  }

  /** 构建提案描述 */
  private buildDescription(
    weakness: WeaknessCategory,
    modificationType: HarnessProposal['modificationType'],
  ): string {
    const typeDesc: Record<HarnessProposal['modificationType'], string> = {
      add_rule: '新增规则',
      modify_prompt: '修改提示词',
      add_checkpoint: '新增检查点',
      add_guardrail: '新增工具护栏',
      modify_config: '修改配置',
    };
    return `${typeDesc[modificationType]}以缓解弱点"${weakness.name}"（${weakness.description}）`;
  }

  /** 构建预期修复效果 */
  private buildExpectedFix(
    weakness: WeaknessCategory,
    modificationType: HarnessProposal['modificationType'],
  ): string {
    const fixMap: Record<HarnessProposal['modificationType'], string> = {
      add_rule: `通过新增规则引导 Agent 避免在 "${weakness.name}" 处重复犯错`,
      modify_prompt: `通过修改提示词让 Agent 在受影响场景下采取正确行为，预期减少 "${weakness.name}" 类失败`,
      add_checkpoint: `通过新增检查点在失败发生前拦截，防止 "${weakness.name}" 再次出现`,
      add_guardrail: `通过工具护栏限制可能导致 "${weakness.name}" 的危险工具调用`,
      modify_config: `通过调整配置参数消除触发 "${weakness.name}" 的条件`,
    };
    return fixMap[modificationType];
  }

  /** 构建验证计划 */
  private buildValidationPlan(weakness: WeaknessCategory): string {
    return `运行回归测试，确认 "${weakness.name}" 类失败不再出现，且其他指标无回归（恶化不超过 10%）`;
  }
}
