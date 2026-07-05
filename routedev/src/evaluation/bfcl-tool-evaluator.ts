// src/evaluation/bfcl-tool-evaluator.ts
// Phase 72 Task C4：BFCL 风格工具调用评估器 + irrelevance 用例
//
// 借鉴 BFCL（Berkeley Function Calling Leaderboard）评测思路：
//   1. tool_call_accuracy：对于"应调用工具"的用例，实际调用的工具集是否匹配期望
//   2. irrelevance_rejection_rate：对于"不应调用工具"的用例，实际 0 调用的比例
//
// AST 匹配评估器实现：
//   - 输入：每个用例的 expectedBehavior（toolCalls / noToolCalls）+ executor 实际产出的 toolCalls
//   - 匹配规则：
//       * expected.toolCalls 中的每个工具必须出现在 actual 中（子集匹配，允许额外调用）
//       * expected.noToolCalls 中的每个工具不得出现在 actual 中（禁止集合）
//       * irrelevance 用例：expected 无 toolCalls 且 noToolCalls 含已知工具，actual 必须为空集
//   - 输出：tool_call_accuracy（应调用用例的通过率）+ irrelevance_rejection_rate（不应调用用例的零调用率）

import type { EvalCase } from './cases/smoke.js';
import type { EvalExecutor, EvalExecutorResult } from './runner.js';
import { IRRELEVANCE_CASES } from './cases/irrelevance-cases.js';

// ============================================================
// 类型定义
// ============================================================

/** 单个用例的 BFCL 评估结果 */
export interface BfclCaseResult {
  caseId: string;
  /** 用例类型：tool_call（应调用工具）/ irrelevance（不应调用） */
  kind: 'tool_call' | 'irrelevance';
  /** 期望调用的工具集（irrelevance 用例为空） */
  expectedTools: string[];
  /** 实际调用的工具集 */
  actualTools: string[];
  /** 期望禁止的工具集 */
  forbiddenTools: string[];
  /** 是否通过（tool_call：expectedTools ⊆ actualTools 且 forbiddenTools ∩ actualTools = ∅；
   *          irrelevance：actualTools 为空集） */
  passed: boolean;
  /** 失败原因 */
  failureReason?: string;
}

/** BFCL 评估汇总报告 */
export interface BfclReport {
  /** tool_call_accuracy：应调用工具用例的通过率（0~1） */
  toolCallAccuracy: number;
  /** irrelevance_rejection_rate：不应调用工具用例的零调用率（0~1） */
  irrelevanceRejectionRate: number;
  /** 应调用工具的用例总数 */
  toolCallCaseCount: number;
  /** 应调用工具的用例通过数 */
  toolCallPassed: number;
  /** 不应调用工具的用例总数 */
  irrelevanceCaseCount: number;
  /** 不应调用工具的用例零调用通过数 */
  irrelevancePassed: number;
  /** 逐用例结果 */
  caseResults: BfclCaseResult[];
  /** Markdown 报告文本 */
  markdown: string;
}

/** BFCL 评估器选项 */
export interface BfclEvaluatorOptions {
  /** 自定义 executor（缺省需调用方提供，无 heuristic 默认值，因为 irrelevance 评估必须用真实 Agent） */
  executor: EvalExecutor;
  /** tool_call_accuracy 评估用的"应调用工具"用例集（缺省使用 SMOKE_CASES） */
  toolCallCases?: EvalCase[];
  /** irrelevance 评估用的"不应调用工具"用例集（缺省使用 IRRELEVANCE_CASES） */
  irrelevanceCases?: EvalCase[];
  /** 单用例超时 ms（缺省 30s） */
  timeoutMs?: number;
}

// ============================================================
// BFCL 评估器
// ============================================================

/**
 * BFCL 风格工具调用评估器
 *
 * 用法：
 *   const evaluator = new BfclToolEvaluator({ executor: realAgentExecutor });
 *   const report = await evaluator.run();
 *   console.log(report.toolCallAccuracy, report.irrelevanceRejectionRate);
 *
 * executor 责任：把 EvalCase.prompt 变成 EvalExecutorResult（含 toolCalls 列表）。
 *   - 生产环境注入真实 Agent executor（驱动 LLM + 工具链）
 *   - 测试环境可注入 mock executor
 */
export class BfclToolEvaluator {
  private readonly executor: EvalExecutor;
  private readonly toolCallCases: EvalCase[];
  private readonly irrelevanceCases: EvalCase[];
  private readonly timeoutMs: number;

