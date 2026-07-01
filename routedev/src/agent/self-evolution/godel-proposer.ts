// src/agent/self-evolution/godel-proposer.ts
// Phase 52 Task 8：Gödel 式自修改建议（安全版）
//
// 来源：Gödel Agent (arXiv 2410.04444, 北大+UCSB, ACL 2025) 的自指递归自改进框架
// 核心：Agent 通过分析自身执行轨迹，识别可改进的逻辑模式，产出修改建议
//
// 安全版设计原则（与原论文的关键差异）：
//   1. 只产出建议，不自动应用——Agent 不直接修改自己的逻辑
//   2. autoApplyLowRisk 默认 false；即使开启，也只自动应用 low 风险且 reversible 的提案
//   3. requireUserApproval 默认 true——所有提案默认需用户批准
//   4. applyProposal 不直接写文件，只标记状态并返回变更描述，由上层负责实际应用
//   5. 修改涉及安全/认证/权限的规则一律标记为 critical，不参与自动应用
//
// 设计要点：
//   1. 纯函数（identifyImprovementOpportunities / assessReversibility / generateGodelProposalId）
//      无副作用，可独立测试
//   2. GodelProposer 类负责状态管理（提案存储、审批、应用标记）
//   3. 风险评估基于 targetType + 内容关键词 + 可逆性三维度
//   4. 不依赖外部 LLM——基于规则启发式分析，零额外 token 消耗

import { logger } from '../../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** Gödel 提案——一次自修改建议的完整描述 */
export interface GodelProposal {
  /** 提案 ID（由 generateGodelProposalId 生成） */
  id: string;
  /** 要修改的文件路径 */
  targetFile: string;
  /** 修改目标类型 */
  targetType: 'prompt' | 'config' | 'skill' | 'rule';
  /** 当前内容（修改前的快照） */
  currentContent: string;
  /** 建议内容（修改后的完整内容） */
  proposedContent: string;
  /** 修改理由（基于哪些执行历史模式） */
  rationale: string;
  /** 预期效果（定量或定性描述） */
  expectedOutcome: string;
  /** 风险评估等级 */
  riskAssessment: 'low' | 'medium' | 'high' | 'critical';
  /** 是否可逆（基于 targetType 判定） */
  reversible: boolean;
  /** 创建时间戳（Unix ms） */
  createdAt: number;
}

/** Gödel 配置——控制提案器的行为 */
export interface GodelProposerConfig {
  /** 是否启用提案器 */
  enabled: boolean;
  /** 每次运行最多产出多少提案 */
  maxProposalsPerRun: number;
  /** 允许产出的目标类型 */
  allowedTargetTypes: Array<'prompt' | 'config' | 'skill' | 'rule'>;
  /** 是否自动应用低风险提案（默认 false） */
  autoApplyLowRisk: boolean;
  /** 是否需要用户批准（默认 true） */
  requireUserApproval: boolean;
}

/** 默认配置——安全优先 */
export const DEFAULT_GODEL_CONFIG: GodelProposerConfig = {
  enabled: false,
  maxProposalsPerRun: 5,
  allowedTargetTypes: ['prompt', 'config', 'skill', 'rule'],
  autoApplyLowRisk: false,
  requireUserApproval: true,
};

/** 执行历史条目（proposeModifications 的输入） */
export interface ExecutionHistoryEntry {
  task: string;
  outcome: 'success' | 'failure' | 'partial';
  failurePoint?: string;
  tokensUsed: number;
  durationMs: number;
}

/** 当前规则条目（proposeModifications 的输入） */
export interface CurrentRuleEntry {
  file: string;
  content: string;
  type: 'prompt' | 'config' | 'skill' | 'rule';
}

// ============================================================
// 常量
// ============================================================

/** 触发"重复失败模式"的最小出现次数 */
const REPEAT_FAILURE_THRESHOLD = 3;

/** 单次执行平均 token 消耗阈值（超过则建议精简 prompt） */
const TOKEN_HIGH_THRESHOLD = 50_000;

