// tests/evals/compare-baselines.test.ts
// GA Infrastructure Sprint TASK 1：Baseline Regression Engine——deterministic 测试
//
// 覆盖：
// 1. loadBaseline：aggregate 格式 + 单 report 格式解析
// 2. transition 分类：REGRESSION / IMPROVEMENT / UNCHANGED / EFFICIENCY_REGRESSION
// 3. hard gates：correctness PASS→FAIL、hardSafety 0→>0、conformance PASS→FAIL → ERROR
// 4. 效率指标不覆盖 correctness（PASS→FAIL 时不再标效率回归）
// 5. Markdown 输出关键字段

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBaseline, compareBaselines, toMarkdown, type TaskMetrics } from '../../evals/repo-tasks/runner/compare-baselines.js';

function writeTemp(dir: string, name: string, content: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(content), 'utf-8');
  return p;
}

/** aggregate 格式 baseline 构造器 */
function aggregateBaseline(over: {
  tasks?: Record<string, { pass: boolean; metrics?: Partial<TaskMetrics>; reason?: string[] }>;
  hardSafety?: number;
  conformance?: Record<string, { pass: boolean; metrics?: Partial<TaskMetrics> }>;
}): Record<string, unknown> {
  const tasks = over.tasks ?? {};
  const results = Object.fromEntries(
    Object.entries(tasks).map(([id, t]) => [id, { pass: t.pass, provider: 'deepseek', reason: t.reason, metrics: t.metrics ?? {} }]),
  );
  const ccResults = over.conformance
    ? Object.fromEntries(Object.entries(over.conformance).map(([id, t]) => [id, { pass: t.pass, provider: 'mock', metrics: t.metrics ?? {} }]))
    : {};
  return {
    sections: {
      modelCapability: {
        L2: { results },
        L3: { results: {} },
        total: Object.keys(tasks).length,
      },
      harnessConformance: { results: ccResults, met: Object.values(ccResults).every((r) => r.pass) },
      hardSafetyViolations: over.hardSafety ?? 0,
    },
  };
}

const METRICS_A: Partial<TaskMetrics> = { llmRounds: 10, toolCalls: 20, failedToolCalls: 2, durationMs: 30000, filesChanged: 2, retries: 0 };
const METRICS_B_FAST: Partial<TaskMetrics> = { llmRounds: 6, toolCalls: 14, failedToolCalls: 1, durationMs: 18000, filesChanged: 1, retries: 0 };

describe('loadBaseline', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rdev-cmp-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('解析 aggregate 格式（sections.modelCapability + harnessConformance + hardSafetyViolations）', () => {
    const f = writeTemp(dir, 'a.json', aggregateBaseline({
      tasks: { 'L2-01': { pass: true, metrics: METRICS_A } },
      conformance: { 'L2-07': { pass: true } },
      hardSafety: 1,
    }));
    const b = loadBaseline(f);
    expect(b.entries.get('L2-01')?.pass).toBe(true);
    expect(b.entries.get('L2-01')?.metrics.llmRounds).toBe(10);
    expect(b.entries.get('L2-07')?.mode).toBe('conformance');
    expect(b.hardSafetyViolations).toBe(1);
  });

  it('解析单 report 格式（taskId + scoring + metrics + artifact.runEventLog token 累计）', () => {
    const f = writeTemp(dir, 'r.json', {
      taskId: 'L2-03', level: 'L2', provider: 'deepseek',
      scoring: { pass: true, mode: 'model-capability' },
      metrics: { llmRounds: 14, toolCalls: 20, failedToolCalls: 2, filesChanged: 2, linesChanged: 41, retries: 0, durationMs: 39852 },
      artifact: {
        runEventLog: [
          { type: 'llm_succeeded', payload: { usage: { totalTokens: 4000 } } },
          { type: 'llm_succeeded', payload: { usage: { totalTokens: 6000 } } },
        ],
      },
    });
    const b = loadBaseline(f);
    const e = b.entries.get('L2-03')!;
    expect(e.pass).toBe(true);
    expect(e.metrics.tokenUsage).toBe(10000);
  });

  it('不认识的格式 → 抛错', () => {
    const f = writeTemp(dir, 'bad.json', { foo: 1 });
    expect(() => loadBaseline(f)).toThrow();
  });
});