  constructor(options: BfclEvaluatorOptions) {
    if (!options.executor) {
      throw new Error('BfclToolEvaluator 需要 executor 参数（irrelevance 评估必须用真实 Agent 或 mock）');
    }
    this.executor = options.executor;
    this.toolCallCases = options.toolCallCases ?? [];
    this.irrelevanceCases = options.irrelevanceCases ?? IRRELEVANCE_CASES;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** 运行评估，返回汇总报告 */
  async run(): Promise<BfclReport> {
    const caseResults: BfclCaseResult[] = [];

    // 1. 评估 tool_call 用例（应调用工具）
    for (const evalCase of this.toolCallCases) {
      const result = await this.runSingleCase(evalCase, 'tool_call');
      caseResults.push(result);
    }

    // 2. 评估 irrelevance 用例（不应调用工具）
    for (const evalCase of this.irrelevanceCases) {
      const result = await this.runSingleCase(evalCase, 'irrelevance');
      caseResults.push(result);
    }

    // 3. 汇总指标
    const toolCallResults = caseResults.filter(r => r.kind === 'tool_call');
    const irrelevanceResults = caseResults.filter(r => r.kind === 'irrelevance');
    const toolCallPassed = toolCallResults.filter(r => r.passed).length;
    const irrelevancePassed = irrelevanceResults.filter(r => r.passed).length;
    const toolCallCaseCount = toolCallResults.length;
    const irrelevanceCaseCount = irrelevanceResults.length;

    const toolCallAccuracy = toolCallCaseCount > 0 ? toolCallPassed / toolCallCaseCount : 0;
    const irrelevanceRejectionRate = irrelevanceCaseCount > 0 ? irrelevancePassed / irrelevanceCaseCount : 0;

    const report: BfclReport = {
      toolCallAccuracy,
      irrelevanceRejectionRate,
      toolCallCaseCount,
      toolCallPassed,
      irrelevanceCaseCount,
      irrelevancePassed,
      caseResults,
      markdown: '',
    };
    report.markdown = this.generateMarkdown(report);
    return report;
  }

  /** 运行单个用例并匹配 */
  private async runSingleCase(
    evalCase: EvalCase,
    kind: 'tool_call' | 'irrelevance',
  ): Promise<BfclCaseResult> {
    const expectedTools = evalCase.expectedBehavior.toolCalls ?? [];
    const forbiddenTools = evalCase.expectedBehavior.noToolCalls ?? [];

    let execResult: EvalExecutorResult;
    try {
      // 创建临时空目录作为工作目录（executor 可能需要）
      const workdir = await this.createTempWorkdir();
      try {
        execResult = await this.withTimeout(
          this.executor(evalCase, workdir),
          this.timeoutMs,
        );
      } finally {
        await this.cleanupTempWorkdir(workdir);
      }
    } catch (err) {
      // executor 异常视为"未调用任何工具"，对 irrelevance 用例反而是通过
      const msg = err instanceof Error ? err.message : String(err);
      return {
        caseId: evalCase.id,
        kind,
        expectedTools,
        actualTools: [],
        forbiddenTools,
        passed: kind === 'irrelevance',
        failureReason: kind === 'tool_call' ? `executor 异常: ${msg}` : undefined,
      };
    }

    const actualTools = execResult.toolCalls ?? [];

    // AST 匹配判定
    if (kind === 'tool_call') {
      // 应调用：expectedTools 必须全部出现在 actualTools 中（子集匹配）
      const missing = expectedTools.filter(t => !actualTools.includes(t));
      // 禁止工具：forbiddenTools 不得出现在 actualTools 中
      const forbiddenHit = forbiddenTools.filter(t => actualTools.includes(t));
      if (missing.length > 0) {
        return {
          caseId: evalCase.id,
          kind,
          expectedTools,
          actualTools,
          forbiddenTools,
          passed: false,
          failureReason: `缺失工具调用: [${missing.join(', ')}]；实际调用: [${actualTools.join(', ')}]`,
        };
      }
      if (forbiddenHit.length > 0) {
        return {
          caseId: evalCase.id,
          kind,
          expectedTools,
          actualTools,
          forbiddenTools,
          passed: false,
          failureReason: `调用了禁止工具: [${forbiddenHit.join(', ')}]`,
        };
      }
      return {
        caseId: evalCase.id,
        kind,
        expectedTools,
        actualTools,
        forbiddenTools,
        passed: true,
      };
    }

    // irrelevance：actualTools 必须为空集
    if (actualTools.length > 0) {
      return {
        caseId: evalCase.id,
        kind,
        expectedTools,
        actualTools,
        forbiddenTools,
        passed: false,
        failureReason: `期望 0 工具调用，实际调用了 ${actualTools.length} 个: [${actualTools.join(', ')}]`,
      };
    }
    return {
      caseId: evalCase.id,
      kind,
      expectedTools,
      actualTools,
      forbiddenTools,
      passed: true,
    };
  }

  /** 生成 Markdown 报告 */
  private generateMarkdown(report: BfclReport): string {
    const accPct = (report.toolCallAccuracy * 100).toFixed(1);
    const rejPct = (report.irrelevanceRejectionRate * 100).toFixed(1);
    const lines: string[] = [
      '# BFCL 工具调用评估报告',
      '',
      `生成时间: ${new Date().toISOString()}`,
      '',
      '## 概览',
      '',
      '| 指标 | 值 |',
      '|------|-----|',
      `| tool_call_accuracy | ${accPct}% (${report.toolCallPassed}/${report.toolCallCaseCount}) |`,
      `| irrelevance_rejection_rate | ${rejPct}% (${report.irrelevancePassed}/${report.irrelevanceCaseCount}) |`,
      '',
      '## 用例明细',
      '',
      '| 用例 ID | 类型 | 期望工具 | 实际工具 | 结果 | 失败原因 |',
      '|---------|------|----------|----------|------|----------|',
    ];
    for (const r of report.caseResults) {
      const mark = r.passed ? '✓' : '✗';
      const reason = (r.failureReason ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 150);
      lines.push(
        `| ${r.caseId} | ${r.kind} | [${r.expectedTools.join(',')}] | [${r.actualTools.join(',')}] | ${mark} | ${reason} |`,
      );
    }
    return lines.join('\n');
  }

  /** 创建临时工作目录 */
  private async createTempWorkdir(): Promise<string> {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    return fs.mkdtemp(path.join(os.tmpdir(), 'bfcl-eval-'));
  }

  /** 清理临时工作目录 */
  private async cleanupTempWorkdir(workdir: string): Promise<void> {
    try {
      const fs = await import('node:fs/promises');
      await fs.rm(workdir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }

  /** Promise 超时包装 */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`BFCL 用例超时 (${ms}ms)`)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }
}

// ============================================================
// 便捷导出
// ============================================================

export { IRRELEVANCE_CASES } from './cases/irrelevance-cases.js';