/** 单次执行平均耗时阈值（毫秒，超过则建议优化工作流） */
const DURATION_HIGH_THRESHOLD_MS = 60_000;

/** 安全敏感关键词——命中则风险升级为 critical */
const SECURITY_KEYWORDS = [
  'security',
  'auth',
  'permission',
  '权限',
  '安全',
  '认证',
  '密码',
  'password',
  'secret',
  'apikey',
  'api_key',
  'credential',
  'access_token', 'refresh_token', 'session_secret', 'session_key',  // I-4 修复：缩窄 'token'/'session' 为更精确短语
];

// ============================================================
// 纯函数
// ============================================================

/**
 * 纯函数：从执行历史识别改进机会
 *
 * 识别逻辑：
 *   1. 重复失败模式（同一 failurePoint 出现 ≥ 3 次）→ 建议修改 prompt 或 rule
 *   2. 任务描述中的高频关键词 → 暗示某个领域反复出错
 *
 * 注意：token 消耗与耗时分析不在本函数内（输入不含这些字段），
 *      由 GodelProposer.proposeModifications 直接处理。
 *
 * @param executionHistory 执行历史（仅需 task / outcome / failurePoint）
 * @returns 改进机会列表（area / issue / suggestion）
 */
export function identifyImprovementOpportunities(
  executionHistory: Array<{ task: string; outcome: string; failurePoint?: string }>,
): Array<{ area: string; issue: string; suggestion: string }> {
  const opportunities: Array<{ area: string; issue: string; suggestion: string }> = [];

  // 1. 重复失败模式分析
  const failurePointCounts = new Map<string, number>();
  for (const entry of executionHistory) {
    if (entry.outcome === 'failure' && entry.failurePoint) {
      const point = entry.failurePoint;
      failurePointCounts.set(point, (failurePointCounts.get(point) ?? 0) + 1);
    }
  }

  for (const [point, count] of failurePointCounts) {
    if (count >= REPEAT_FAILURE_THRESHOLD) {
      // 根据失败点关键词推断目标类型
      const pointLower = point.toLowerCase();
      let area = 'rule';
      if (pointLower.includes('prompt') || pointLower.includes('提示') || pointLower.includes('指令')) {
        area = 'prompt';
      } else if (pointLower.includes('skill') || pointLower.includes('技能')) {
        area = 'skill';
      } else if (pointLower.includes('config') || pointLower.includes('配置')) {
        area = 'config';
      } else if (pointLower.includes('rule') || pointLower.includes('规则')) {
        area = 'rule';
      }

      opportunities.push({
        area,
        issue: `失败模式 "${point}" 重复出现 ${count} 次，存在系统性缺陷`,
        suggestion: `建议在 ${area} 中增加针对 "${point}" 的处理逻辑或预防约束`,
      });
    }
  }

  // 2. 任务描述高频关键词分析（暗示某领域反复出错）
  const taskKeywordCounts = new Map<string, number>();
  for (const entry of executionHistory) {
    if (entry.outcome !== 'success') {
      // 提取任务描述中的关键中文词（简单分词：按标点切分后取长度 ≥ 2 的片段）
      const fragments = entry.task.split(/[，。、；：\s,.;:]+/).filter(s => s.length >= 2);
      for (const frag of fragments) {
        taskKeywordCounts.set(frag, (taskKeywordCounts.get(frag) ?? 0) + 1);
      }
    }
  }

  for (const [keyword, count] of taskKeywordCounts) {
    if (count >= REPEAT_FAILURE_THRESHOLD) {
      // 避免与失败模式重复
      const alreadyCovered = opportunities.some(o => o.issue.includes(keyword));
      if (!alreadyCovered) {
        opportunities.push({
          area: 'prompt',
          issue: `任务关键词 "${keyword}" 在非成功执行中出现 ${count} 次`,
          suggestion: `建议在 prompt 中增加针对 "${keyword}" 类任务的明确指引或约束`,
        });
      }
    }
  }

  return opportunities;
}