describe('compareBaselines transitions', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rdev-cmp2-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('PASS→FAIL = REGRESSION；FAIL→PASS = IMPROVEMENT；PASS→PASS = UNCHANGED', () => {
    const a = writeTemp(dir, 'a.json', aggregateBaseline({
      tasks: {
        'L2-01': { pass: true, metrics: METRICS_A },
        'L2-02': { pass: false, metrics: METRICS_A },
        'L2-03': { pass: true, metrics: METRICS_A },
      },
    }));
    const b = writeTemp(dir, 'b.json', aggregateBaseline({
      tasks: {
        'L2-01': { pass: false, metrics: METRICS_A },
        'L2-02': { pass: true, metrics: METRICS_A },
        'L2-03': { pass: true, metrics: METRICS_A },
      },
    }));
    const r = compareBaselines(a, b);
    const byId = Object.fromEntries(r.tasks.map((t) => [t.taskId, t.transition]));
    expect(byId['L2-01']).toBe('REGRESSION');
    expect(byId['L2-02']).toBe('IMPROVEMENT');
    expect(byId['L2-03']).toBe('UNCHANGED');
    // gates：PASS→FAIL → ERROR
    expect(r.gates.errors.some((e) => e.includes('L2-01'))).toBe(true);
    expect(r.gates.met).toBe(false);
  });

  it('PASS→PASS 且效率显著变差 = EFFICIENCY_REGRESSION（WARNING，不 ERROR）', () => {
    const a = writeTemp(dir, 'a.json', aggregateBaseline({
      tasks: { 'L2-01': { pass: true, metrics: { llmRounds: 10, toolCalls: 20, durationMs: 30000, filesChanged: 2, retries: 0 } } },
    }));
    const b = writeTemp(dir, 'b.json', aggregateBaseline({
      tasks: { 'L2-01': { pass: true, metrics: { llmRounds: 30, toolCalls: 60, durationMs: 120000, filesChanged: 2, retries: 0 } } },
    }));
    const r = compareBaselines(a, b);
    const t = r.tasks[0];
    expect(t.transition).toBe('EFFICIENCY_REGRESSION');
    expect(t.efficiencyDetail).toContain('durationMs');
    expect(r.gates.warnings.length).toBeGreaterThan(0);
    expect(r.gates.errors).toHaveLength(0);
    expect(r.gates.met).toBe(true); // 效率回归不阻断
  });

  it('效率指标不覆盖 correctness：PASS→FAIL 时不再标 EFFICIENCY_REGRESSION', () => {
    const a = writeTemp(dir, 'a.json', aggregateBaseline({
      tasks: { 'L2-01': { pass: true, metrics: { llmRounds: 10, durationMs: 30000, filesChanged: 2, retries: 0 } } },
    }));
    const b = writeTemp(dir, 'b.json', aggregateBaseline({
      tasks: { 'L2-01': { pass: false, metrics: { llmRounds: 40, durationMs: 180000, filesChanged: 2, retries: 0 } } },
    }));
    const r = compareBaselines(a, b);
    expect(r.tasks[0].transition).toBe('REGRESSION'); // correctness 优先
    expect(r.gates.errors.some((e) => e.includes('L2-01'))).toBe(true);
  });

  it('hardSafety 0→>0 = ERROR；>0→0 = IMPROVEMENT', () => {
    const a = writeTemp(dir, 'a.json', aggregateBaseline({ tasks: { 'L2-01': { pass: true } }, hardSafety: 0 }));
    const b = writeTemp(dir, 'b.json', aggregateBaseline({ tasks: { 'L2-01': { pass: true } }, hardSafety: 1 }));
    const r = compareBaselines(a, b);
    expect(r.hardSafety.transition).toBe('REGRESSION');
    expect(r.gates.errors.some((e) => e.includes('hard safety'))).toBe(true);

    const c = writeTemp(dir, 'c.json', aggregateBaseline({ tasks: { 'L2-01': { pass: true } }, hardSafety: 1 }));
    const d = writeTemp(dir, 'd.json', aggregateBaseline({ tasks: { 'L2-01': { pass: true } }, hardSafety: 0 }));
    expect(compareBaselines(c, d).hardSafety.transition).toBe('IMPROVEMENT');
  });

  it('conformance PASS→FAIL = ERROR；PASS→PASS = UNCHANGED', () => {
    const a = writeTemp(dir, 'a.json', aggregateBaseline({ tasks: {}, conformance: { 'L2-07': { pass: true } } }));
    const b = writeTemp(dir, 'b.json', aggregateBaseline({ tasks: {}, conformance: { 'L2-07': { pass: false } } }));
    const r = compareBaselines(a, b);
    expect(r.conformance.transition).toBe('REGRESSION');
    expect(r.gates.errors.some((e) => e.includes('conformance'))).toBe(true);
  });

  it('效率阈值可配置（--efficiency-threshold 语义）', () => {
    const a = writeTemp(dir, 'a.json', aggregateBaseline({
      tasks: { 'L2-01': { pass: true, metrics: { llmRounds: 10, durationMs: 30000, filesChanged: 2, retries: 0 } } },
    }));
    const b = writeTemp(dir, 'b.json', aggregateBaseline({
      tasks: { 'L2-01': { pass: true, metrics: { llmRounds: 12, durationMs: 36000, filesChanged: 2, retries: 0 } } },
    }));
    // 阈值 1.5：12 < 15 → 不算回归
    const r1 = compareBaselines(a, b, { efficiencyThreshold: 1.5 });
    expect(r1.tasks[0].transition).toBe('UNCHANGED');
    // 阈值 1.1：12 > 11 → 算回归
    const r2 = compareBaselines(a, b, { efficiencyThreshold: 1.1 });
    expect(r2.tasks[0].transition).toBe('EFFICIENCY_REGRESSION');
  });
});

describe('toMarkdown', () => {
  it('输出含 gates / hard safety / conformance / per-task 表格头', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rdev-cmp3-'));
    try {
      const a = writeTemp(dir, 'a.json', aggregateBaseline({ tasks: { 'L2-01': { pass: true, metrics: METRICS_A } } }));
      const b = writeTemp(dir, 'b.json', aggregateBaseline({ tasks: { 'L2-01': { pass: false, metrics: METRICS_B_FAST } } }));
      const md = toMarkdown(compareBaselines(a, b));
      expect(md).toContain('# Baseline Diff');
      expect(md).toContain('## Gates');
      expect(md).toContain('## Hard Safety');
      expect(md).toContain('## Conformance');
      expect(md).toContain('## Per-task');
      expect(md).toContain('| Task | Transition |');
      expect(md).toContain('L2-01');
      expect(md).toContain('REGRESSION');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
