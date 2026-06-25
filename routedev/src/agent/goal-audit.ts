// src/agent/goal-audit.ts
// Phase 40 Task 8：三层独立审计
//
// 三层审计：
//   1. CompletionGate（完成门）：typecheck / lint / tests 客观结果
//   2. VerifierLLM（验证器 LLM）：独立 LLM 对照 doneWhen 逐条核验
//   3. ReviewerAgent（审查员 Agent）：人工配置的审查员，可质疑结论
//
// 仲裁规则：
//   - completion_gate_first（默认）：CompletionGate 通过则整体通过，
//     除非 reviewer 有 error 级别质疑可推翻
//   - reviewer_first：reviewer 拒绝则整体拒绝
//   - all_must_pass：所有启用的层都通过才通过
//
// 设计原则：三层相互独立，任一层不可见另一层的内部推理，
// 避免锚定偏差（anchoring bias）。

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 审计层 */
export type AuditLayer = 'completion_gate' | 'verifier_llm' | 'reviewer_agent';

/** 单层审计结果 */
export interface AuditResult {
  /** 审计层 */
  layer: AuditLayer;
  /** 是否通过 */
  passed: boolean;
  /** 证据列表 */
  evidence: string[];
  /** 未通过的项 */
  missing?: string[];
  /** 严重度（reviewer 用） */
  severity?: 'info' | 'warning' | 'error';
}

/** 审计配置 */
export interface GoalAuditConfig {
  /** CompletionGate 配置 */
  completionGate: {
    enabled: boolean;
    runTypecheck: boolean;
    runLint: boolean;
    runTests: boolean;
  };
  /** VerifierLLM 配置 */
  verifierLlm: { enabled: boolean };
  /** ReviewerAgent 配置 */
  reviewerAgent: { enabled: boolean; profileId?: string };
  /** 仲裁规则 */
  arbitration: 'completion_gate_first' | 'reviewer_first' | 'all_must_pass';
}

/** 默认审计配置 */
export const DEFAULT_AUDIT_CONFIG: GoalAuditConfig = {
  completionGate: { enabled: true, runTypecheck: true, runLint: true, runTests: true },
  verifierLlm: { enabled: true },
  reviewerAgent: { enabled: false },
  arbitration: 'completion_gate_first',
};

/** audit() 入参 */
export interface AuditParams {
  /** 目标规范（用 doneWhen） */
  spec: { doneWhen: string[] };
  /** typecheck 结果 */
  typecheckPassed?: boolean;
  /** lint 结果 */
  lintPassed?: boolean;
  /** tests 结果 */
  testsPassed?: boolean;
  /** VerifierLLM 结果 */
  verifierResult?: {
    passed: boolean;
    evidence: string[];
    missing?: string[];
  };
  /** ReviewerAgent 结果 */
  reviewerResult?: {
    passed: boolean;
    evidence: string[];
    severity?: 'info' | 'warning' | 'error';
  };
}

/** audit() 返回 */
export interface AuditOutcome {
  overallPassed: boolean;
  results: AuditResult[];
  summary: string;
}

// ============================================================
// GoalAuditor
// ============================================================

export class GoalAuditor {
  private config: GoalAuditConfig;
  private results: AuditResult[] = [];

  constructor(config?: Partial<GoalAuditConfig>) {
    this.config = { ...DEFAULT_AUDIT_CONFIG, ...config };
  }

  /**
   * 执行审计
   *
   * 依次运行启用的层，收集结果，最后仲裁
   */
  async audit(params: AuditParams): Promise<AuditOutcome> {
    const results: AuditResult[] = [];
    const evidence: string[] = [];

    // 层 1：CompletionGate
    if (this.config.completionGate.enabled) {
      const gateResult = this.runCompletionGate(params);
      results.push(gateResult);
      evidence.push(`CompletionGate: ${gateResult.passed ? 'PASS' : 'FAIL'}`);
    }

    // 层 2：VerifierLLM
    if (this.config.verifierLlm.enabled) {
      const verifierResult = this.runVerifierLlm(params);
      results.push(verifierResult);
      evidence.push(`VerifierLLM: ${verifierResult.passed ? 'PASS' : 'FAIL'}`);
    }

    // 层 3：ReviewerAgent
    if (this.config.reviewerAgent.enabled) {
      const reviewerResult = this.runReviewerAgent(params);
      results.push(reviewerResult);
      evidence.push(`ReviewerAgent: ${reviewerResult.passed ? 'PASS' : 'FAIL'}`);
    }

    this.results = results;
    const overallPassed = this.arbitrate(results);

    const summary = this.buildSummary(overallPassed, results, evidence);
    logger.debug('GoalAuditor.audit', { overallPassed, layers: results.length });

    return { overallPassed, results, summary };
  }