/**
 * 纯函数：评估修改的可逆性
 *
 * 判定规则（基于论文 8.3 节落地设计）：
 *   - prompt：可逆（git 跟踪，可回滚）
 *   - config：可逆（git 跟踪，可回滚）
 *   - skill：可逆（可删除新增的 skill 文件）
 *   - rule：不可逆（影响运行时行为，修改后无法保证状态一致）
 *
 * @param targetType 目标类型
 * @returns 是否可逆
 */
export function assessReversibility(
  targetType: 'prompt' | 'config' | 'skill' | 'rule',
): boolean {
  // rule 类型影响运行时行为，视为不可逆
  if (targetType === 'rule') {
    return false;
  }
  // prompt / config / skill 类型可通过 git 回滚或文件删除恢复
  return true;
}

/**
 * 纯函数：生成提案 ID
 *
 * 格式：godel_<时间戳 base36>_<随机 6 字符>
 * 保证单进程内极低碰撞概率，无需全局协调
 */
export function generateGodelProposalId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `godel_${timestamp}_${random}`;
}

// ============================================================
// GodelProposer 类
// ============================================================

/**
 * Gödel 提案器——Agent 自修改建议的安全版实现
 *
 * 职责：
 *   1. 分析执行历史，识别改进机会
 *   2. 为每个机会匹配合适的当前规则，生成修改提案
 *   3. 评估每个提案的风险与可逆性
 *   4. 提供审批/拒绝/应用的状态管理
 *
 * 不做的事：
 *   - 不直接写文件（applyProposal 只返回变更描述）
 *   - 不自动修改 Agent 自身逻辑
 *   - 不调用 LLM（纯规则启发式）
 */
export class GodelProposer {
  /** 已产出的所有提案 */
  private proposals: GodelProposal[] = [];
  /** 已批准的提案 ID */
  private approvedIds = new Set<string>();
  /** 已拒绝的提案 ID */
  private rejectedIds = new Set<string>();
  /** 已应用的提案 ID */
  private appliedIds = new Set<string>();

  constructor(private config: GodelProposerConfig) {}

