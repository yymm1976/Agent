// src/agent/reviewer-tier-evaluator.ts
// Phase 51 Task 1 & Task 7：Reviewer 分级与审查反馈协议
//
// 借鉴来源：
//   - ohmypi 的 Reviewer 三档分级（tiny / medium / big / high-risk）
//     工程化弱点：分级阈值全靠自然语言，无配置字段，无自动跨模型
//     RouteDev 改进：阈值配置化 + high-risk 自动判定 + 跨模型自动选择
//   - Flue 的"审查反馈三件证据"协议
//     review feedback is input, not requirements——反馈是参考输入，
//     主 Agent 自己决定是否采纳；禁止仅为满足重复审查而改动
//
// 本文件全部为纯函数（无副作用、无 IO），便于测试与组合。
// 接线（dual-loop-orchestrator / cross-model-reviewer / schema）由主 Agent 统一处理。

// ============================================================
// 类型定义
// ============================================================

/**
 * Reviewer 分级
 * 借鉴 ohmypi 的三档，扩展为四档：
 *   - tiny：极小任务，跳过外循环
 *   - medium：中等任务，一轮 final 审查
 *   - big：大任务，一轮 mid-work + 一轮 final 审查
 *   - high-risk：高风险任务，mid-work + final + 跨模型审查
 */
export type ReviewerTier = 'tiny' | 'medium' | 'big' | 'high-risk';

/**
 * 结构化审查反馈
 * 借鉴 Flue 的"三件证据"协议：
 *   1. 具体的正确性/耐久性风险
 *   2. 清晰的失败场景或被违反的不变量
 *   3. 相关 file:line 证据
 *
 * "review feedback is input, not requirements"——
 * suggestedFix 是建议而非强制，主 Agent 可不采纳。
 */
export interface StructuredReviewFeedback {
  /** 审查总结（人类可读） */
  summary: string;
  /** 风险列表 */
  risks: Array<{
    /** 具体的正确性/耐久性风险描述 */
    description: string;
    /** 清晰的失败场景（当此风险发生时会发生什么） */
    failureScenario: string;
    /** 被违反的不变量（项目隐含或显式的约束） */
    violatedInvariant: string;
    /** file:line 证据列表（enforceEvidenceProtocol=true 时至少一条） */
    evidence: Array<{
      /** 文件路径（相对项目根） */
      file: string;
      /** 行号（从 1 开始） */
      line: number;
      /** 可选的代码摘录 */
      excerpt?: string;
    }>;
    /** 严重等级：blocking 必须修复 / warning 建议修复 / info 可选改进 */
    severity: 'blocking' | 'warning' | 'info';
    /** 建议修复方案（非强制，主 Agent 可不采纳） */
    suggestedFix?: string;
  }>;
  /** 总体结论：pass / conditional / fail */
  overallVerdict: 'pass' | 'conditional' | 'fail';
}

/**
 * 风险评估结果
 * 借鉴 ohmypi 的"high-risk"概念，但算法化判定
 */
export interface RiskAssessment {
  /** 是否高风险（riskScore >= highRiskThreshold） */
  isHighRisk: boolean;
  /** 风险评分（0-100） */
  riskScore: number;
  /** 触发的风险因子列表（如 'security'、'data-integrity'） */
  riskFactors: string[];
}

// ============================================================
// 纯函数
// ============================================================

/**
 * Reviewer 分级判定
 *
 * 借鉴 ohmypi 的三档分级，但基于可配置的 step 阈值。
 * 优先级：high-risk > tiny > big > medium
 *
 * @param taskSteps 任务步骤数
 * @param isHighRisk 是否高风险（由 assessRisk 判定）
 * @param policy 阈值策略（tinyTaskStepThreshold / bigTaskStepThreshold）
 */
export function determineReviewerTier(
  taskSteps: number,
  isHighRisk: boolean,
  policy: { tinyTaskStepThreshold: number; bigTaskStepThreshold: number },
): ReviewerTier {
  // 高风险优先级最高——无论规模都走 high-risk 流程
  if (isHighRisk) return 'high-risk';
  // 小于阈值：tiny（跳过外循环，节省 token）
  if (taskSteps < policy.tinyTaskStepThreshold) return 'tiny';
  // 大于阈值：big（两轮审查）
  if (taskSteps > policy.bigTaskStepThreshold) return 'big';
  // 中等规模：medium（一轮 final 审查）
  return 'medium';
}

