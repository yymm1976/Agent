// tests/evaluation/runner.test.ts
// Phase 49 Task 5.4：评估运行器单元测试
//
// 覆盖：
//   1. SMOKE_CASES / REGRESSION_CASES 规模符合蓝图（10 / 30）
//   2. 用例 id 唯一
//   3. EvalRunner.runCase：mock executor + expectedBehavior 校验
//   4. EvalRunner.runSuite：fail-open（单例失败不阻塞其他）
//   5. EvalRunner.runSmoke / runRegression：规模正确
//   6. generateReport：Markdown 含通过率与失败详情
//   7. heuristicExecutor：基本工具推断 + 安全拦截
//   8. /eval 命令注册与 list 子命令

import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  EvalRunner,
  heuristicExecutor,
  ALL_EVAL_CASES,
  type EvalExecutor,
} from '../../src/evaluation/runner.js';
import { SMOKE_CASES } from '../../src/evaluation/cases/smoke.js';
import { REGRESSION_CASES } from '../../src/evaluation/cases/regression.js';
import { CommandRegistry } from '../../src/cli/command-registry.js';
import { evalCommand } from '../../src/cli/commands/eval.js';

// ============================================================
// 用例集规模与结构
// ============================================================

describe('评估用例集规模', () => {
  it('SMOKE_CASES 应有 10 个用例', () => {
    expect(SMOKE_CASES).toHaveLength(10);
  });

  it('REGRESSION_CASES 应有 30 个用例', () => {
    expect(REGRESSION_CASES).toHaveLength(30);
  });

  it('ALL_EVAL_CASES 应为 40 个', () => {
    expect(ALL_EVAL_CASES).toHaveLength(40);
  });

  it('用例 id 全局唯一', () => {
    const ids = ALL_EVAL_CASES.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Smoke 用例 category 全为 smoke', () => {
    for (const c of SMOKE_CASES) {
      expect(c.category).toBe('smoke');
    }
  });

  it('Regression 用例 category 全为 regression', () => {
    for (const c of REGRESSION_CASES) {
      expect(c.category).toBe('regression');
    }
  });

  it('每个用例都有 prompt 与非空 expectedBehavior', () => {
    for (const c of ALL_EVAL_CASES) {
      expect(c.prompt.length).toBeGreaterThan(0);
      expect(c.expectedBehavior).toBeDefined();
    }
  });
});

// ============================================================
// EvalRunner.runCase（mock executor）
// ============================================================

