// tests/evals/observability-closure.test.ts
// GA Observability Closure——5 项验收门（评审指定）：
//   1. Shared Persistent Redaction：生产 RunEventLog / TraceCollector / Logger sink
//      实际写盘后 raw fake secret = 0；runtime 值不变
//   2. Forensic Retry Semantics：L2-07 canonical = 0 findings（inspect-run.test.ts 覆盖，
//      此处补 E2E 级验证）
//   3. Baseline Coverage Gate：任务消失 ERROR / 新增 INFO / --allow-suite-change 放行
//   4. PATH delimiter：shellEnv split(delimiter) 语义（Windows/POSIX 平台无关断言）
//   5. Artifact Integrity Metadata：artifactSecurity { redacted, redactionCount, preRedactionSha256 }

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { RunEventLog } from '../../src/harness/run-event-log.js';
import { TraceCollector } from '../../src/harness/trace-collector.js';
import { redactingFileFormat } from '../../src/utils/logger.js';
import { redactSensitiveText } from '../../src/utils/redact-sensitive.js';
import { shellEnv } from '../../evals/repo-tasks/runner/assemble.js';
import { compareBaselines } from '../../evals/repo-tasks/runner/compare-baselines.js';
import { redactReport } from '../../evals/repo-tasks/runner/redact.js';
import { inspectEvents } from '../../evals/repo-tasks/runner/inspect-run.js';

/** fake secret corpus（全部伪造值） */
const FAKE = {
  sk: 'sk-fakeClosureKey1234567890abcdef',
  bearer: 'Bearer fake-closure-bearer-9876543210',
  auth: 'Authorization: Basic ZmFrZS1jbG9zdXJl',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjbG9zdXJlIn0.fakeSig123456',
  password: 'password=closure-secret-42',
  conn: 'https://user:closurepass@db.internal:5432/prod',
};

function assertZeroRawSecrets(diskText: string, where: string): void {
  for (const [name, literal] of Object.entries(FAKE)) {
    expect(diskText.includes(literal), `${where}: ${name} 泄漏`).toBe(false);
  }
}

// ============================================================
// 1. 生产 RunEventLog 落盘脱敏（实际写临时磁盘 + replay）
// ============================================================