/**
 * 根据分级决定审查轮次
 *
 * 策略映射：
 *   - tiny      → 不审查（节省 token，适合 1-2 步的琐碎任务）
 *   - medium    → 仅 final 一轮
 *   - big       → mid-work 一轮 + final 一轮（早发现问题早返工）
 *   - high-risk → mid-work + final + 跨模型（打破自评盲区）
 *
 * @returns midWork：mid-work 审查轮次；final：final 审查轮次；crossModel：是否跨模型
 */
export function getReviewPassesForTier(tier: ReviewerTier): {
  midWork: number;
  final: number;
  crossModel: boolean;
} {
  switch (tier) {
    case 'tiny':
      return { midWork: 0, final: 0, crossModel: false };
    case 'medium':
      return { midWork: 0, final: 1, crossModel: false };
    case 'big':
      return { midWork: 1, final: 1, crossModel: false };
    case 'high-risk':
      return { midWork: 1, final: 1, crossModel: true };
  }
}

/**
 * High-risk 自动判定
 *
 * 借鉴 ohmypi 的"high-risk"概念，但用算法化的风险评分代替主观判断。
 *
 * 评分规则（累积）：
 *   - affectsSecurity          +40  （安全/认证/权限，单项即 high-risk）
 *   - affectsDataIntegrity     +30  （数据完整性，单项即 high-risk）
 *   - crossModuleChange        +15  （跨模块改动，易引发回归）
 *   - hasExternalSideEffects   +10  （网络/进程等外部副作用）
 *   - stepCount > 30           +5   （大任务，易遗漏）
 *   - affectsFileSystem        +5   （文件系统写操作）
 *
 * high-risk 阈值默认 40（即 security 或 data-integrity 单项触发）。
 *
 * @param context 风险因子上下文
 * @returns RiskAssessment（含 isHighRisk / riskScore / riskFactors）
 */
export function assessRisk(context: {
  affectsSecurity: boolean;
  affectsDataIntegrity: boolean;
  affectsFileSystem: boolean;
  stepCount: number;
  crossModuleChange: boolean;
  hasExternalSideEffects: boolean;
}, highRiskThreshold: number = 40): RiskAssessment {
  const factors: string[] = [];
  let score = 0;

  if (context.affectsSecurity) {
    factors.push('security');
    score += 40;
  }
  if (context.affectsDataIntegrity) {
    factors.push('data-integrity');
    score += 30;
  }
  if (context.crossModuleChange) {
    factors.push('cross-module');
    score += 15;
  }
  if (context.hasExternalSideEffects) {
    factors.push('external-side-effects');
    score += 10;
  }
  if (context.stepCount > 30) {
    factors.push('large-step-count');
    score += 5;
  }
  if (context.affectsFileSystem) {
    factors.push('filesystem-write');
    score += 5;
  }

  return {
    isHighRisk: score >= highRiskThreshold,
    riskScore: Math.min(score, 100),
    riskFactors: factors,
  };
}

/**
 * 跨模型审查的模型选择
 *
 * 借鉴 ohmypi 未实现的"跨模型审查"，RouteDev 自动化：
 *   1. 提取 primary model 的家族（openai/anthropic/google/alibaba/zhipu/unknown）
 *   2. 在可用模型中找不同家族的（优先真正跨家族，打破自评盲区）
 *   3. 无跨家族模型可用时返回 null（由调用方决定回退策略）
 *
 * @param primaryModelId 内循环使用的模型 ID
 * @param availableModels 可用模型 ID 列表
 * @returns 选中的跨模型 reviewer ID；无可用时返回 null
 */
export function selectCrossModelReviewer(
  primaryModelId: string,
  availableModels: string[],
): string | null {
  const primaryFamily = extractModelFamily(primaryModelId);

  // 在可用模型中找不同家族的——首个匹配即返回
  // （调用方可在外层用更强的排序策略，本函数只保证家族不同）
  const crossModel = availableModels.find(
    (m) => extractModelFamily(m) !== primaryFamily,
  );
  return crossModel ?? null;
}

/**
 * 提取模型家族
 *
 * 通过模型 ID 中的关键词识别家族：
 *   - gpt / openai → openai
 *   - claude / anthropic → anthropic
 *   - gemini / google → google
 *   - qwen / alibaba → alibaba
 *   - glm / zhipu → zhipu
 *   - 其它 → unknown
 *
 * 大小写不敏感。
 */
