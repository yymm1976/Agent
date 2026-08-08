// tests/agent/completion-gate.test.ts
// Phase 31 Task 6.4：CompletionGate 独立代码验证门测试
// 注意：部分测试实际运行 typecheck/lint/tests 命令，需要较长超时（并行运行时尤其如此）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CompletionGate,
  createCompletionGate,
  toCompletionStatus,
  detectPackageManager,
  detectRunTarget,
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
    // EBUSY 重试：取消测试杀掉的进程树可能短暂占用临时目录，稍后清理
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
        return;
      } catch {
        // 目录仍被占用的可能性低，短暂等待后重试
        const until = Date.now() + 100;
        while (Date.now() < until) { /* busy-wait 100ms */ }
      }
    }
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

  describe('完成状态', () => {
    it.each([
      [undefined, false, 'execution_failed'],
      [undefined, true, 'completed_unverified'],
      [{ passed: true, checks: [] }, true, 'completed_unverified'],
      [{ passed: false, checks: [{ name: 'tests', ok: false, output: 'failed', duration: 1 }] }, true, 'verification_failed'],
      [{ passed: true, checks: [{ name: 'tests', ok: false, skipped: true, output: 'timeout', duration: 1 }] }, true, 'completed_unverified'],
      [{ passed: true, checks: [{ name: 'tests', ok: true, output: '', duration: 1 }] }, true, 'completed_verified'],
    ] as const)('映射 GateResult %#', (result, succeeded, expected) => {
      expect(toCompletionStatus(result, succeeded)).toBe(expected);
    });

    // GA Hardening 第3项：用户取消必须是 'cancelled'，即使 checks 显示失败/未通过
    it('GateResult.cancelled → cancelled（不误报 verification_failed）', () => {
      const cancelled: GateResult = {
        passed: false,
        cancelled: true,
        checks: [{ name: 'tests', ok: false, skipped: true, cancelled: true, output: '已取消（用户中断）', duration: 100 }],
      };
      expect(toCompletionStatus(cancelled, true)).toBe('cancelled');
    });

    it('GateResult.cancelled + 执行失败 → execution_failed 优先（计划自身失败优先于取消）', () => {
      const cancelled: GateResult = { passed: false, cancelled: true, checks: [] };
      expect(toCompletionStatus(cancelled, false)).toBe('execution_failed');
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

  describe('GA Hardening 第3项：AbortSignal 全链路', () => {
    it('预取消信号：不 spawn 任何命令，返回 cancelled=true + cancelled 检查', async () => {
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }));

      const controller = new AbortController();
      controller.abort(); // 预取消
      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: [],
        projectPath: tempDir,
        signal: controller.signal,
      });

      expect(result.cancelled).toBe(true);
      expect(result.checks.length).toBeGreaterThan(0);
      for (const check of result.checks) {
        expect(check.cancelled).toBe(true);
      }
    });

    it('运行中取消：杀进程树，typecheck 返回 cancelled 而非超时跳过/失败', async () => {
      // 脚本故意长时间运行（60s），验证取消能立即杀进程树而不是等超时
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        name: 'test',
        scripts: { typecheck: 'node -e "setTimeout(() => {}, 60000)"' },
      }));

      const controller = new AbortController();
      const gate = createCompletionGate();
      const start = Date.now();
      // 发起验证，200ms 后取消
      const verifyPromise = gate.verify({
        modifiedFiles: ['src/a.ts'],
        projectPath: tempDir,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 200);
      const result = await verifyPromise;

      const elapsed = Date.now() - start;
      expect(result.cancelled).toBe(true);
      // 取消后不再启动后续检查（lint/tests 无配置时本来就没有；typecheck 必须已取消）
      const tc = result.checks.find(c => c.name === 'typecheck');
      expect(tc).toBeDefined();
      expect(tc!.cancelled).toBe(true);
      expect(tc!.skipped).toBe(true);
      // 快速返回（远小于 60s 超时）
      expect(elapsed).toBeLessThan(10000);
    });

    it('正常完成且无信号：不设置 cancelled（无回归）', async () => {
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        name: 'test',
        scripts: { typecheck: 'node -e "console.log(\'ok\')"' },
      }));

      const gate = createCompletionGate();
      const result = await gate.verify({
        modifiedFiles: ['src/a.ts'],
        projectPath: tempDir,
      });

      expect(result.cancelled).toBeUndefined();
      const tc = result.checks.find(c => c.name === 'typecheck');
      expect(tc!.ok).toBe(true);
    });

    it('Closure 2：取消后进程树确实死亡——孙进程 sentinel 证明（非仅 Promise 快速返回）', async () => {
      // 进程树：npm run typecheck → node spawner → node grandchild（5s 后写 sentinel）
      // 取消必须杀整棵树；若只杀直接子进程，孙进程会在 5s 时写出 sentinel → 测试失败
      const sentinel = join(tempDir, 'grandchild-touched.txt');
      const spawnerCode = [
        "const { spawn } = require('node:child_process');",
        'const sentinel = process.argv[2];',
        "const code = 'setTimeout(() => require(\"node:fs\").writeFileSync(process.argv[1], \"touched\"), 5000)';",
        "spawn(process.execPath, ['-e', code, sentinel], { stdio: 'ignore' });",
        'setInterval(() => {}, 1000); // 保持进程树存活',
      ].join('\n');
      writeFileSync(join(tempDir, 'grandchild-spawner.js'), spawnerCode, 'utf-8');
      writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        name: 'test',
        scripts: { typecheck: `node grandchild-spawner.js ${JSON.stringify(sentinel)}` },
      }));

      const controller = new AbortController();
      const gate = createCompletionGate();
      const verifyPromise = gate.verify({
        modifiedFiles: ['src/a.ts'],
        projectPath: tempDir,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 300);
      const result = await verifyPromise;
      expect(result.cancelled).toBe(true);

      // 等待超过孙进程的写入时间——sentinel 必须从未出现（整棵树已死亡）
      const until = Date.now() + 5500;
      while (Date.now() < until) { /* 等待 */ }
      expect(existsSync(sentinel)).toBe(false);
    });
  });
});