describe('Closure 1a：production RunEventLog disk payload redaction', () => {
  it('llm_retry/llm_failed/tool_completed/run_interrupted 的文本字段落盘后 raw fake secret = 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rdev-clos-rel-'));
    try {
      const log = new RunEventLog('run-closure-1', dir);
      log.record('run_started', { input: `user input ${FAKE.sk}`, model: 'm' });
      log.record('llm_retry', { model: 'm', attempt: 2, errorKind: 'rate_limit', error: `provider error ${FAKE.bearer} ${FAKE.jwt}` });
      log.record('tool_completed', { toolName: 'shell_exec', toolCallId: 'c1', isError: false, outputPreview: `curl -H "${FAKE.auth}" ${FAKE.conn}` });
      log.record('run_interrupted', { reason: `abort due to ${FAKE.password}` });
      // 实际写盘的 jsonl
      const files = readdirSync(join(dir, 'runs'));
      expect(files).toHaveLength(1);
      const disk = readFileSync(join(dir, 'runs', files[0]!), 'utf-8');
      assertZeroRawSecrets(disk, 'RunEventLog disk');
      // replay 一致（内存/磁盘同一脱敏值）
      const replay = RunEventLog.replay(dir, 'run-closure-1');
      expect(replay.projection).not.toBeNull();
      assertZeroRawSecrets(JSON.stringify(replay.events), 'RunEventLog replay');
      // 结构化字段保留：isError 布尔、attempt 数值不变
      const toolEv = replay.events.find((e) => e.type === 'tool_completed')!;
      expect((toolEv.payload as Record<string, unknown>).isError).toBe(false);
      const retryEv = replay.events.find((e) => e.type === 'llm_retry')!;
      expect((retryEv.payload as Record<string, unknown>).attempt).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runtime 值不变：record 不修改调用方传入的 payload 对象', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rdev-clos-rel2-'));
    try {
      const log = new RunEventLog('run-closure-2', dir);
      const original = { toolName: 'shell_exec', toolCallId: 'c1', isError: false, outputPreview: `Bearer fake-rt-${FAKE.sk}` };
      const snapshot = JSON.stringify(original);
      log.record('tool_completed', original);
      // 调用方对象保持原样（runtime ToolResult unchanged）
      expect(JSON.stringify(original)).toBe(snapshot);
      expect(original.outputPreview).toContain(FAKE.sk);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// 1b. 生产 TraceCollector 落盘脱敏（实际写临时 storageDir）
// ============================================================

describe('Closure 1b：production TraceCollector disk record redaction', () => {
  it('userInput/thinking/tool_result/error 等 record 落盘后 raw fake secret = 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rdev-clos-tc-'));
    try {
      const trace = new TraceCollector({ storageDir: dir });
      trace.startSession(`user input with ${FAKE.sk}`);
      trace.recordEvent({ type: 'thinking', message: `reasoning mentions ${FAKE.bearer}` } as never);
      trace.recordToolCall('shell_exec', { command: `curl -H "${FAKE.auth}" ${FAKE.conn}` }, 'c1', false);
      trace.recordEvent({ type: 'tool_call_result', toolName: 'shell_exec', toolCallId: 'c1', result: `result ${FAKE.jwt}`, isError: false } as never);
      trace.recordEvent({ type: 'error', error: `boom ${FAKE.password}` } as never);
      await trace.flush();
      // 读所有落盘文件（.trace.jsonl + .session.json）
      const dayDir = join(dir, new Date().toISOString().slice(0, 10));
      const files = readdirSync(dayDir);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const disk = readFileSync(join(dayDir, f), 'utf-8');
        assertZeroRawSecrets(disk, `TraceCollector ${f}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// 1c. production Logger sink（winston File format）脱敏
// ============================================================

describe('Closure 1c：logger file transport format redaction', () => {
  it('redactingFileFormat 输出不含 raw fake secret（message 与嵌套 meta）', () => {
    const fmt = redactingFileFormat();
    const info = {
      level: 'error',
      message: `connect failed: ${FAKE.conn} token=${FAKE.jwt}`,
      meta: { headers: { Authorization: FAKE.auth }, attempt: 2, nested: { password: FAKE.password } },
      timestamp: 't',
    };
    const rendered = fmt.transform(info);
    const text = JSON.stringify(rendered);
    assertZeroRawSecrets(text, 'logger format');
    // 非敏感字段保留
    expect(text).toContain('connect failed');
    expect(rendered.meta.attempt).toBe(2);
  });
});

// ============================================================
// 3. Baseline Coverage Gate
// ============================================================

describe('Closure 3：baseline suite coverage gate', () => {
  function agg(tasks: Record<string, { pass: boolean }>, conf?: Record<string, { pass: boolean }>): Record<string, unknown> {
    return {
      sections: {
        modelCapability: {
          L2: { results: Object.fromEntries(Object.entries(tasks).map(([id, t]) => [id, { pass: t.pass, provider: 'deepseek', metrics: {} }])) },
          L3: { results: {} },
        },
        harnessConformance: { results: conf ? Object.fromEntries(Object.entries(conf).map(([id, t]) => [id, { pass: t.pass, provider: 'mock', metrics: {} }])) : {} },
        hardSafetyViolations: 0,
      },
    };
  }

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rdev-clos-cg-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const w = (name: string, content: unknown): string => { const p = join(dir, name); writeFileSync(p, JSON.stringify(content), 'utf-8'); return p; };

  it('capability 任务在 B 中消失 → SUITE_COVERAGE_REGRESSION + ERROR（fail-closed）', () => {
    const a = w('a.json', agg({ 'L2-01': { pass: true }, 'L2-02': { pass: false } }));
    const b = w('b.json', agg({ 'L2-01': { pass: true } })); // L2-02 消失
    const r = compareBaselines(a, b);
    expect(r.suiteCoverage.disappeared).toContain('L2-02');
    expect(r.suiteCoverage.coverageRegression).toBe(true);
    expect(r.gates.errors.some((e) => e.includes('SUITE_COVERAGE_REGRESSION') && e.includes('L2-02'))).toBe(true);
    expect(r.gates.met).toBe(false);
  });

  it('mandatory conformance 任务在 B 中消失 → ERROR', () => {
    const a = w('a.json', agg({ 'L2-01': { pass: true } }, { 'L2-07': { pass: true } }));
    const b = w('b.json', agg({ 'L2-01': { pass: true } })); // conformance L2-07 消失
    const r = compareBaselines(a, b);
    expect(r.suiteCoverage.disappeared).toContain('L2-07');
    expect(r.gates.errors.some((e) => e.includes('SUITE_COVERAGE_REGRESSION'))).toBe(true);
  });

  it('新任务出现在 B → NEW_TASK（INFO/warning，不 ERROR）', () => {
    const a = w('a.json', agg({ 'L2-01': { pass: true } }));
    const b = w('b.json', agg({ 'L2-01': { pass: true }, 'L2-09': { pass: true } }));
    const r = compareBaselines(a, b);
    expect(r.suiteCoverage.newTasks).toContain('L2-09');
    expect(r.gates.warnings.some((e) => e.includes('NEW_TASK') && e.includes('L2-09'))).toBe(true);
    expect(r.gates.errors).toHaveLength(0);
    expect(r.gates.met).toBe(true);
  });

  it('--allow-suite-change 显式放行 coverage regression（降为 WARNING）', () => {
    const a = w('a.json', agg({ 'L2-01': { pass: true }, 'L2-02': { pass: false } }));
    const b = w('b.json', agg({ 'L2-01': { pass: true } }));
    const r = compareBaselines(a, b, { allowSuiteChange: true });
    expect(r.suiteCoverage.allowSuiteChange).toBe(true);
    expect(r.gates.errors.some((e) => e.includes('SUITE_COVERAGE_REGRESSION'))).toBe(false);
    expect(r.gates.warnings.some((e) => e.includes('allow-suite-change'))).toBe(true);
    expect(r.gates.met).toBe(true);
  });
});

// ============================================================
// 4. PATH delimiter 语义
// ============================================================

describe('Closure 4：PATH delimiter（path.delimiter 语义）', () => {
  it('shellEnv PATH 按平台 delimiter 分割后含独立 node_modules/.bin 与 node bin 条目', () => {
    const env = shellEnv();
    const entries = (env.PATH ?? '').split(delimiter);
    expect(entries.some((e) => e.includes('node_modules') && e.includes('.bin'))).toBe(true);
    // dirname(process.execPath) 是独立条目
    const { dirname } = require('node:path') as typeof import('node:path');
    expect(entries).toContain(dirname(process.execPath));
    // 平台相关断言：Windows 用 ';' 分割、POSIX 用 ':'——delimiter 即平台值
    expect(delimiter).toBe(process.platform === 'win32' ? ';' : ':');
  });
});

// ============================================================
// 5. Artifact Integrity Metadata
// ============================================================

describe('Closure 5：artifactSecurity 完整性 metadata', () => {
  it('redactReport 附加 { redacted, redactionCount, preRedactionSha256 }，不存 raw', () => {
    const report = {
      artifact: {
        toolTrajectory: [{ toolName: 'shell_exec', toolCallId: 'c1', isError: false, args: { command: `curl ${FAKE.conn}` }, outputPreview: FAKE.sk, timestamp: 1 }],
        finalPatch: `+const K = '${FAKE.password}';\n+const U = '${FAKE.conn}';`,
        runEventLog: [{ type: 'llm_failed', payload: { error: FAKE.bearer } }],
      },
    };
    const safe = redactReport(report);
    const sec = (safe.artifact as Record<string, unknown>).artifactSecurity as Record<string, unknown>;
    expect(sec.redacted).toBe(true);
    expect(typeof sec.redactionCount).toBe('number');
    expect((sec.redactionCount as number)).toBeGreaterThan(0);
    expect(typeof sec.preRedactionSha256).toBe('string');
    expect(String(sec.preRedactionSha256)).toMatch(/^[0-9a-f]{64}$/);
    // 不存 raw
    expect(JSON.stringify(safe)).not.toContain(FAKE.conn);
    expect(JSON.stringify(safe)).not.toContain(FAKE.sk);
  });

  it('无 secret 的 report：redacted=false、count=0、hash 仍记录（可证明对应原始结果）', () => {
    const report = { artifact: { finalPatch: 'diff --git a/x b/x\n+export const a = 1;', toolTrajectory: [] } };
    const safe = redactReport(report);
    const sec = (safe.artifact as Record<string, unknown>).artifactSecurity as Record<string, unknown>;
    expect(sec.redacted).toBe(false);
    expect(sec.redactionCount).toBe(0);
    expect(String(sec.preRedactionSha256)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================
// 2b. E2E：canonical L2-07 在完整 inspect 流程 = 0 findings
// ============================================================

describe('Closure 2b：canonical L2-07 forensic E2E', () => {
  it('loop llm_requested=1 + provider llm_retry=1 + llm_succeeded=1 + run_completed → 0 findings', () => {
    const events = [
      { id: 'e1', runId: 'r', sequence: 1, timestamp: 1, type: 'run_started', payload: { input: 'x', model: 'm' } },
      { id: 'e2', runId: 'r', sequence: 2, timestamp: 2, type: 'llm_requested', payload: { model: 'm', attempt: 1 } },
      { id: 'e3', runId: 'r', sequence: 3, timestamp: 3, type: 'llm_retry', payload: { model: 'm', attempt: 2, errorKind: 'rate_limit', error: 'transient' } },
      { id: 'e4', runId: 'r', sequence: 4, timestamp: 4, type: 'llm_succeeded', payload: { model: 'm', attempt: 1, finishReason: 'stop' } },
      { id: 'e5', runId: 'r', sequence: 5, timestamp: 5, type: 'run_completed', payload: { outputLength: 1, toolCallCount: 0, retryCount: 1 } },
    ] as never[];
    const r = inspectEvents(events, []);
    expect(r.findings).toHaveLength(0);
    expect(r.stats.retryCount).toBe(1);
  });
});