  /**
   * 分析 Agent 的执行历史，产出修改建议
   *
   * 注意：这是 Gödel 思想的"安全版"——只产出建议，不自动应用
   *
   * 流程：
   *   1. 调用 identifyImprovementOpportunities 识别失败模式
   *   2. 分析 token 消耗，过高则建议精简 prompt
   *   3. 分析执行耗时，过长则建议优化工作流
   *   4. 为每个机会匹配当前规则并生成提案
   *   5. 评估风险与可逆性
   *   6. 按 maxProposalsPerRun 限制数量
   */
  async proposeModifications(
    executionHistory: ExecutionHistoryEntry[],
    currentRules: CurrentRuleEntry[],
  ): Promise<GodelProposal[]> {
    if (!this.config.enabled) {
      return [];
    }

    if (executionHistory.length === 0 || currentRules.length === 0) {
      return [];
    }

    const newProposals: GodelProposal[] = [];

    // 1. 失败模式分析（复用纯函数）
    const opportunities = identifyImprovementOpportunities(
      executionHistory.map(h => ({ task: h.task, outcome: h.outcome, failurePoint: h.failurePoint })),
    );

    for (const opp of opportunities) {
      const matchingRule = this.findMatchingRule(opp.area, currentRules);
      if (!matchingRule) continue;
      if (!this.config.allowedTargetTypes.includes(matchingRule.type)) continue;

      const proposedContent = this.generateProposedContent(matchingRule, opp);
      const proposal = this.buildProposal(matchingRule, proposedContent, opp.suggestion, opp.issue);
      newProposals.push(proposal);
    }

    // 2. token 消耗分析——过高则建议精简 prompt
    const totalTokens = executionHistory.reduce((sum, h) => sum + h.tokensUsed, 0);
    const avgTokens = executionHistory.length > 0 ? totalTokens / executionHistory.length : 0;

    if (avgTokens > TOKEN_HIGH_THRESHOLD) {
      const promptRule = currentRules.find(r => r.type === 'prompt');
      if (promptRule && this.config.allowedTargetTypes.includes('prompt')) {
        const proposedContent =
          promptRule.content +
          '\n\n<!-- Gödel 提案：Token 优化 -->\n' +
          '## Token 精简约束（基于执行历史）\n' +
          '- 优先使用简洁表达，避免重复上下文\n' +
          '- 工具返回正确时用一句话确认，不复述\n' +
          '- 思考过程控制在 5 个要点以内\n';
        const proposal = this.buildProposal(
          promptRule,
          proposedContent,
          `平均 token 消耗 ${Math.round(avgTokens)} 超过阈值 ${TOKEN_HIGH_THRESHOLD}，建议精简 prompt`,
          '降低单次执行 token 消耗 20-30%',
        );
        newProposals.push(proposal);
      }
    }

    // 3. 耗时分析——过长则建议优化工作流
    const totalDuration = executionHistory.reduce((sum, h) => sum + h.durationMs, 0);
    const avgDuration = executionHistory.length > 0 ? totalDuration / executionHistory.length : 0;

    if (avgDuration > DURATION_HIGH_THRESHOLD_MS) {
      const configRule = currentRules.find(r => r.type === 'config');
      if (configRule && this.config.allowedTargetTypes.includes('config')) {
        const proposedContent =
          configRule.content +
          '\n# Gödel 提案：工作流优化（基于执行历史）\n' +
          '# 平均耗时过高，启用以下优化：\n' +
          'workflowOptimization:\n' +
          '  enableParallelSteps: true   # 允许并行执行无依赖步骤\n' +
          '  skipRedundantChecks: true   # 跳过已验证的冗余检查\n';
        const proposal = this.buildProposal(
          configRule,
          proposedContent,
          `平均耗时 ${Math.round(avgDuration / 1000)}s 超过阈值 ${DURATION_HIGH_THRESHOLD_MS / 1000}s，建议优化工作流`,
          '降低单次执行耗时 15-25%',
        );
        newProposals.push(proposal);
      }
    }

    // 4. 去重：同一文件已有相同 rationale 的提案不重复添加
    const deduped = this.deduplicateProposals(newProposals);

    // 5. 限制提案数量
    const limited = deduped.slice(0, this.config.maxProposalsPerRun);

    // 6. 存储并返回
    this.proposals.push(...limited);
    // I-8 修复：无界集合淘汰，避免长期运行内存泄漏
    if (this.proposals.length > 100) this.proposals.shift();

    if (limited.length > 0) {
      logger.info?.(
        `[GodelProposer] 产出 ${limited.length} 个提案（共分析 ${executionHistory.length} 条历史，${opportunities.length} 个改进机会）`,
      );
    }

    return limited;
  }

  /**
   * 评估提案风险
   *
   * 风险等级判定：
   *   - critical：内容涉及安全/认证/权限关键词
   *   - high：修改核心 prompt 或不可逆变更
   *   - medium：修改 skill 定义
   *   - low：修改注释/文档/可逆配置
   */
  assessRisk(proposal: GodelProposal): 'low' | 'medium' | 'high' | 'critical' {
    const combined = `${proposal.targetFile}\n${proposal.currentContent}\n${proposal.proposedContent}`.toLowerCase();

    // 1. critical：涉及安全/认证/权限
    if (SECURITY_KEYWORDS.some(k => combined.includes(k.toLowerCase()))) {
      return 'critical';
    }

    // 2. high：修改核心 prompt 或不可逆变更
    if (proposal.targetType === 'prompt' || !proposal.reversible) {
      return 'high';
    }

    // 3. medium：修改 skill 定义
    if (proposal.targetType === 'skill') {
      return 'medium';
    }

    // 4. low：修改注释/文档/可逆配置
    return 'low';
  }

  /** 获取所有提案（不含已拒绝） */
  getProposals(): GodelProposal[] {
    return this.proposals.filter(p => !this.rejectedIds.has(p.id));
  }