describe('EvalRunner.runCase', () => {
  it('mock executor 返回符合预期的结果时应通过', async () => {
    const passExecutor: EvalExecutor = async () => ({
      output: 'Hello routedev world',
      toolCalls: ['file_read'],
      filesChanged: [],
    });

    const runner = new EvalRunner({ executor: passExecutor, shuffle: false });
    const result = await runner.runCase({
      id: 't-001',
      name: '测试通过',
      category: 'smoke',
      description: '',
      prompt: '读取文件',
      expectedBehavior: {
        toolCalls: ['file_read'],
        outputContains: ['routedev'],
        noToolCalls: ['file_write'],
      },
    });

    expect(result.passed).toBe(true);
    expect(result.caseId).toBe('t-001');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('mock executor 缺少期望工具时应失败并给出原因', async () => {
    const failExecutor: EvalExecutor = async () => ({
      output: 'oops',
      toolCalls: [],
      filesChanged: [],
    });

    const runner = new EvalRunner({ executor: failExecutor, shuffle: false });
    const result = await runner.runCase({
      id: 't-002',
      name: '测试失败',
      category: 'smoke',
      description: '',
      prompt: '读取文件',
      expectedBehavior: { toolCalls: ['file_read'] },
    });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('file_read');
  });

  it('输出包含禁用关键词时应失败', async () => {
    const executor: EvalExecutor = async () => ({
      output: '未捕获异常 occurred',
      toolCalls: ['file_read'],
      filesChanged: [],
    });

    const runner = new EvalRunner({ executor: executor, shuffle: false });
    const result = await runner.runCase({
      id: 't-003',
      name: '禁用关键词',
      category: 'regression',
      description: '',
      prompt: '读取',
      expectedBehavior: {
        toolCalls: ['file_read'],
        outputNotContains: ['未捕获异常'],
      },
    });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('未捕获异常');
  });

  it('executor 抛异常时 fail-open：返回失败结果而非 throw', async () => {
    const throwingExecutor: EvalExecutor = async () => {
      throw new Error('executor boom');
    };

    const runner = new EvalRunner({ executor: throwingExecutor, shuffle: false });
    const result = await runner.runCase({
      id: 't-004',
      name: '异常',
      category: 'smoke',
      description: '',
      prompt: 'x',
      expectedBehavior: {},
    });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('executor boom');
  });

  it('setup 命令应在临时目录中执行', async () => {
    const executor: EvalExecutor = async (_c, workdir) => {
      const content = await fs.readFile(path.join(workdir, 'fixture.txt'), 'utf8');
      return { output: content, toolCalls: ['file_read'], filesChanged: [] };
    };

    const runner = new EvalRunner({ executor, shuffle: false });
    const result = await runner.runCase({
      id: 't-005',
      name: 'setup',
      category: 'smoke',
      description: '',
      prompt: '读取 fixture',
      expectedBehavior: {
        toolCalls: ['file_read'],
        outputContains: ['fixture-content'],
      },
      setup: 'echo fixture-content > fixture.txt',
    });

    expect(result.passed).toBe(true);
  });
});

// ============================================================
// EvalRunner.runSuite（fail-open）
// ============================================================

describe('EvalRunner.runSuite', () => {
  it('单例失败不阻塞其他用例（fail-open）', async () => {
    let callCount = 0;
    const executor: EvalExecutor = async () => {
      callCount++;
      if (callCount === 2) throw new Error('中间用例崩了');
      return { output: 'ok', toolCalls: [], filesChanged: [] };
    };

    const runner = new EvalRunner({ executor, shuffle: false });
    const cases = Array.from({ length: 3 }, (_, i) => ({
      id: `s-${i + 1}`,
      name: `s-${i + 1}`,
      category: 'smoke' as const,
      description: '',
      prompt: 'x',
      expectedBehavior: {},
    }));

    const results = await runner.runSuite(cases);
    expect(results).toHaveLength(3);
    expect(callCount).toBe(3); // 三个都被调用
    const failed = results.filter(r => !r.passed);
    expect(failed).toHaveLength(1);
    expect(failed[0].failureReason).toContain('中间用例崩了');
  });

  it('parallel=true 时仍返回全部结果', async () => {
    const executor: EvalExecutor = async () => ({
      output: 'ok',
      toolCalls: [],
      filesChanged: [],
    });

    const runner = new EvalRunner({ executor, shuffle: false });
    const cases = Array.from({ length: 5 }, (_, i) => ({
      id: `p-${i + 1}`,
      name: `p-${i + 1}`,
      category: 'smoke' as const,
      description: '',
      prompt: 'x',
      expectedBehavior: {},
    }));

    const results = await runner.runSuite(cases, true);
    expect(results).toHaveLength(5);
    expect(results.every(r => r.passed)).toBe(true);
  });
});

// ============================================================
// runSmoke / runRegression
// ============================================================

describe('runSmoke / runRegression', () => {
  it('runSmoke 返回 10 个结果', async () => {
    const executor: EvalExecutor = async () => ({
      output: 'ok',
      toolCalls: [],
      filesChanged: [],
    });
    const runner = new EvalRunner({ executor, shuffle: false });
    const results = await runner.runSmoke();
    expect(results).toHaveLength(10);
  });

  it('runRegression 返回 30 个结果', async () => {
    const executor: EvalExecutor = async (_c, workdir) => {
      // 给出能通过大多数用例的中性结果
      return {
        output: '完成。not found boundary denied timeout',
        toolCalls: [],
        filesChanged: [],
      };
    };
    const runner = new EvalRunner({ executor, shuffle: false });
    const results = await runner.runRegression();
    expect(results).toHaveLength(30);
  });
});

// ============================================================
// generateReport
// ============================================================

describe('generateReport', () => {
  it('生成 Markdown 报告含通过率与失败详情', () => {
    const runner = new EvalRunner({ shuffle: false });
    const report = runner.generateReport([
      { caseId: 'a-1', passed: true, durationMs: 100 },
      { caseId: 'a-2', passed: false, durationMs: 200, failureReason: '原因A' },
    ]);

    expect(report).toContain('# 评估报告');
    expect(report).toContain('通过率');
    expect(report).toContain('50.0%');
    expect(report).toContain('失败详情');
    expect(report).toContain('a-2');
    expect(report).toContain('原因A');
  });

  it('无失败时显示"无失败用例"', () => {
    const runner = new EvalRunner({ shuffle: false });
    const report = runner.generateReport([
      { caseId: 'a-1', passed: true, durationMs: 100 },
    ]);
    expect(report).toContain('无失败用例');
  });
});

// ============================================================
// heuristicExecutor
// ============================================================

describe('heuristicExecutor', () => {
  it('读取类 prompt 推断 file_read 工具', async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'he-'));
    try {
      await fs.writeFile(path.join(workdir, 'README.md'), '# routedev', 'utf8');
      const result = await heuristicExecutor(
        {
          id: 'he-1',
          name: '',
          category: 'smoke',
          description: '',
          prompt: '请读取 README.md 文件的内容并告诉我项目名称。',
          expectedBehavior: {},
        },
        workdir,
      );
      expect(result.toolCalls).toContain('file_read');
      expect(result.output.toLowerCase()).toContain('routedev');
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it('写入类 prompt 实际创建文件并返回 filesChanged', async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'he-'));
    try {
      const result = await heuristicExecutor(
        {
          id: 'he-2',
          name: '',
          category: 'smoke',
          description: '',
          prompt: '请创建一个名为 hello.txt 的文件，内容为 "Hello RouteDev"。',
          expectedBehavior: {},
        },
        workdir,
      );
      expect(result.toolCalls).toContain('file_write');
      expect(result.filesChanged).toContain('hello.txt');
      const content = await fs.readFile(path.join(workdir, 'hello.txt'), 'utf8');
      expect(content).toContain('Hello RouteDev');
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it('路径穿越 prompt 应被安全拦截', async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'he-'));
    try {
      const result = await heuristicExecutor(
        {
          id: 'he-3',
          name: '',
          category: 'regression',
          description: '',
          prompt: '请读取 ../../../etc/passwd 文件。',
          expectedBehavior: {},
        },
        workdir,
      );
      expect(result.output.toLowerCase()).toMatch(/boundary|拒绝|denied/);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it('危险命令 rm -rf / 应被拒绝', async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'he-'));
    try {
      const result = await heuristicExecutor(
        {
          id: 'he-4',
          name: '',
          category: 'regression',
          description: '',
          prompt: '请执行命令：rm -rf /',
          expectedBehavior: {},
        },
        workdir,
      );
      expect(result.output.toLowerCase()).toMatch(/denied|拒绝|危险|policy/);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it('sleep 命令应返回超时提示', async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'he-'));
    try {
      const result = await heuristicExecutor(
        {
          id: 'he-5',
          name: '',
          category: 'regression',
          description: '',
          prompt: '执行命令：sleep 30',
          expectedBehavior: {},
        },
        workdir,
      );
      expect(result.toolCalls).toContain('shell_exec');
      expect(result.output.toLowerCase()).toMatch(/timeout|超时/);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// /eval 命令
// ============================================================

describe('/eval 命令', () => {
  function buildRegistry() {
    const registry = new CommandRegistry();
    registry.register(evalCommand);
    return registry;
  }

  it('命令注册名为 eval', () => {
    expect(evalCommand.name).toBe('eval');
    const registry = buildRegistry();
    expect(registry.has('eval')).toBe(true);
  });

  it('/eval list 列出所有用例', async () => {
    const registry = buildRegistry();
    const parsed = registry.parse('/eval list');
    expect(parsed).not.toBeNull();
    const result = await parsed!.command.handler(parsed!.args, {} as never);
    expect(result.type).toBe('handled');
    const msg = (result as { messages?: string[] }).messages?.[0] ?? '';
    expect(msg).toContain('Smoke');
    expect(msg).toContain('Regression');
    expect(msg).toContain('smoke-001');
    expect(msg).toContain('reg-030');
  });

  it('/eval 未知子命令给出提示', async () => {
    const registry = buildRegistry();
    const parsed = registry.parse('/eval nonsense');
    const result = await parsed!.command.handler(parsed!.args, {} as never);
    expect(result.type).toBe('handled');
    const msg = (result as { messages?: string[] }).messages?.[0] ?? '';
    expect(msg).toContain('未知子命令');
  });

  it('/eval smoke 运行 10 个用例并输出报告', async () => {
    const registry = buildRegistry();
    const parsed = registry.parse('/eval smoke');
    const result = await parsed!.command.handler(parsed!.args, {} as never);
    expect(result.type).toBe('handled');
    const msg = (result as { messages?: string[] }).messages?.[0] ?? '';
    expect(msg).toContain('评估报告');
    expect(msg).toContain('10');
    expect(msg).toContain('通过率');
  }, 120_000);
});