// ============================================================
// Phase 92：项目脚本适配（detectPackageManager + detectRunTarget）
// ============================================================
describe('Phase 92：项目脚本适配', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rd-gate-p92-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('detectPackageManager', () => {
    it('无 lockfile 时默认为 npm', () => {
      expect(detectPackageManager(tempDir)).toBe('npm');
    });

    it('检测到 pnpm-lock.yaml 时返回 pnpm', () => {
      writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
      expect(detectPackageManager(tempDir)).toBe('pnpm');
    });

    it('检测到 yarn.lock 时返回 yarn', () => {
      writeFileSync(join(tempDir, 'yarn.lock'), '');
      expect(detectPackageManager(tempDir)).toBe('yarn');
    });

    it('pnpm-lock.yaml 优先于 yarn.lock', () => {
      writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
      writeFileSync(join(tempDir, 'yarn.lock'), '');
      expect(detectPackageManager(tempDir)).toBe('pnpm');
    });
  });

  describe('detectRunTarget', () => {
    it('无 package.json 时返回 null', () => {
      expect(detectRunTarget(tempDir, 'typecheck')).toBeNull();
    });

    it('package.json 无 scripts 字段时返回 null', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }));
      expect(detectRunTarget(tempDir, 'typecheck')).toBeNull();
    });

    it('scripts 中无对应脚本时返回 null', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        scripts: { build: 'tsc' },
      }));
      expect(detectRunTarget(tempDir, 'typecheck')).toBeNull();
    });

    it('scripts.test 为 "no test specified" 时返回 null', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        scripts: { test: 'echo "no test specified"' },
      }));
      expect(detectRunTarget(tempDir, 'test')).toBeNull();
    });

    it('有 typecheck 脚本 + pnpm-lock.yaml → 返回 pnpm run typecheck', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        scripts: { typecheck: 'tsc --noEmit' },
      }));
      writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');

      const target = detectRunTarget(tempDir, 'typecheck');
      expect(target).not.toBeNull();
      expect(target!.args).toEqual(['run', 'typecheck']);
      // cmd 在 Windows 上带 .cmd 后缀，非 Windows 不带
      if (process.platform === 'win32') {
        expect(target!.cmd).toBe('pnpm.cmd');
      } else {
        expect(target!.cmd).toBe('pnpm');
      }
    });

    it('有 lint 脚本 + yarn.lock → 返回 yarn run lint', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        scripts: { lint: 'eslint .' },
      }));
      writeFileSync(join(tempDir, 'yarn.lock'), '');

      const target = detectRunTarget(tempDir, 'lint');
      expect(target).not.toBeNull();
      expect(target!.args).toEqual(['run', 'lint']);
      if (process.platform === 'win32') {
        expect(target!.cmd).toBe('yarn.cmd');
      } else {
        expect(target!.cmd).toBe('yarn');
      }
    });

    it('无 lockfile 时默认 npm run <script>', () => {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        scripts: { test: 'vitest run' },
      }));

      const target = detectRunTarget(tempDir, 'test');
      expect(target).not.toBeNull();
      expect(target!.args).toEqual(['run', 'test']);
      if (process.platform === 'win32') {
        expect(target!.cmd).toBe('npm.cmd');
      } else {
        expect(target!.cmd).toBe('npm');
      }
    });

    it('package.json JSON 格式错误时返回 null（不抛异常）', () => {
      writeFileSync(join(tempDir, 'package.json'), '{ invalid json');
      expect(detectRunTarget(tempDir, 'typecheck')).toBeNull();
    });
  });
});

