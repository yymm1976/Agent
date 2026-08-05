// tests/evals/summarize.ts
// B-00：评测条目聚合（纯函数，可单测；runner 直接消费）
export interface EvalEntry {
  taskId: string;
  name: string;
  category: string;
  /** 提示变体（B-02B A/B：default | compact） */
  promptVariant?: string;
  /** runner 是否完成了模型执行（false = env-blocked / 运行异常） */
  completed: boolean;
  /** 任务是否通过（checkWorkspace + 回答关键词 + 工具调用要求） */
  passed: boolean;
  /** 工具调用总数（tool_call_start 计数） */
  toolCalls: number;
  /** 无效工具调用数（isError 的工具结果计数） */
  invalidToolCalls: number;
  /** 轮数（LLM 调用次数，token_profile 事件计数） */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 工具 schema 估算 token（B-01 基线的对照指标） */
  toolSchemaTokens: number;
  /** 默认暴露的工具数量 */
  toolCount: number;
  durationMs: number;
  /** 失败定位：checkWorkspace / answer / tool / error / env */
  failStage?: string;
  verifyDetail?: string;
  error?: string;
}

export interface CategoryStat {
  total: number;
  completed: number;
  passed: number;
  passRate: number;
}

export interface EvalSummary {
  total: number;
  completed: number;
  passed: number;
  passRate: number;
  byCategory: Record<string, CategoryStat>;
  avgToolCalls: number;
  avgInvalidToolCalls: number;
  invalidRate: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgTurns: number;
  avgToolSchemaTokens: number;
  avgDurationMs: number;
  /** 未完成条目明细（env-blocked / 异常） */
  blocked: Array<{ taskId: string; reason: string }>;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const avg = (values: number[], divisor: number): number =>
  divisor === 0 ? 0 : round1(values.reduce((a, b) => a + b, 0) / divisor);

export function aggregateResults(entries: EvalEntry[]): EvalSummary {
  const completed = entries.filter((e) => e.completed);
  const passedEntries = completed.filter((e) => e.passed);
  const byCategory: Record<string, CategoryStat> = {};
  for (const entry of entries) {
    const stat = byCategory[entry.category] ?? { total: 0, completed: 0, passed: 0, passRate: 0 };
    stat.total += 1;
    if (entry.completed) {
      stat.completed += 1;
      if (entry.passed) stat.passed += 1;
    }
    stat.passRate = stat.completed === 0 ? 0 : round1(stat.passed / stat.completed);
    byCategory[entry.category] = stat;
  }
  const totalInvalid = completed.reduce((a, e) => a + e.invalidToolCalls, 0);
  const totalCalls = completed.reduce((a, e) => a + e.toolCalls, 0);
  return {
    total: entries.length,
    completed: completed.length,
    passed: passedEntries.length,
    passRate: completed.length === 0 ? 0 : round1(passedEntries.length / completed.length),
    byCategory,
    avgToolCalls: avg(completed.map((e) => e.toolCalls), completed.length),
    avgInvalidToolCalls: avg(completed.map((e) => e.invalidToolCalls), completed.length),
    invalidRate: totalCalls === 0 ? 0 : round1(totalInvalid / totalCalls),
    avgInputTokens: avg(completed.map((e) => e.inputTokens), completed.length),
    avgOutputTokens: avg(completed.map((e) => e.outputTokens), completed.length),
    avgTurns: avg(completed.map((e) => e.turns), completed.length),
    avgToolSchemaTokens: avg(completed.map((e) => e.toolSchemaTokens), completed.length),
    avgDurationMs: avg(completed.map((e) => e.durationMs), completed.length),
    blocked: entries.filter((e) => !e.completed).map((e) => ({ taskId: e.taskId, reason: e.error ?? '未完成' })),
  };
}

/** 汇总转 Markdown 表格（写入基线报告/控制台） */
export function summaryToMarkdown(summary: EvalSummary): string {  const lines: string[] = [];
  lines.push(`| 指标 | 值 |`);
  lines.push(`|---|---|`);
  lines.push(`| 任务数 | ${summary.total} |`);
  lines.push(`| 完成数 | ${summary.completed} |`);
  lines.push(`| 通过数 / 完成率 | ${summary.passed} / ${summary.passRate} |`);
  lines.push(`| 平均工具调用 | ${summary.avgToolCalls} |`);
  lines.push(`| 无效工具调用率 | ${summary.invalidRate} |`);
  lines.push(`| 平均轮数 | ${summary.avgTurns} |`);
  lines.push(`| 平均输入 token | ${summary.avgInputTokens} |`);
  lines.push(`| 平均输出 token | ${summary.avgOutputTokens} |`);
  lines.push(`| 平均工具 schema token | ${summary.avgToolSchemaTokens} |`);
  lines.push(`| 平均耗时 ms | ${summary.avgDurationMs} |`);
  if (summary.blocked.length > 0) {
    lines.push('');
    lines.push('未完成：');
    for (const b of summary.blocked) lines.push(`- ${b.taskId}: ${b.reason}`);
  }
  return lines.join('\n');
}

/**
 * B-02B：A/B 汇总对比（default vs compact 变体）。
 * 验收口径：完成率不能下降；平均输入 token 下降至少 15%。
 * 返回差异行（中文），空数组表示无退化且达指标。
 */
export function compareSummaries(baseline: EvalSummary, variant: EvalSummary): string[] {
  const lines: string[] = [];
  if (variant.completed === 0 || baseline.completed === 0) {
    lines.push('A/B 不可比：存在环境阻塞（completed=0），请配置模型凭据后重跑。');
    return lines;
  }
  const passDelta = variant.passRate - baseline.passRate;
  if (passDelta < 0) {
    lines.push(`完成率下降：${baseline.passRate} → ${variant.passRate}（Δ${passDelta}）——按计划应撤回 compact 变体`);
  } else {
    lines.push(`完成率：${baseline.passRate} → ${variant.passRate}（Δ+${passDelta}）`);
  }
  const tokenDelta = variant.avgInputTokens - baseline.avgInputTokens;
  const tokenDrop = baseline.avgInputTokens === 0 ? 0 : (tokenDelta / baseline.avgInputTokens) * 100;
  if (tokenDrop >= -15) {
    lines.push(`输入 token 下降不足 15%：${baseline.avgInputTokens} → ${variant.avgInputTokens}（Δ${tokenDrop.toFixed(1)}%）`);
  } else {
    lines.push(`输入 token 下降达标：${baseline.avgInputTokens} → ${variant.avgInputTokens}（Δ${tokenDrop.toFixed(1)}%）`);
  }
  const invalidDelta = variant.invalidRate - baseline.invalidRate;
  lines.push(`无效工具调用率：${baseline.invalidRate} → ${variant.invalidRate}（Δ${invalidDelta > 0 ? '+' : ''}${invalidDelta}）`);
  return lines;
}