  /**
   * 获取可应用的提案
   *
   * 可应用条件（满足其一）：
   *   1. 已被用户批准
   *   2. autoApplyLowRisk=true 且风险为 low 且可逆
   *
   * 排除条件：
   *   - 已拒绝
   *   - 已应用
   *   - critical 风险（即使批准也不自动应用，需人工处理）
   */
  getApplicableProposals(): GodelProposal[] {
    return this.proposals.filter(p => {
      if (this.rejectedIds.has(p.id) || this.appliedIds.has(p.id)) return false;
      if (p.riskAssessment === 'critical') return false;

      const isApproved = this.approvedIds.has(p.id);
      const canAutoApply =
        this.config.autoApplyLowRisk && p.riskAssessment === 'low' && p.reversible;

      return isApproved || canAutoApply;
    });
  }

  /** 标记提案已批准 */
  approveProposal(proposalId: string): void {
    const proposal = this.proposals.find(p => p.id === proposalId);
    if (!proposal) {
      logger.warn?.(`[GodelProposer] approveProposal: 提案 ${proposalId} 不存在`);
      return;
    }
    this.approvedIds.add(proposalId);
    // I-8 修复：无界集合淘汰，避免长期运行内存泄漏
    if (this.approvedIds.size > 1000) { for (const id of this.approvedIds) { this.approvedIds.delete(id); break; } }
    this.rejectedIds.delete(proposalId);
  }

  /** 标记提案已拒绝 */
  rejectProposal(proposalId: string): void {
    const proposal = this.proposals.find(p => p.id === proposalId);
    if (!proposal) {
      logger.warn?.(`[GodelProposer] rejectProposal: 提案 ${proposalId} 不存在`);
      return;
    }
    this.rejectedIds.add(proposalId);
    // I-8 修复：无界集合淘汰，避免长期运行内存泄漏
    if (this.rejectedIds.size > 1000) { for (const id of this.rejectedIds) { this.rejectedIds.delete(id); break; } }
    this.approvedIds.delete(proposalId);
  }

