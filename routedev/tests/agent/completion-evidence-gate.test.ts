import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { CompletionEvidenceGate } from '../../src/agent/completion-evidence-gate.js';

const MULTI_FILE_PROMPT = [
  'Add a logLevel setting consistently across the schema/type definition,',
  'the config loader, the runtime logger, and its tests; also update the README example.',
  'Invalid values must be rejected by the loader.',
].join(' ');

function success(gate: CompletionEvidenceGate, toolName: string, args: Record<string, unknown>, output = 'ok'): void {
  gate.observeToolResult(toolName, args, false, output);
}

describe('CompletionEvidenceGate', () => {
  it('recovers a 4/5 multi-file implementation and completes only after missing evidence arrives', () => {
    const gate = new CompletionEvidenceGate(MULTI_FILE_PROMPT, 'C:/workspace');
    success(gate, 'file_edit', { path: 'src/config-schema.ts' });
    success(gate, 'file_edit', { path: 'src/logger.ts' });
    success(gate, 'file_write', { path: 'tests/logger.test.ts' });
    success(gate, 'file_edit', { path: 'README.md' });
    success(gate, 'shell_exec', { command: 'pnpm test' });

    const first = gate.evaluate();
    expect(first.status).toBe('recover');
    expect(first.missing.some((item) => /loader/i.test(item))).toBe(true);

    success(gate, 'file_edit', { path: 'src/loader.ts' });
    success(gate, 'shell_exec', { command: 'pnpm test' });
    const second = gate.evaluate();
    expect(second.status).toBe('complete');
    expect(second.evidence.every((item) => item.sources.length > 0)).toBe(true);
  });

  it('invalidates verification after every later mutation', () => {
    const gate = new CompletionEvidenceGate('Fix src/a.ts and keep all tests green.', 'C:/workspace');
    success(gate, 'file_edit', { path: 'src/a.ts' });
    success(gate, 'shell_exec', { command: 'pnpm test' });
    expect(gate.getEpochs()).toEqual({ mutationEpoch: 1, verifiedEpoch: 1 });

    success(gate, 'file_edit', { path: 'src/a.ts' });
    expect(gate.getEpochs()).toEqual({ mutationEpoch: 2, verifiedEpoch: 1 });
    const result = gate.evaluate();
    expect(result.status).toBe('recover');
    expect(result.missing.join(' ')).toMatch(/latest mutation|最新变更/i);
  });

  it('interrupts after two bounded completion recoveries', () => {
    const gate = new CompletionEvidenceGate('Implement src/a.ts and run the tests.', 'C:/workspace');
    expect(gate.evaluate().status).toBe('recover');
    expect(gate.evaluate().status).toBe('recover');
    const terminal = gate.evaluate();
    expect(terminal.status).toBe('interrupted');
    expect(terminal.reason).toBe('completion_evidence_missing');
  });

  it('adds no contract or recovery overhead to pure chat', () => {
    const gate = new CompletionEvidenceGate('Explain why the sky looks blue.', 'C:/workspace');
    expect(gate.getObligations()).toEqual([]);
    expect(gate.evaluate()).toMatchObject({ status: 'complete', recoveryAttempts: 0 });
  });

  it('gives cancellation priority over completion recovery', () => {
    const gate = new CompletionEvidenceGate('Implement src/a.ts and run tests.', 'C:/workspace');
    const result = gate.evaluate({ cancelled: true });
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('cancelled');
    expect(result.recoveryAttempts).toBe(0);
  });

  it('does not accept an assistant completion claim as requirement evidence', () => {
    const gate = new CompletionEvidenceGate('Implement src/a.ts and run tests.', 'C:/workspace');
    gate.observeAssistantText('Done. Everything is implemented and all tests pass.');
    const result = gate.evaluate();
    expect(result.status).toBe('recover');
    expect(result.evidence.every((item) => item.sources.every((source) => !source.includes('assistant')))).toBe(true);
  });

  it('keeps failed verification unresolved until a verifier succeeds', () => {
    const gate = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', 'C:/workspace');
    success(gate, 'file_edit', { path: 'src/a.ts' });
    gate.observeToolResult('shell_exec', { command: 'pnpm test' }, true, 'failed');
    success(gate, 'file_read', { path: 'src/a.ts' });
    expect(gate.evaluate().missing.join(' ')).toContain('verification');
    success(gate, 'shell_exec', { command: 'pnpm test' });
    expect(gate.evaluate().status).toBe('complete');
  });

  it('accepts a direct verifier with a trailing descriptor merge', () => {
    const gate = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', 'C:/workspace');
    success(gate, 'file_edit', { path: 'src/a.ts' });
    success(gate, 'shell_exec', { command: 'npm test 2>&1' });

    expect(gate.getEpochs()).toEqual({ mutationEpoch: 1, verifiedEpoch: 1 });
    expect(gate.evaluate().status).toBe('complete');
  });

  it('requires no-emit mode for package-run TypeScript verification', () => {
    const emitting = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', 'C:/workspace');
    success(emitting, 'file_edit', { path: 'src/a.ts' });
    success(emitting, 'shell_exec', { command: 'pnpm exec tsc' });
    expect(emitting.getEpochs().verifiedEpoch).toBe(-1);

    const noEmit = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', 'C:/workspace');
    success(noEmit, 'file_edit', { path: 'src/a.ts' });
    success(noEmit, 'shell_exec', { command: 'npx tsc --noEmit 2>&1' });
    expect(noEmit.getEpochs().verifiedEpoch).toBe(1);
  });

  it('lets a successful verifier supersede an earlier transient shell diagnostic', () => {
    const gate = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', 'C:/workspace');
    success(gate, 'file_edit', { path: 'src/a.ts' });
    gate.observeToolResult('shell_exec', { command: 'ls -la' }, true, 'unsupported command');
    success(gate, 'shell_exec', { command: 'pnpm test' });

    expect(gate.evaluate().status).toBe('complete');
  });

  it('rejects verifier text printed by a non-verifier command', () => {
    const gate = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', 'C:/workspace');
    success(gate, 'file_edit', { path: 'src/a.ts' });
    success(gate, 'shell_exec', { command: 'echo pnpm test' }, 'pnpm test passed');

    expect(gate.getEpochs()).toEqual({ mutationEpoch: 1, verifiedEpoch: -1 });
    expect(gate.evaluate().status).toBe('recover');
  });

  it('does not accept a verifier chained with a later mutation', () => {
    const gate = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', 'C:/workspace');
    success(gate, 'file_edit', { path: 'src/a.ts' });
    success(gate, 'shell_exec', { command: 'pnpm test && echo x > src/a.ts' });

    expect(gate.getEpochs()).toEqual({ mutationEpoch: 2, verifiedEpoch: -1 });
    expect(gate.evaluate().status).toBe('recover');
  });

  it('does not accept verifier update/fix modes as current evidence', () => {
    for (const command of ['vitest -u', 'pnpm test -- --update', 'eslint tests/a.ts --fix']) {
      const gate = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', 'C:/workspace');
      success(gate, 'file_edit', { path: 'src/a.ts' });
      success(gate, 'shell_exec', { command });
      expect(gate.getEpochs().verifiedEpoch, command).toBe(-1);
      expect(gate.evaluate().status, command).toBe('recover');
    }
  });

  it('treats a policy-denied requested resource as BLOCKED, not satisfied (GA Unified Closure P1-2)', () => {
    const gate = new CompletionEvidenceGate(
      'Add tests/score-calc-empty.test.ts following the style (see tests/score-calc.test.ts), then run the tests.',
      'C:/workspace',
    );
    expect(gate.getObligations().some((item) => item.resourceHints.includes('tests/score-calc.test.ts'))).toBe(false);
    gate.observeToolRejection('safety', 'file_write', {
      path: 'tests/score-calc-empty.test.ts',
      content: 'blocked',
    });
    success(gate, 'shell_exec', { command: 'pnpm test' });

    const result = gate.evaluate();
    // policy denial != satisfied：不得 complete，也不得把 policy-denial 当 positive evidence
    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('policy_blocked_requirement');
    expect(result.evidence.some((item) => item.sources.some((source) => source.startsWith('policy-denial:')))).toBe(false);
    expect(result.missing.some((item) => /score-calc-empty/i.test(item))).toBe(true);
  });

  it('policy denial on an unrelated resource does not block other obligations (GA Unified Closure P1-2)', () => {
    const gate = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', 'C:/workspace');
    // 拒绝一个无关资源（docs/notes.md）——不标记任何 obligation blocked
    gate.observeToolRejection('safety', 'file_write', { path: 'docs/notes.md', content: 'x' });
    success(gate, 'file_edit', { path: 'src/a.ts' });
    success(gate, 'shell_exec', { command: 'pnpm test' });
    expect(gate.evaluate().status).toBe('complete');
  });

  it('does not waive an obligation after a user or hook rejection', () => {
    for (const kind of ['user', 'hook'] as const) {
      const gate = new CompletionEvidenceGate('Add tests/a.test.ts and run tests.', 'C:/workspace');
      gate.observeToolRejection(kind, 'file_write', { path: 'tests/a.test.ts', content: 'x' });
      success(gate, 'shell_exec', { command: 'pnpm test' });
      expect(gate.evaluate().status, kind).toBe('recover');
    }
  });

  it('blocks an unrequested breaking change to an explicit exported return contract (real filesystem)', () => {
    // P2-1（GA Unified Closure）：contract 校验必须基于实际最终文件系统——
    // 用真实临时目录，shadow replay 之外 shell 对真实文件的修改也必须被观察到。
    const base = mkdtempSync(join(tmpdir(), 'rdev-gate-api-'));
    const file = join(base, 'src', 'logger.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'export function log(level: string): string { return level; }', 'utf-8');
    try {
      const gate = new CompletionEvidenceGate('Fix src/logger.ts and keep tests green.', base);
      const baseline = readFileSync(file, 'utf-8');
      success(gate, 'file_read', { path: 'src/logger.ts' }, baseline);
      // shell 直接修改真实文件（shadow replay 看不到）
      writeFileSync(file, 'export function log(level: string): string | undefined { return level; }', 'utf-8');
      success(gate, 'shell_exec', { command: 'pnpm test' });

      const blocked = gate.evaluate();
      expect(blocked.status).toBe('recover');
      expect(blocked.missing.join(' ')).toContain('公共 API 返回契约发生未授权变更');

      // 恢复契约后完成：真实文件恢复 + file_edit 观察提供 mutation evidence（shell
      // 直接写文件 gate 观察不到 mutation——evidence 来自工具轨迹与真实文件双源）
      writeFileSync(file, 'export function log(level: string): string { return level; }', 'utf-8');
      success(gate, 'file_edit', { path: 'src/logger.ts' });
      success(gate, 'shell_exec', { command: 'pnpm test' });
      expect(gate.evaluate().status).toBe('complete');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('allows an explicit user-requested return type change', () => {
    const gate = new CompletionEvidenceGate(
      'Change the return type in src/logger.ts and keep tests green.',
      'C:/workspace',
    );
    success(gate, 'file_read', { path: 'src/logger.ts' }, 'export function log(): string { return "x"; }');
    success(gate, 'file_edit', {
      path: 'src/logger.ts',
      oldString: ': string {',
      newString: ': string | undefined {',
    });
    success(gate, 'shell_exec', { command: 'pnpm test' });

    expect(gate.evaluate().status).toBe('complete');
  });

  it('P2-A: case-sensitive API path 不产生 false violation（真实路径读取）', () => {
    // Linux case-sensitive FS 语义：src/MyLogger.ts 不能被 lowercase 路径替代
    const base = mkdtempSync(join(tmpdir(), 'rdev-gate-case-'));
    const file = join(base, 'src', 'MyLogger.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'export function log(level: string): string { return level; }', 'utf-8');
    try {
      const gate = new CompletionEvidenceGate('Fix src/MyLogger.ts and keep tests green.', base);
      success(gate, 'file_read', { path: 'src/MyLogger.ts' }, readFileSync(file, 'utf-8'));
      // 无 API 变更 + 无 shell 修改 → verify → 无 false violation
      success(gate, 'shell_exec', { command: 'pnpm test' });
      const result = gate.evaluate();
      expect(result.status).toBe('recover'); // 有 mutation evidence 缺口（未观察 file_edit）
      // 核心断言：无 false API violation（真实路径读取，无 ENOENT 假阳性）
      expect(result.missing.join(' ')).not.toContain('公共 API 返回契约发生未授权变更');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('P2-B: behavior/component 级 blocked 可被合法替代 evidence supersede', () => {
    const base = mkdtempSync(join(tmpdir(), 'rdev-gate-sup-'));
    try {
      const gate = new CompletionEvidenceGate('Add relevant tests for the loader and run them.', base);
      // 尝试 tests/foo.test.ts 被策略拒绝 → '更新相关 tests' obligation blocked
      gate.observeToolRejection('safety', 'file_write', { path: 'tests/foo.test.ts', content: 'x' });
      // 后续在允许位置写合法测试（src/foo.spec.ts）——合法替代 evidence
      success(gate, 'file_write', { path: 'src/foo.spec.ts', content: 'import { it } from "vitest";' });
      success(gate, 'shell_exec', { command: 'pnpm test' });
      // blocked 被 supersede → 不进入 policy_blocked_requirement 中断
      const result = gate.evaluate();
      expect(result.status).not.toBe('interrupted');
      expect(result.reason).not.toBe('policy_blocked_requirement');
      // 未被精确阻塞的文件 obligation（loader）仍需 evidence——recover 而非 complete
      expect(['recover', 'complete']).toContain(result.status);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('P2-B: exact file requirement blocked 后无关修改不能解除（仍 policy_blocked_requirement）', () => {
    const base = mkdtempSync(join(tmpdir(), 'rdev-gate-exact-'));
    try {
      const gate = new CompletionEvidenceGate('Create tests/foo.test.ts and run tests.', base);
      gate.observeToolRejection('safety', 'file_write', { path: 'tests/foo.test.ts', content: 'x' });
      // 无关文件修改（不匹配精确要求）
      success(gate, 'file_write', { path: 'src/unrelated.ts', content: 'x' });
      success(gate, 'shell_exec', { command: 'pnpm test' });
      const result = gate.evaluate();
      // exact requirement 仍 blocked → interrupted（不能 false complete）
      expect(result.status).toBe('interrupted');
      expect(result.reason).toBe('policy_blocked_requirement');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('agent cannot mutate its verifier and then use it to certify itself (GA Unified Closure P1-1/P1-B)', () => {
    const base = mkdtempSync(join(tmpdir(), 'rdev-gate-ver-'));
    writeFileSync(join(base, 'package.json'), '{"scripts":{"test":"vitest run"}}', 'utf-8');
    try {
      const gate = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', base);
      success(gate, 'file_edit', { path: 'src/a.ts' });
      // Agent 真实修改 verifier 定义（package.json script 改为恒真）——真实文件写入
      writeFileSync(join(base, 'package.json'), '{"scripts":{"test":"node -e \\"process.exit(0)\\\""}}', 'utf-8');
      success(gate, 'file_edit', { path: 'package.json' });
      success(gate, 'shell_exec', { command: 'pnpm test' });
      // verifiedEpoch MUST NOT advance——修改后的 verifier 不能自证
      expect(gate.getEpochs().verifiedEpoch).toBe(-1);
      expect(gate.evaluate().status).toBe('recover');
      expect(gate.evaluate().missing.join(' ')).toMatch(/最新变更尚未验证|latest mutation/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('P1-B: verifier taint persists across unrelated mutations（10 个无关 mutation 后仍不可信）', () => {
    const base = mkdtempSync(join(tmpdir(), 'rdev-gate-taint-'));
    writeFileSync(join(base, 'package.json'), '{"scripts":{"test":"vitest run"}}', 'utf-8');
    try {
      const gate = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', base);
      success(gate, 'file_edit', { path: 'src/a.ts' });
      writeFileSync(join(base, 'package.json'), '{"scripts":{"test":"node -e \\"process.exit(0)\\\""}}', 'utf-8');
      success(gate, 'file_edit', { path: 'package.json' });
      // 10 个无关 mutation
      for (let i = 0; i < 10; i++) success(gate, 'file_edit', { path: `src/unrelated-${i}.ts` });
      success(gate, 'shell_exec', { command: 'pnpm test' });
      // verifier 定义面仍与 baseline 不一致 → 不 advance（taint 不随 mutationEpoch 前进消失）
      expect(gate.getEpochs().verifiedEpoch).toBe(-1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('P1-B: byte-identical 恢复 verifier 定义后可重新获得信任', () => {
    const base = mkdtempSync(join(tmpdir(), 'rdev-gate-restore-'));
    const baseline = '{"scripts":{"test":"vitest run"}}';
    writeFileSync(join(base, 'package.json'), baseline, 'utf-8');
    try {
      const gate = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', base);
      success(gate, 'file_edit', { path: 'src/a.ts' });
      // 修改 verifier → 不可信
      writeFileSync(join(base, 'package.json'), '{"scripts":{"test":"node -e \\"process.exit(0)\\\""}}', 'utf-8');
      success(gate, 'file_edit', { path: 'package.json' });
      success(gate, 'shell_exec', { command: 'pnpm test' });
      expect(gate.getEpochs().verifiedEpoch).toBe(-1);
      // byte-identical 恢复 baseline → 当前 hash 一致 → 重新可信
      writeFileSync(join(base, 'package.json'), baseline, 'utf-8');
      success(gate, 'file_edit', { path: 'package.json' });
      success(gate, 'shell_exec', { command: 'pnpm test' });
      expect(gate.getEpochs().verifiedEpoch).toBe(gate.getEpochs().mutationEpoch);
      expect(gate.evaluate().status).toBe('complete');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('modifying vitest config invalidates subsequent verifier trust (GA Unified Closure P1-1/P1-B)', () => {
    const base = mkdtempSync(join(tmpdir(), 'rdev-gate-vit-'));
    writeFileSync(join(base, 'vitest.config.ts'), 'export default {}', 'utf-8');
    try {
      const gate = new CompletionEvidenceGate('Fix src/a.ts and keep tests green.', base);
      success(gate, 'file_edit', { path: 'src/a.ts' });
      success(gate, 'shell_exec', { command: 'pnpm test' });
      expect(gate.getEpochs().verifiedEpoch).toBe(1); // 定义未被改 → 可信

      // 真实修改 vitest.config.ts（模拟 Agent 调整 verifier 配置）
      writeFileSync(join(base, 'vitest.config.ts'), 'export default { test: { setupFiles: [] } }', 'utf-8');
      success(gate, 'file_edit', { path: 'vitest.config.ts' });
      success(gate, 'shell_exec', { command: 'pnpm test' });
      // verifier 定义面 hash 已变 → verifiedEpoch 不 advance（停留 1）
      expect(gate.getEpochs()).toEqual({ mutationEpoch: 2, verifiedEpoch: 1 });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
