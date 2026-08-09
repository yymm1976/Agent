// evals/repo-tasks/runner/compare-baselines.ts
// GA Infrastructure Sprint TASK 1：Baseline Regression Engine
//
// 长期 benchmark 比较工具：输入两个 baseline（aggregate JSON 或单 report JSON），
// 输出 per-task correctness transition / hard safety transition / conformance transition
// 与效率指标对比（LLM rounds / tool calls / failed calls / token usage / duration /
// files changed / retries），区分 REGRESSION / IMPROVEMENT / UNCHANGED /
// EFFICIENCY_REGRESSION，生成 JSON + Markdown。
//
// Hard gate（ERROR 级，不可因效率指标覆盖 correctness）：
//   - correctness PASS → FAIL
//   - hardSafety 0 → >0
//   - conformance PASS → FAIL
// 效率显著上升（correctness 未回归）→ WARNING 级 EFFICIENCY_REGRESSION。
//
// 用法：
//   pnpm exec tsx evals/repo-tasks/runner/compare-baselines.ts <baselineA.json> <baselineB.json> [--out-prefix=<name>] [--efficiency-threshold=1.5]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';

export interface TaskMetrics {
  llmRounds?: number;
  toolCalls?: number;
  failedToolCalls?: number;
  tokenUsage?: number;   // 单 report 可从 RunEventLog 累计；aggregate 无此字段时为 undefined
  durationMs?: number;
  filesChanged?: number;
  retries?: number;
}

export interface TaskEntry {
  taskId: string;
  pass: boolean;
  mode: 'model-capability' | 'conformance';
  metrics: TaskMetrics;
  reason?: string[];
}

export interface BaselineData {
  entries: Map<string, TaskEntry>;
  hardSafetyViolations?: number;
}

export type Transition = 'REGRESSION' | 'IMPROVEMENT' | 'UNCHANGED' | 'EFFICIENCY_REGRESSION';

export interface TaskTransition {
  taskId: string;
  transition: Transition;
  aPass: boolean;
  bPass: boolean;
  metrics: { a: TaskMetrics; b: TaskMetrics };
  efficiencyDetail?: string;
}

export interface CompareResult {
  a: string;
  b: string;
  tasks: TaskTransition[];
  hardSafety: { a: number; b: number; transition: Transition };
  conformance: { aPass: boolean; bPass: boolean; transition: Transition };
  gates: {
    errors: string[];
    warnings: string[];
    met: boolean;
  };
  summary: {
    regressions: string[];
    improvements: string[];
    efficiencyRegressions: string[];
    unchanged: string[];
  };
}

/** 从单 report（RunResult）累计 tokenUsage */
function tokenUsageFromReport(r: Record<string, unknown>): number | undefined {
  const log = (r.artifact as Record<string, unknown> | undefined)?.runEventLog as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(log)) return undefined;
  let total = 0;
  let found = false;
  for (const e of log) {
    if (e.type === 'llm_succeeded') {
      const usage = e.payload as Record<string, unknown> | undefined;
      const t = (usage as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
      const v = Number(t?.totalTokens ?? 0);
      if (Number.isFinite(v) && v > 0) { total += v; found = true; }
    }
  }
  return found ? total : undefined;
}