  /**
   * 仲裁
   *
   * - completion_gate_first：CompletionGate 通过则整体通过，
   *   除非 reviewer 有 error 级别质疑可推翻
   * - reviewer_first：reviewer 拒绝则整体拒绝
   * - all_must_pass：所有层都通过才通过
   */
  private arbitrate(results: AuditResult[]): boolean {
    const gate = results.find((r) => r.layer === 'completion_gate');
    const reviewer = results.find((r) => r.layer === 'reviewer_agent');

    switch (this.config.arbitration) {
      case 'completion_gate_first': {
        // 没有 CompletionGate 时退化为 all_must_pass
        if (!gate) {
          return results.every((r) => r.passed);
        }
        // CompletionGate 失败 → 整体失败
        if (!gate.passed) return false;
        // CompletionGate 通过，但 reviewer 有 error 级别质疑 → 推翻
        if (reviewer && !reviewer.passed && reviewer.severity === 'error') {
          return false;
        }
        return true;
      }
      case 'reviewer_first': {
        // reviewer 启用时，reviewer 拒绝则整体拒绝
        if (reviewer && !reviewer.passed) return false;
        // reviewer 未启用或通过时，其他层也必须通过
        return results.every((r) => r.layer === 'reviewer_agent' || r.passed);
      }
      case 'all_must_pass': {
        return results.every((r) => r.passed);
      }
      default:
        return false;
    }
  }

  /** 获取最近一次审计的结果 */
  getResults(): AuditResult[] {
    return this.results;
  }

  /** 获取当前配置 */
  getConfig(): GoalAuditConfig {
    return this.config;
  }

  /** 更新配置（合并） */
  updateConfig(config: Partial<GoalAuditConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============================================================
  // 内部：各层执行
  // ============================================================

  /** CompletionGate：聚合 typecheck/lint/tests */
  private runCompletionGate(params: AuditParams): AuditResult {
    const evidence: string[] = [];
    const missing: string[] = [];
    const cfg = this.config.completionGate;

    if (cfg.runTypecheck) {
      if (params.typecheckPassed) {
        evidence.push('typecheck: PASS');
      } else {
        evidence.push('typecheck: FAIL');
        missing.push('类型检查未通过');
      }
    }
    if (cfg.runLint) {
      if (params.lintPassed) {
        evidence.push('lint: PASS');
      } else {
        evidence.push('lint: FAIL');
        missing.push('lint 检查未通过');
      }
    }
    if (cfg.runTests) {
      if (params.testsPassed) {
        evidence.push('tests: PASS');
      } else {
        evidence.push('tests: FAIL');
        missing.push('测试未通过');
      }
    }

    // doneWhen 项是否被客观证据覆盖（启发式：doneWhen 非空且 gate 全过则视为覆盖）
    const passed = missing.length === 0;
    return {
      layer: 'completion_gate',
      passed,
      evidence,
      missing: missing.length > 0 ? missing : undefined,
      severity: passed ? 'info' : 'error',
    };
  }

  /** VerifierLLM：对照 doneWhen 逐条核验 */
  private runVerifierLlm(params: AuditParams): AuditResult {
    // 若调用方提供了 verifierResult，直接采用
    if (params.verifierResult) {
      return {
        layer: 'verifier_llm',
        passed: params.verifierResult.passed,
        evidence: params.verifierResult.evidence,
        missing: params.verifierResult.missing,
        severity: params.verifierResult.passed ? 'info' : 'warning',
      };
    }
    // 未提供 verifierResult：默认按 doneWhen 是否为空判定
    const doneWhen = params.spec.doneWhen ?? [];
    if (doneWhen.length === 0) {
      return {
        layer: 'verifier_llm',
        passed: true,
        evidence: ['无 doneWhen 标准，VerifierLLM 跳过'],
        severity: 'info',
      };
    }
    // 无 verifier 结果时，视为未通过（保守）
    return {
      layer: 'verifier_llm',
      passed: false,
      evidence: ['VerifierLLM 未运行'],
      missing: doneWhen,
      severity: 'warning',
    };
  }

  /** ReviewerAgent：人工配置的审查员 */
  private runReviewerAgent(params: AuditParams): AuditResult {
    if (params.reviewerResult) {
      return {
        layer: 'reviewer_agent',
        passed: params.reviewerResult.passed,
        evidence: params.reviewerResult.evidence,
        severity: params.reviewerResult.severity ?? (params.reviewerResult.passed ? 'info' : 'warning'),
      };
    }
    // 未提供 reviewerResult：默认通过（reviewer 未运行不阻塞）
    return {
      layer: 'reviewer_agent',
      passed: true,
      evidence: ['ReviewerAgent 未运行，默认通过'],
      severity: 'info',
    };
  }

  /** 构建摘要 */
  private buildSummary(
    overallPassed: boolean,
    results: AuditResult[],
    evidence: string[],
  ): string {
    const lines: string[] = [
      `# Audit Summary`,
      '',
      `Overall: ${overallPassed ? 'PASSED' : 'FAILED'}`,
      `Arbitration: ${this.config.arbitration}`,
      '',
      `## Layer Results`,
      ...evidence.map((e) => `- ${e}`),
      '',
      `## Details`,
      ...results.map((r) => {
        const miss = r.missing && r.missing.length > 0 ? ` (missing: ${r.missing.join('; ')})` : '';
        const sev = r.severity ? ` [${r.severity}]` : '';
        return `- ${r.layer}${sev}: ${r.passed ? 'PASS' : 'FAIL'}${miss}`;
      }),
      '',
    ];
    return lines.join('\n');
  }
}