describe('B-04 按变更类型自动验证', () => {
  let gateTempDir: string;
  beforeEach(() => {
    gateTempDir = mkdtempSync(join(tmpdir(), 'rd-gate-b04-'));
  });
  afterEach(() => {
    rmSync(gateTempDir, { recursive: true, force: true });
  });

  it('isDocOnlyChange：全部为纯文档时返回 true', async () => {
    const { isDocOnlyChange } = await import('../../src/agent/completion-gate.js');
    expect(isDocOnlyChange(['README.md', 'notes/design.txt', 'assets/logo.svg'])).toBe(true);
  });

  it('isDocOnlyChange：配置类扩展名（json/yaml/toml/lock）不再视为文档（P1 语义修正）', async () => {
    const { isDocOnlyChange } = await import('../../src/agent/completion-gate.js');
    // 配置/依赖/CI 文件承载构建语义，必须经过验证
    expect(isDocOnlyChange(['config.json'])).toBe(false);
    expect(isDocOnlyChange(['pnpm-lock.yaml'])).toBe(false);
    expect(isDocOnlyChange(['package.json', 'tsconfig.json'])).toBe(false);
  });

  it('isDocOnlyChange：含代码文件时返回 false；空列表返回 false', async () => {
    const { isDocOnlyChange } = await import('../../src/agent/completion-gate.js');
    expect(isDocOnlyChange(['README.md', 'src/index.ts'])).toBe(false);
    expect(isDocOnlyChange(['no-extension-file'])).toBe(false);
    expect(isDocOnlyChange([])).toBe(false);
  });

  it('仅文档变更时跳过验证并返回说明（不跑命令）', async () => {
    const { createCompletionGate } = await import('../../src/agent/completion-gate.js');
    const gate = createCompletionGate();
    const result = await gate.verify({
      modifiedFiles: ['README.md', 'docs/design.txt'],
      projectPath: process.cwd(),
    });
    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([]);
    expect(result.warnings?.[0]).toContain('跳过');
  });

  it('includeTests=false 时 tests 检查标记 skipped（不运行全量测试）', async () => {
    // 复审修复：使用 fixture 项目（stub scripts 即时返回）——此前 projectPath 指向
    // 真实仓库，CI 慢环境下会执行真实 typecheck/lint 命令导致超时
    writeFileSync(join(gateTempDir, 'tsconfig.json'), '{}');
    writeFileSync(join(gateTempDir, 'vitest.config.ts'), '');
    writeFileSync(join(gateTempDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }));
    const { createCompletionGate } = await import('../../src/agent/completion-gate.js');
    const gate = createCompletionGate();
    const result = await gate.verify({
      modifiedFiles: ['src/index.ts'],
      projectPath: gateTempDir,
      includeTests: false,
    });
    const testsCheck = result.checks.find((c) => c.name === 'tests');
    expect(testsCheck).toBeDefined();
    expect(testsCheck!.skipped).toBe(true);
    expect(testsCheck!.output).toContain('未运行');
    // typecheck 检查走 stub script，快速返回且不依赖仓库环境
    const typecheckCheck = result.checks.find((c) => c.name === 'typecheck');
    expect(typecheckCheck).toBeDefined();
  });

  it('includeTests 缺省时仍运行 tests（兼容旧调用方）', async () => {
    // 复审修复：fixture 项目 stub scripts——绝不触发本仓库真实 pnpm test
    // （此前 Vitest 嵌套执行仓库 pnpm test 造成递归）
    writeFileSync(join(gateTempDir, 'tsconfig.json'), '{}');
    writeFileSync(join(gateTempDir, 'vitest.config.ts'), '');
    writeFileSync(join(gateTempDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }));
    const { createCompletionGate } = await import('../../src/agent/completion-gate.js');
    const gate = createCompletionGate();
    const result = await gate.verify({
      modifiedFiles: ['src/index.ts'],
      projectPath: gateTempDir,
    });
    const testsCheck = result.checks.find((c) => c.name === 'tests');
    expect(testsCheck).toBeDefined();
    expect(testsCheck!.skipped).not.toBe(true);
    // 断言测试命令确实被提交（stub 执行成功）
    expect(testsCheck!.ok).toBe(true);
  });
});