  /**
   * 应用提案（返回应用的变更描述）
   *
   * 安全版：不直接写文件，只标记状态并返回变更描述。
   * 实际的文件修改由上层（framework.ts / 用户审批流程）根据返回值处理。
   *
   * 应用条件（满足其一）：
   *   1. 提案已被批准
   *   2. autoApplyLowRisk=true 且风险为 low 且可逆
   *
   * 拒绝应用的条件：
   *   - 提案不存在
   *   - 已被拒绝
   *   - 已被应用
   *   - 风险为 critical（需人工处理）
   *   - 未满足上述应用条件
   */
  applyProposal(proposalId: string): { applied: boolean; description: string } {
    const proposal = this.proposals.find(p => p.id === proposalId);
    if (!proposal) {
      return { applied: false, description: `提案 ${proposalId} 不存在` };
    }

    if (this.rejectedIds.has(proposalId)) {
      return { applied: false, description: `提案 ${proposalId} 已被拒绝，无法应用` };
    }

    if (this.appliedIds.has(proposalId)) {
      return { applied: false, description: `提案 ${proposalId} 已应用，无需重复操作` };
    }

    if (proposal.riskAssessment === 'critical') {
      return {
        applied: false,
        description: `提案 ${proposalId} 风险等级为 critical，需人工处理，不自动应用`,
      };
    }

    const isApproved = this.approvedIds.has(proposalId);
    const canAutoApply =
      this.config.autoApplyLowRisk &&
      proposal.riskAssessment === 'low' &&
      proposal.reversible;

    if (!isApproved && !canAutoApply) {
      const reason = this.config.autoApplyLowRisk
        ? '需用户批准或为低风险可逆提案'
        : '需用户批准（autoApplyLowRisk=false）';
      return {
        applied: false,
        description: `提案 ${proposalId} 未满足应用条件：${reason}`,
      };
    }

    // 标记为已应用（安全版：不实际写文件）
    this.appliedIds.add(proposalId);
    // I-8 修复：无界集合淘汰，避免长期运行内存泄漏
    if (this.appliedIds.size > 1000) { for (const id of this.appliedIds) { this.appliedIds.delete(id); break; } }

    logger.info?.(
      `[GodelProposer] 应用提案 ${proposalId}（${proposal.targetType}: ${proposal.targetFile}，风险: ${proposal.riskAssessment}）`,
    );

    return {
      applied: true,
      description: `已应用提案 ${proposalId}：${proposal.rationale}（目标：${proposal.targetFile}，类型：${proposal.targetType}）`,
    };
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  /**
   * 根据改进机会的 area 匹配当前规则
   * 优先按 area 关键词匹配 targetType，找不到则返回 undefined
   */
  private findMatchingRule(
    area: string,
    currentRules: CurrentRuleEntry[],
  ): CurrentRuleEntry | undefined {
    const areaLower = area.toLowerCase();

    if (areaLower.includes('prompt') || areaLower.includes('提示')) {
      return currentRules.find(r => r.type === 'prompt');
    }
    if (areaLower.includes('rule') || areaLower.includes('规则')) {
      return currentRules.find(r => r.type === 'rule');
    }
    if (areaLower.includes('skill') || areaLower.includes('技能')) {
      return currentRules.find(r => r.type === 'skill');
    }
    if (areaLower.includes('config') || areaLower.includes('配置') || areaLower.includes('workflow')) {
      return currentRules.find(r => r.type === 'config');
    }

    // 兜底：返回第一个 prompt 类型规则（最常被优化）
    return currentRules.find(r => r.type === 'prompt');
  }

  /**
   * 生成建议内容（最小修改原则：在原内容末尾追加改进段落，不重写）
   */
  private generateProposedContent(
    rule: CurrentRuleEntry,
    opportunity: { area: string; issue: string; suggestion: string },
  ): string {
    const comment = `<!-- Gödel 提案改进：${opportunity.issue} -->`;
    const suggestion = `<!-- 建议：${opportunity.suggestion} -->`;

    if (rule.type === 'prompt') {
      // prompt 类型：追加一个改进约束段落
      return (
        rule.content +
        `\n\n${comment}\n${suggestion}\n## 改进约束（基于执行历史）\n- ${opportunity.suggestion}\n`
      );
    }

    if (rule.type === 'config') {
      // config 类型：追加注释段落
      return `${rule.content}\n\n${comment}\n${suggestion}\n`;
    }

    if (rule.type === 'skill') {
      // skill 类型：追加注意事项
      return `${rule.content}\n\n${comment}\n${suggestion}\n## 注意事项（基于执行历史）\n- ${opportunity.suggestion}\n`;
    }

    // rule 类型：追加注释（不修改实际规则逻辑，仅标注）
    return `${rule.content}\n\n${comment}\n${suggestion}\n`;
  }

  /**
   * 构建提案对象（统一风险评估入口）
   */
  private buildProposal(
    rule: CurrentRuleEntry,
    proposedContent: string,
    rationale: string,
    expectedOutcome: string,
  ): GodelProposal {
    const reversible = assessReversibility(rule.type);
    const proposal: GodelProposal = {
      id: generateGodelProposalId(),
      targetFile: rule.file,
      targetType: rule.type,
      currentContent: rule.content,
      proposedContent,
      rationale,
      expectedOutcome,
      riskAssessment: 'low', // 临时占位，下一行用 assessRisk 重新评估
      reversible,
      createdAt: Date.now(),
    };
    proposal.riskAssessment = this.assessRisk(proposal);
    return proposal;
  }

  /**
   * 去重：同一目标文件且 rationale 相同的提案只保留第一个
   */
  private deduplicateProposals(proposals: GodelProposal[]): GodelProposal[] {
    const seen = new Set<string>();
    const result: GodelProposal[] = [];
    for (const p of proposals) {
      const key = `${p.targetFile}::${p.rationale}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(p);
    }
    return result;
  }
}