function extractModelFamily(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes('gpt') || id.includes('openai')) return 'openai';
  if (id.includes('claude') || id.includes('anthropic')) return 'anthropic';
  if (id.includes('gemini') || id.includes('google')) return 'google';
  if (id.includes('qwen') || id.includes('alibaba')) return 'alibaba';
  if (id.includes('glm') || id.includes('zhipu')) return 'zhipu';
  return 'unknown';
}

/**
 * 校验审查反馈是否符合"三件证据"协议
 *
 * 借鉴 Flue 的协议：当 enforceEvidenceProtocol=true 时，
 * 每个 risk 必须提供至少一条 evidence（含 file + line），
 * 且必须填写 description / failureScenario / violatedInvariant。
 *
 * enforceEvidenceProtocol=false 时仅做基本结构校验
 * （summary 非空、risks 是数组、overallVerdict 合法）。
 *
 * @param feedback 待校验的审查反馈
 * @param options.enforceEvidenceProtocol 是否强制三件证据协议
 * @returns { valid: boolean; errors: string[] }
 */
export function validateReviewFeedback(
  feedback: StructuredReviewFeedback,
  options: { enforceEvidenceProtocol: boolean },
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // ===== 基本结构校验（始终执行） =====

  // summary 必须非空字符串
  if (typeof feedback.summary !== 'string' || feedback.summary.trim().length === 0) {
    errors.push('summary 不能为空');
  }

  // overallVerdict 必须是合法值
  const validVerdicts: ReadonlyArray<StructuredReviewFeedback['overallVerdict']> = [
    'pass',
    'conditional',
    'fail',
  ];
  if (!validVerdicts.includes(feedback.overallVerdict)) {
    errors.push(`overallVerdict 必须是 ${validVerdicts.join(' / ')} 之一`);
  }

  // risks 必须是数组（允许空数组——表示无风险）
  if (!Array.isArray(feedback.risks)) {
    errors.push('risks 必须是数组');
    return { valid: false, errors };
  }

  const validSeverities: ReadonlyArray<'blocking' | 'warning' | 'info'> = [
    'blocking',
    'warning',
    'info',
  ];

  feedback.risks.forEach((risk, idx) => {
    const ctx = `risks[${idx}]`;

    // description 非空
    if (typeof risk.description !== 'string' || risk.description.trim().length === 0) {
      errors.push(`${ctx}.description 不能为空`);
    }

    // severity 合法
    if (!validSeverities.includes(risk.severity)) {
      errors.push(`${ctx}.severity 必须是 ${validSeverities.join(' / ')} 之一`);
    }

    // evidence 必须是数组
    if (!Array.isArray(risk.evidence)) {
      errors.push(`${ctx}.evidence 必须是数组`);
    } else {
      // 校验每条 evidence 的基本结构
      risk.evidence.forEach((ev, evIdx) => {
        const evCtx = `${ctx}.evidence[${evIdx}]`;
        if (typeof ev.file !== 'string' || ev.file.trim().length === 0) {
          errors.push(`${evCtx}.file 不能为空`);
        }
        if (
          typeof ev.line !== 'number' ||
          !Number.isInteger(ev.line) ||
          ev.line < 1
        ) {
          errors.push(`${evCtx}.line 必须是 >= 1 的整数`);
        }
      });
    }
  });

  // ===== 三件证据协议（enforceEvidenceProtocol=true 时额外校验） =====

  if (options.enforceEvidenceProtocol) {
    feedback.risks.forEach((risk, idx) => {
      const ctx = `risks[${idx}]`;

      // failureScenario 非空
      if (
        typeof risk.failureScenario !== 'string' ||
        risk.failureScenario.trim().length === 0
      ) {
        errors.push(`${ctx}.failureScenario 不能为空（enforceEvidenceProtocol=true）`);
      }

      // violatedInvariant 非空
      if (
        typeof risk.violatedInvariant !== 'string' ||
        risk.violatedInvariant.trim().length === 0
      ) {
        errors.push(
          `${ctx}.violatedInvariant 不能为空（enforceEvidenceProtocol=true）`,
        );
      }

      // 至少一条 evidence（含 file + line）
      const validEvidence = (risk.evidence ?? []).filter(
        (ev) =>
          typeof ev.file === 'string' &&
          ev.file.trim().length > 0 &&
          typeof ev.line === 'number' &&
          Number.isInteger(ev.line) &&
          ev.line >= 1,
      );
      if (validEvidence.length === 0) {
        errors.push(
          `${ctx} 至少需要一条 evidence（含 file + line）（enforceEvidenceProtocol=true）`,
        );
      }
    });
  }

  return { valid: errors.length === 0, errors };
}