/** 加载 baseline：支持 aggregate JSON（sections.modelCapability）与单 report JSON */
export function loadBaseline(path: string): BaselineData {
  if (!existsSync(path)) throw new Error(`baseline 文件不存在: ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  const entries = new Map<string, TaskEntry>();
  let hardSafetyViolations: number | undefined;

  const sections = raw.sections as Record<string, unknown> | undefined;
  if (sections) {
    // aggregate 格式
    const mc = sections.modelCapability as Record<string, unknown> | undefined;
    if (mc) {
      for (const level of ['L2', 'L3']) {
        const group = mc[level] as Record<string, unknown> | undefined;
        const results = group?.results as Record<string, { pass: boolean; provider: string; reason?: string[]; metrics: Record<string, number> }> | undefined;
        if (results) {
          for (const [taskId, r] of Object.entries(results)) {
            entries.set(taskId, { taskId, pass: r.pass, mode: 'model-capability', metrics: pickMetrics(r.metrics), reason: r.reason });
          }
        }
      }
    }
    const cc = sections.harnessConformance as Record<string, unknown> | undefined;
    const ccResults = cc?.results as Record<string, { pass: boolean; provider: string; reason?: string[]; metrics: Record<string, number> }> | undefined;
    if (ccResults) {
      for (const [taskId, r] of Object.entries(ccResults)) {
        entries.set(taskId, { taskId, pass: r.pass, mode: 'conformance', metrics: pickMetrics(r.metrics), reason: r.reason });
      }
    }
    hardSafetyViolations = Number((sections.hardSafetyViolations as number | undefined) ?? 0);
  } else if (raw.results && raw.gates) {
    // 旧格式（Baseline Integrity Fix 2 前的手工聚合：顶层 results + gates）
    const results = raw.results as Record<string, { pass: boolean; provider: string; reason?: string[] | null; metrics: Record<string, number>; reportFile?: string }>;
    for (const [taskId, r] of Object.entries(results)) {
      entries.set(taskId, { taskId, pass: r.pass === true, mode: 'model-capability', metrics: pickMetrics(r.metrics), reason: r.reason ?? undefined });
    }
    const gates = raw.gates as Record<string, unknown>;
    const hs = gates.hardSafetyViolations as number | undefined;
    hardSafetyViolations = Number(hs ?? 0);
  } else if (typeof raw.taskId === 'string' && raw.scoring) {
    // 单 report 格式
    const scoring = raw.scoring as Record<string, unknown>;
    const metrics = (raw.metrics ?? {}) as Record<string, number>;
    entries.set(raw.taskId as string, {
      taskId: raw.taskId as string,
      pass: scoring.pass === true,
      mode: (scoring.mode === 'conformance' ? 'conformance' : 'model-capability'),
      metrics: { ...pickMetrics(metrics), tokenUsage: tokenUsageFromReport(raw) },
      reason: (raw.artifact as Record<string, unknown> | undefined)?.reason as string[] | undefined,
    });
  } else {
    throw new Error(`无法识别的 baseline 格式: ${path}（需要 aggregate JSON 或单 report JSON）`);
  }
  if (entries.size === 0) throw new Error(`baseline 无任何任务条目: ${path}`);
  return { entries, hardSafetyViolations };
}

function pickMetrics(m: Record<string, number>): TaskMetrics {
  return {
    llmRounds: num(m.llmRounds),
    toolCalls: num(m.toolCalls),
    failedToolCalls: num(m.failedToolCalls),
    durationMs: num(m.durationMs),
    filesChanged: num(m.filesChanged),
    retries: num(m.retries),
  };
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** 效率回归判定：B 相对 A 任一效率指标显著变差（> threshold 且绝对差超最小阈值），
 *  仅当 correctness 未回归时标记（correctness 优先，不被效率覆盖） */
function efficiencyDetail(a: TaskMetrics, b: TaskMetrics, threshold: number): string | undefined {
  const checks: Array<[string, number | undefined, number | undefined, number]> = [
    ['durationMs', a.durationMs, b.durationMs, 2000],
    ['llmRounds', a.llmRounds, b.llmRounds, 3],
    ['tokenUsage', a.tokenUsage, b.tokenUsage, 5000],
  ];
  const worse: string[] = [];
  for (const [name, av, bv, minAbs] of checks) {
    if (av === undefined || bv === undefined) continue;
    if (bv > av * threshold && bv - av >= minAbs) worse.push(`${name} ${av}→${bv}`);
  }
  return worse.length > 0 ? worse.join(', ') : undefined;
}

export function compareBaselines(aPath: string, bPath: string, opts?: { efficiencyThreshold?: number }): CompareResult {
  const threshold = opts?.efficiencyThreshold ?? 1.5;
  const a = loadBaseline(aPath);
  const b = loadBaseline(bPath);
  const allIds = new Set([...a.entries.keys(), ...b.entries.keys()]);

  const tasks: TaskTransition[] = [];
  for (const taskId of [...allIds].sort()) {
    const ea = a.entries.get(taskId);
    const eb = b.entries.get(taskId);
    if (!ea || !eb) {
      // 单侧存在：视为新增/消失任务（不判 correctness 回归）
      tasks.push({ taskId, transition: 'UNCHANGED', aPass: ea?.pass ?? false, bPass: eb?.pass ?? false, metrics: { a: ea?.metrics ?? {}, b: eb?.metrics ?? {} } });
      continue;
    }
    let transition: Transition;
    if (!ea.pass && eb.pass) transition = 'IMPROVEMENT';
    else if (ea.pass && !eb.pass) transition = 'REGRESSION';
    else transition = 'UNCHANGED';
    let efficiencyDetailStr: string | undefined;
    if (transition === 'UNCHANGED' && eb.pass) {
      // 仅当 correctness 未回归时才报告效率回归（correctness 优先）
      efficiencyDetailStr = efficiencyDetail(ea.metrics, eb.metrics, threshold);
      if (efficiencyDetailStr) transition = 'EFFICIENCY_REGRESSION';
    }
    tasks.push({ taskId, transition, aPass: ea.pass, bPass: eb.pass, metrics: { a: ea.metrics, b: eb.metrics }, efficiencyDetail: efficiencyDetailStr });
  }

  // hard safety transition
  const aSafe = a.hardSafetyViolations ?? 0;
  const bSafe = b.hardSafetyViolations ?? 0;
  const hardSafety: CompareResult['hardSafety'] = {
    a: aSafe,
    b: bSafe,
    transition: aSafe === 0 && bSafe > 0 ? 'REGRESSION' : bSafe === 0 && aSafe > 0 ? 'IMPROVEMENT' : 'UNCHANGED',
  };

  // conformance transition（取 mode=conformance 的任务；无 conformance 任务时 UNCHANGED）
  const confA = [...a.entries.values()].filter((e) => e.mode === 'conformance');
  const confB = [...b.entries.values()].filter((e) => e.mode === 'conformance');
  const confAPass = confA.length > 0 ? confA.every((e) => e.pass) : true;
  const confBPass = confB.length > 0 ? confB.every((e) => e.pass) : true;
  const conformance: CompareResult['conformance'] = {
    aPass: confAPass,
    bPass: confBPass,
    transition: (!confAPass && confBPass) ? ('IMPROVEMENT' as const) : (confAPass && !confBPass) ? ('REGRESSION' as const) : ('UNCHANGED' as const),
  };

  // gates
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const t of tasks) {
    if (t.transition === 'REGRESSION') errors.push(`correctness REGRESSION: ${t.taskId} (PASS → FAIL)`);
    if (t.transition === 'EFFICIENCY_REGRESSION' && t.efficiencyDetail) {
      warnings.push(`efficiency: ${t.taskId} ${t.efficiencyDetail}`);
    }
  }
  if (hardSafety.transition === 'REGRESSION') errors.push(`hard safety 0 → ${bSafe}`);
  if (conformance.transition === 'REGRESSION') errors.push('conformance PASS → FAIL');
  if (errors.length === 0 && warnings.length === 0) {
    // 无变化时仍标记 met（基线未回归）
  }

  const summary = {
    regressions: tasks.filter((t) => t.transition === 'REGRESSION').map((t) => t.taskId),
    improvements: tasks.filter((t) => t.transition === 'IMPROVEMENT').map((t) => t.taskId),
    efficiencyRegressions: tasks.filter((t) => t.transition === 'EFFICIENCY_REGRESSION').map((t) => t.taskId),
    unchanged: tasks.filter((t) => t.transition === 'UNCHANGED').map((t) => t.taskId),
  };

  return {
    a: aPath,
    b: bPath,
    tasks,
    hardSafety,
    conformance,
    gates: { errors, warnings, met: errors.length === 0 },
    summary,
  };
}

/** Markdown 报告生成 */
export function toMarkdown(r: CompareResult): string {
  const lines: string[] = [];
  lines.push(`# Baseline Diff`);
  lines.push('');
  lines.push(`- A: \`${r.a}\``);
  lines.push(`- B: \`${r.b}\``);
  lines.push(`- Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`## Gates`);
  lines.push('');
  if (r.gates.errors.length === 0) lines.push(`**ERROR: 0** ✅`);
  else r.gates.errors.forEach((e) => lines.push(`- ❌ **ERROR** ${e}`));
  if (r.gates.warnings.length === 0) lines.push(`**WARNING: 0**`);
  else r.gates.warnings.forEach((w) => lines.push(`- ⚠️ **WARNING** ${w}`));
  lines.push('');
  lines.push(`## Hard Safety`);
  lines.push('');
  lines.push(`A=${r.hardSafety.a} → B=${r.hardSafety.b} (**${r.hardSafety.transition}**)`);
  lines.push('');
  lines.push(`## Conformance`);
  lines.push('');
  lines.push(`A=${r.conformance.aPass ? 'PASS' : 'FAIL'} → B=${r.conformance.bPass ? 'PASS' : 'FAIL'} (**${r.conformance.transition}**)`);
  lines.push('');
  lines.push(`## Per-task`);
  lines.push('');
  lines.push(`| Task | Transition | A | B | LLM rounds A→B | Tools A→B | Failed A→B | Tokens A→B | Duration A→B | Files A→B | Retries A→B |`);
  lines.push(`|------|-----------|----|----|---------------|----------|------------|------------|--------------|-----------|-------------|`);
  for (const t of r.tasks) {
    const m = t.metrics;
    const fmt = (v: number | undefined): string => (v === undefined ? '-' : String(v));
    const fmtT = (v: number | undefined): string => (v === undefined ? '-' : `${(v / 1000).toFixed(1)}s`);
    lines.push(
      `| ${t.taskId} | **${t.transition}** | ${t.aPass ? 'PASS' : 'FAIL'} | ${t.bPass ? 'PASS' : 'FAIL'} ` +
      `| ${fmt(m.a.llmRounds)}→${fmt(m.b.llmRounds)} | ${fmt(m.a.toolCalls)}→${fmt(m.b.toolCalls)} | ${fmt(m.a.failedToolCalls)}→${fmt(m.b.failedToolCalls)} ` +
      `| ${fmt(m.a.tokenUsage)}→${fmt(m.b.tokenUsage)} | ${fmtT(m.a.durationMs)}→${fmtT(m.b.durationMs)} | ${fmt(m.a.filesChanged)}→${fmt(m.b.filesChanged)} ` +
      `| ${fmt(m.a.retries)}→${fmt(m.b.retries)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ============================================================
// CLI 入口
// ============================================================

if (typeof process.argv[1] === 'string' && process.argv[1].replace(/\\/g, '/').endsWith('compare-baselines.ts')) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => a.endsWith('.json') && !a.startsWith('-'));
  if (files.length !== 2) {
    console.error('usage: pnpm exec tsx evals/repo-tasks/runner/compare-baselines.ts <baselineA.json> <baselineB.json> [--out-prefix=<name>] [--efficiency-threshold=1.5]');
    process.exit(1);
  }
  const outPrefix = args.find((a) => a.startsWith('--out-prefix='))?.slice('--out-prefix='.length) ?? `BASELINE-DIFF-${Date.now()}`;
  const thresholdArg = args.find((a) => a.startsWith('--efficiency-threshold='));
  const threshold = thresholdArg ? Number(thresholdArg.slice('--efficiency-threshold='.length)) : 1.5;
  try {
    const result = compareBaselines(files[0], files[1], { efficiencyThreshold: threshold });
    const reportDir = join(dirname(resolve(files[0])), '..', 'reports');
    mkdirSync(reportDir, { recursive: true });
    const jsonFile = join(reportDir, `${outPrefix}.json`);
    const mdFile = join(reportDir, `${outPrefix}.md`);
    writeFileSync(jsonFile, JSON.stringify(result, null, 2), 'utf-8');
    writeFileSync(mdFile, toMarkdown(result), 'utf-8');
    console.log(`JSON: ${jsonFile}`);
    console.log(`MD:   ${mdFile}`);
    console.log(`gates: errors=${result.gates.errors.length} warnings=${result.gates.warnings.length} met=${result.gates.met}`);
    console.log(`summary: ${JSON.stringify(result.summary)}`);
    process.exit(result.gates.met ? 0 : 2);
  } catch (err) {
    console.error('compare failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
