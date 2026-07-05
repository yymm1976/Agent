// src/cli/commands/eval.ts
// Phase 49 Task 5.4：/eval 命令——运行内置评估用例集
//
// 用法：
//   /eval smoke       运行 Smoke 10（核心工具冒烟）
//   /eval regression  运行 Regression 30（防退化回归）
//   /eval all         运行全部 40 个
//   /eval bfcl        运行 BFCL 工具调用评估（tool_call_accuracy + irrelevance_rejection_rate）
//   /eval list        列出所有用例
//   /eval             等价于 /eval list
//
// 实现说明：
//   - 默认使用 EvalRunner 内置的 heuristicExecutor（无 LLM 依赖，可在 CI 中跑通）
//   - 真实 LLM 评估由 app-init.ts 注入 executor（见 ServiceContext.evalExecutor）
//   - 报告以 Markdown 输出，便于复制到文档

import type { CommandDefinition } from '../command-registry.js';
import {
  EvalRunner,
  SMOKE_CASES,
  REGRESSION_CASES,
  ALL_EVAL_CASES,
  BfclToolEvaluator,
  IRRELEVANCE_CASES,
  type EvalExecutor,
} from '../../evaluation/index.js';

export const evalCommand: CommandDefinition = {
  name: 'eval',
  description: '运行内置评估用例集（smoke 10 / regression 30 / all 40 / bfcl / list）',
  usage: '/eval [smoke|regression|all|bfcl|list]',
  aliases: ['evaluate'],
  handler: async (args, ctx) => {
    const sub = (args.trim().toLowerCase() || 'list') as 'smoke' | 'regression' | 'all' | 'bfcl' | 'list';

    // /eval list：仅展示用例清单，不执行
    if (sub === 'list') {
      const lines = [
        '## 内置评估用例集',
        '',
        `### Smoke（${SMOKE_CASES.length} 个）`,
        ...SMOKE_CASES.map(c => `  - ${c.id}：${c.name} — ${c.description}`),
        '',
        `### Regression（${REGRESSION_CASES.length} 个）`,
        ...REGRESSION_CASES.map(c => `  - ${c.id}：${c.name} — ${c.description}`),
        '',
        `### Irrelevance（${IRRELEVANCE_CASES.length} 个，BFCL 评估用）`,
        ...IRRELEVANCE_CASES.map(c => `  - ${c.id}：${c.name} — ${c.description}`),
        '',
        `共 ${ALL_EVAL_CASES.length} 个常规用例 + ${IRRELEVANCE_CASES.length} 个 irrelevance 用例。`,
        '运行：/eval smoke | /eval regression | /eval all | /eval bfcl',
      ];
      return { type: 'handled', messages: [lines.join('\n')] };
    }

    // /eval bfcl：运行 BFCL 工具调用评估
    // - toolCallCases 用 SMOKE_CASES（每个有 expectedBehavior.toolCalls，验证"该调时调对"）
    // - irrelevanceCases 默认 IRRELEVANCE_CASES（验证"不该调时不调"）
    // - executor 复用 ServiceContext.evalExecutor，未注入时退回 heuristicExecutor
    if (sub === 'bfcl') {
      const executor: EvalExecutor | undefined = (ctx as unknown as { evalExecutor?: EvalExecutor }).evalExecutor;
      // heuristicExecutor 作为兜底：保证无 LLM 环境下也能跑通流程并产出报告
      const finalExecutor: EvalExecutor = executor ?? (await import('../../evaluation/runner.js')).heuristicExecutor;
      const evaluator = new BfclToolEvaluator({
        executor: finalExecutor,
        toolCallCases: SMOKE_CASES,
        // irrelevanceCases 用默认 IRRELEVANCE_CASES
      });
      const header = '## 开始运行 BFCL 工具调用评估...\n';
      try {
        const report = await evaluator.run();
        const accPct = (report.toolCallAccuracy * 100).toFixed(1);
        const rejPct = (report.irrelevanceRejectionRate * 100).toFixed(1);
        const summary = `\n\n**BFCL 评估完成**\n- tool_call_accuracy: ${accPct}% (${report.toolCallPassed}/${report.toolCallCaseCount})\n- irrelevance_rejection_rate: ${rejPct}% (${report.irrelevancePassed}/${report.irrelevanceCaseCount})`;
        return { type: 'handled', messages: [header + report.markdown + summary] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { type: 'handled', messages: [`${header}BFCL 评估执行出错: ${msg}`] };
      }
    }

    if (sub !== 'smoke' && sub !== 'regression' && sub !== 'all') {
      return {
        type: 'handled',
        messages: [`未知子命令: ${sub}。支持: smoke / regression / all / bfcl / list`],
      };
    }

    // 允许 ServiceContext 注入真实 executor（实际驱动 Agent）；
    // 未注入时使用 EvalRunner 默认 heuristic executor
    const executor: EvalExecutor | undefined = (ctx as unknown as { evalExecutor?: EvalExecutor }).evalExecutor;
    const runner = new EvalRunner({ executor });

    const header = `## 开始运行 ${sub} 评估...\n`;
    let results;
    try {
      if (sub === 'smoke') {
        results = await runner.runSmoke();
      } else if (sub === 'regression') {
        results = await runner.runRegression();
      } else {
        results = await runner.runSuite(ALL_EVAL_CASES);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { type: 'handled', messages: [`${header}评估执行出错: ${msg}`] };
    }

    const report = runner.generateReport(results);
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const summary = `\n\n**${sub} 评估完成：${passed}/${total} 通过**`;
    return { type: 'handled', messages: [header + report + summary] };
  },
};
