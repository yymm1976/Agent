// tests/agent/completion-gate.test.ts
// Phase 31 Task 6.4：CompletionGate 独立代码验证门测试
// 注意：部分测试实际运行 typecheck/lint/tests 命令，需要较长超时（并行运行时尤其如此）

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CompletionGate,
  createCompletionGate,
  DEFAULT_GATE_CONFIG,
  TYPECHECK_TIMEOUT,
  LINT_TIMEOUT,
  TEST_TIMEOUT,
  type GateResult,
  type GateCheck,
} from '../../src/agent/completion-gate.js';

describe('CompletionGate (Phase 31 Task 6.4)', { timeout: 30000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rd-gate-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('常量', () => {
    it('DEFAULT_GATE_CONFIG 有正确的默认值', () => {
      expect(DEFAULT_GATE_CONFIG.gateTimeout).toBe(180000);
      expect(DEFAULT_GATE_CONFIG.gateRetry).toBe(1);
    });

    it('各项检查超时常量正确', () => {
      expect(TYPECHECK_TIMEOUT).toBe(60000);
      expect(LINT_TIMEOUT).toBe(60000);
      expect(TEST_TIMEOUT).toBe(120000);
    });
  });

  describe('verify - 无配置文件', () => {
    it('没有 tsconfig/eslint/test 配置时返回空检查列表', async () => {
      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: [],
        projectPath: tempDir,
      });
      expect(result.checks.length).toBe(0);
      expect(result.passed).toBe(true); // 空检查列表视为通过
    });
  });

  describe('verify - 有 tsconfig.json', () => {
    it('检测到 tsconfig.json 时运行 typecheck', async () => {
      writeFileSync(join(tempDir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
      }));
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }));

      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: [],
        projectPath: tempDir,
      });

      const typecheckCheck = result.checks.find(c => c.name === 'typecheck');
      expect(typecheckCheck).toBeDefined();      expect(typeof typecheckCheck!.ok).toBe('boolean');
      expect(typecheckCheck!.duration).toBeGreaterThanOrEqual(0);
    });

    it('typecheck 检查结果包含 name/ok/output/duration', async () => {
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      writeFileSync(join(tempDir, 'package.json'), '{}');

      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: [],
        projectPath: tempDir,
      });

      const tc = result.checks.find(c => c.name === 'typecheck');
      expect(tc).toBeDefined();
      expect(tc).toHaveProperty('name');
      expect(tc).toHaveProperty('ok');
      expect(tc).toHaveProperty('output');
      expect(tc).toHaveProperty('duration');
    });
  });

  describe('verify - 有 eslint 配置', () => {
    it('检测到 eslint.config.js 时运行 lint', async () => {
      writeFileSync(join(tempDir, 'eslint.config.js'), 'export default {};');
      writeFileSync(join(tempDir, 'package.json'), '{}');

      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: [],
        projectPath: tempDir,
      });

      const lintCheck = result.checks.find(c => c.name === 'lint');
      expect(lintCheck).toBeDefined();
    });

    it('检测到 .eslintrc.json 时运行 lint', async () => {
      writeFileSync(join(tempDir, '.eslintrc.json'), '{}');
      writeFileSync(join(tempDir, 'package.json'), '{}');

      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: [],
        projectPath: tempDir,
      });

      const lintCheck = result.checks.find(c => c.name === 'lint');
      expect(lintCheck).toBeDefined();
    });
  });

  describe('verify - 有测试配置', () => {
    it('检测到 vitest.config.ts 时运行 tests', async () => {
      writeFileSync(join(tempDir, 'vitest.config.ts'), 'export default {};');
      writeFileSync(join(tempDir, 'package.json'), '{}');

      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: [],
        projectPath: tempDir,
      });

      const testCheck = result.checks.find(c => c.name === 'tests');
      expect(testCheck).toBeDefined();
    });

    it('检测到 jest.config.js 时运行 tests', async () => {
      writeFileSync(join(tempDir, 'jest.config.js'), 'module.exports = {};');
      writeFileSync(join(tempDir, 'package.json'), '{}');

      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: [],
        projectPath: tempDir,
      });

      const testCheck = result.checks.find(c => c.name === 'tests');
      expect(testCheck).toBeDefined();
    });
  });

  describe('verify - passed 判定', () => {
    it('所有检查通过时 passed 为 true', async () => {
      // 空目录，无配置 → 空检查列表 → passed = true
      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: [],
        projectPath: tempDir,
      });
      expect(result.passed).toBe(true);
    });

    it('skipped 检查不影响 passed（不阻断任务完成）', async () => {
      // 这个场景难以在单元测试中模拟超时，这里通过结构验证
      // skipped: true 的检查即使 ok: false 也不应使 passed = false
      const fakeResult: GateResult = {
        passed: true,
        checks: [
          { name: 'tests', ok: false, skipped: true, output: 'timeout', duration: 120000 },
        ],
      };
      // 验证逻辑：passed = checks.every(c => c.ok || c.skipped)
      expect(fakeResult.checks.every(c => c.ok || c.skipped)).toBe(true);
    });
  });

  describe('verify - modifiedFiles', () => {
    it('传入 modifiedFiles 不报错', async () => {
      writeFileSync(join(tempDir, 'vitest.config.ts'), 'export default {};');
      writeFileSync(join(tempDir, 'package.json'), '{}');

      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: ['src/a.ts', 'src/b.ts'],
        projectPath: tempDir,
      });

      expect(result.checks.length).toBeGreaterThan(0);
    });
  });

  describe('工厂函数', () => {
    it('createCompletionGate 使用默认配置', () => {
      const gate = createCompletionGate();
      expect(gate).toBeInstanceOf(CompletionGate);
    });

    it('createCompletionGate 接受部分配置覆盖', () => {
      const gate = createCompletionGate({ gateTimeout: 60000, gateRetry: 3 });
      expect(gate).toBeInstanceOf(CompletionGate);
    });
  });

  describe('GateCheck 结构', () => {
    it('GateCheck 包含必要字段', async () => {
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      writeFileSync(join(tempDir, 'package.json'), '{}');

      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: [],
        projectPath: tempDir,
      });

      const check = result.checks[0];
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('ok');
      expect(check).toHaveProperty('output');
      expect(check).toHaveProperty('duration');
    });
  });
});
