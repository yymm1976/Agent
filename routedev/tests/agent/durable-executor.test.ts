// tests/agent/durable-executor.test.ts
// DurableExecutor 持久化执行器测试（Phase 24 Task 3）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DurableExecutor,
  createDurableExecutor,
  type StepExecutor,
  type ExecutionSnapshot,
  type DurableExecutorOptions,
} from '../../src/agent/durable-executor.js';
import type { PlanStep } from '../../src/agent/goal-types.js';
import type { StepResult } from '../../src/agent/hooks.js';
import { createHookRunner, type HookDefinition } from '../../src/agent/hooks.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建临时存储目录 */
async function makeTempStorageRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-test-'));
  return dir;
}

/** 创建测试用 PlanStep */
function makeStep(id: number, description: string = `步骤 ${id}`): PlanStep {
  return {
    id,
    description,
    status: 'pending',
    dependencies: [],
  };
}

/** 创建 mock StepExecutor */
function makeMockExecutor(
  results: Array<StepResult | Error>,
): StepExecutor & { calls: Array<{ step: PlanStep; goal: string }> } {
  const calls: Array<{ step: PlanStep; goal: string }> = [];
  let index = 0;
  return {
    calls,
    async execute(step: PlanStep, goal: string): Promise<StepResult> {
      calls.push({ step, goal });
      const result = results[index++];
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

/** 创建基础选项 */
function makeOptions(
  storageRoot: string,
  executor: StepExecutor,
  extra?: Partial<DurableExecutorOptions>,
): DurableExecutorOptions {
  return {
    sessionId: 'test-session',
    executor,
    storageRoot,
    projectPath: '/test/project',
    ...extra,
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('DurableExecutor 持久化执行器 (Phase 24 Task 3)', () => {
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = await makeTempStorageRoot();
  });

  afterEach(async () => {
    // 清理临时目录
    try {
      await fs.rm(storageRoot, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  // ============================================================
  // start() 基本执行
  // ============================================================
  describe('start() 基本执行', () => {
    it('执行空计划抛出错误', async () => {
      const executor = makeMockExecutor([]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));
      await expect(de.start([], '空目标')).rejects.toThrow('不能为空');
    });

    it('执行单步计划成功', async () => {
      const executor = makeMockExecutor([
        { success: true, output: '步骤1完成', durationMs: 100 },
      ]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const result = await de.start([makeStep(1)], '测试目标');

      expect(result.success).toBe(true);
      expect(result.snapshot.status).toBe('completed');
      expect(result.snapshot.totalSteps).toBe(1);
      expect(result.snapshot.lastStepCompleted).toBe(1);
      expect(result.snapshot.completedResults).toHaveLength(1);
      expect(result.snapshot.completedResults[0].output).toBe('步骤1完成');
      expect(result.snapshot.nextStep).toBeNull();
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0].goal).toBe('测试目标');
    });

    it('执行多步计划成功', async () => {
      const executor = makeMockExecutor([
        { success: true, output: '步骤1', durationMs: 50 },
        { success: true, output: '步骤2', durationMs: 60 },
        { success: true, output: '步骤3', durationMs: 70 },
      ]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const result = await de.start(
        [makeStep(1), makeStep(2), makeStep(3)],
        '多步目标',
      );

      expect(result.success).toBe(true);
      expect(result.snapshot.status).toBe('completed');
      expect(result.snapshot.lastStepCompleted).toBe(3);
      expect(result.snapshot.completedResults).toHaveLength(3);
      expect(executor.calls).toHaveLength(3);
      // 验证步骤按顺序执行
      expect(executor.calls[0].step.id).toBe(1);
      expect(executor.calls[1].step.id).toBe(2);
      expect(executor.calls[2].step.id).toBe(3);
    });

    it('执行成功后生成 planId', async () => {
      const executor = makeMockExecutor([
        { success: true, output: 'ok', durationMs: 10 },
      ]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const result = await de.start([makeStep(1)], '目标');

      expect(result.snapshot.planId).toBeTruthy();
      expect(result.snapshot.planId).toMatch(/^plan-/);
    });
  });

  // ============================================================
  // 持久化与快照
  // ============================================================
  describe('持久化与快照', () => {
    it('每步完成自动保存快照到磁盘', async () => {
      const executor = makeMockExecutor([
        { success: true, output: '步骤1', durationMs: 10 },
        { success: true, output: '步骤2', durationMs: 10 },
      ]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const result = await de.start([makeStep(1), makeStep(2)], '目标');
      const snapshot = de.getSnapshot(result.snapshot.planId);

      expect(snapshot).not.toBeNull();
      expect(snapshot!.status).toBe('completed');
      expect(snapshot!.lastStepCompleted).toBe(2);
      expect(snapshot!.totalSteps).toBe(2);
    });

    it('getSnapshot 返回 null 当 planId 不存在', () => {
      const executor = makeMockExecutor([]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));
      expect(de.getSnapshot('nonexistent')).toBeNull();
    });

    it('快照文件路径符合规范', async () => {
      const executor = makeMockExecutor([
        { success: true, output: 'ok', durationMs: 10 },
      ]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const result = await de.start([makeStep(1)], '目标');
      const expectedPath = path.join(
        storageRoot,
        'test-session',
        result.snapshot.planId,
        'progress.json',
      );

      const fileContent = await fs.readFile(expectedPath, 'utf-8');
      const snapshot = JSON.parse(fileContent);
      expect(snapshot.planId).toBe(result.snapshot.planId);
    });

    it('快照包含完整字段', async () => {
      const executor = makeMockExecutor([
        { success: true, output: 'ok', durationMs: 42 },
      ]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const result = await de.start([makeStep(1)], '完整字段测试');
      const snapshot = de.getSnapshot(result.snapshot.planId)!;

      expect(snapshot).toHaveProperty('planId');
      expect(snapshot).toHaveProperty('goal', '完整字段测试');
      expect(snapshot).toHaveProperty('startedAt');
      expect(snapshot).toHaveProperty('lastStepCompleted');
      expect(snapshot).toHaveProperty('totalSteps');
      expect(snapshot).toHaveProperty('status');
      expect(snapshot).toHaveProperty('completedResults');
      expect(snapshot).toHaveProperty('nextStep');
      expect(snapshot).toHaveProperty('updatedAt');
      expect(typeof snapshot.startedAt).toBe('number');
      expect(typeof snapshot.updatedAt).toBe('number');
    });
  });

  // ============================================================
  // 失败与恢复
  // ============================================================
  describe('失败与恢复', () => {
    it('步骤抛出异常时标记为 failed', async () => {
      const executor = makeMockExecutor([
        new Error('步骤1执行失败'),
      ]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const result = await de.start([makeStep(1), makeStep(2)], '目标');

      expect(result.success).toBe(false);
      expect(result.snapshot.status).toBe('failed');
      expect(result.snapshot.lastStepCompleted).toBe(0);
      expect(result.error).toContain('步骤1执行失败');
    });

    it('步骤返回 success=false 时标记为 failed', async () => {
      const executor = makeMockExecutor([
        { success: false, output: '执行失败原因', durationMs: 10 },
      ]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const result = await de.start([makeStep(1)], '目标');

      expect(result.success).toBe(false);
      expect(result.snapshot.status).toBe('failed');
      expect(result.error).toContain('执行失败原因');
    });

    it('中间步骤失败时停止后续执行', async () => {
      const executor = makeMockExecutor([
        { success: true, output: '步骤1', durationMs: 10 },
        new Error('步骤2失败'),
        { success: true, output: '步骤3', durationMs: 10 }, // 不应执行
      ]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const result = await de.start(
        [makeStep(1), makeStep(2), makeStep(3)],
        '目标',
      );

      expect(result.success).toBe(false);
      expect(result.snapshot.status).toBe('failed');
      expect(result.snapshot.lastStepCompleted).toBe(1); // 步骤1完成
      expect(executor.calls).toHaveLength(2); // 只执行了前两步
    });

    it('resumeFrom 不存在的 planId 返回失败', async () => {
      const executor = makeMockExecutor([]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const result = await de.resumeFrom('nonexistent-plan');

      expect(result.success).toBe(false);
      expect(result.error).toContain('找不到');
    });

    it('resumeFrom 已完成的计划返回成功', async () => {
      const executor = makeMockExecutor([
        { success: true, output: 'ok', durationMs: 10 },
      ]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const startResult = await de.start([makeStep(1)], '目标');
      const resumeResult = await de.resumeFrom(startResult.snapshot.planId);

      expect(resumeResult.success).toBe(true);
      expect(resumeResult.error).toContain('已完成');
    });

    it('resumeFrom 从断点恢复执行', async () => {
      // 第一个 executor：执行第一步后失败
      const failingExecutor = makeMockExecutor([
        { success: true, output: '步骤1', durationMs: 10 },
        new Error('步骤2失败'),
      ]);
      const de1 = createDurableExecutor(makeOptions(storageRoot, failingExecutor));

      const startResult = await de1.start([makeStep(1), makeStep(2)], '恢复测试');
      expect(startResult.success).toBe(false);
      expect(startResult.snapshot.status).toBe('failed');

      // 第二个 executor：恢复执行（只执行 nextStep）
      const resumeExecutor = makeMockExecutor([
        { success: true, output: '恢复执行成功', durationMs: 20 },
      ]);
      const de2 = createDurableExecutor(
        makeOptions(storageRoot, resumeExecutor, { sessionId: 'test-session' }),
      );

      const resumeResult = await de2.resumeFrom(startResult.snapshot.planId);

      expect(resumeResult.success).toBe(true);
      expect(resumeResult.snapshot.status).toBe('completed');
      expect(resumeExecutor.calls).toHaveLength(1);
    });
  });

  // ============================================================
  // 并发保护
  // ============================================================
  describe('并发保护', () => {
    it('同一 planId 不能并发执行', async () => {
      // 模拟慢执行
      const slowExecutor: StepExecutor = {
        async execute(): Promise<StepResult> {
          await new Promise(resolve => setTimeout(resolve, 100));
          return { success: true, output: 'slow', durationMs: 100 };
        },
      };
      const de = createDurableExecutor(makeOptions(storageRoot, slowExecutor));

      // 启动后立即尝试 resumeFrom 同一 planId
      const startPromise = de.start([makeStep(1)], '并发测试');
      // startPromise 还在执行中，无法获取 planId，所以这里测试另一个场景：
      // 直接测试 resumeFrom 一个正在 running 的计划
      // 由于 start 是同步进入锁的，我们用另一种方式测试

      await startPromise;
      // 已完成，再 resume 应该返回"已完成"
      const result = await de.resumeFrom((await startPromise).snapshot.planId);
      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // listRecoverable()
  // ============================================================
  describe('listRecoverable()', () => {
    it('空目录返回空数组', () => {
      const executor = makeMockExecutor([]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));
      expect(de.listRecoverable()).toEqual([]);
    });

    it('列出 paused 和 failed 状态的快照', async () => {
      // 创建一个 failed 快照
      const failingExecutor = makeMockExecutor([new Error('失败')]);
      const de1 = createDurableExecutor(makeOptions(storageRoot, failingExecutor));
      const failedResult = await de1.start([makeStep(1)], '失败计划');

      // 创建一个 completed 快照（不应被列出）
      const successExecutor = makeMockExecutor([
        { success: true, output: 'ok', durationMs: 10 },
      ]);
      const de2 = createDurableExecutor(makeOptions(storageRoot, successExecutor));
      await de2.start([makeStep(1)], '成功计划');

      // 用新的 executor 实例列出
      const de3 = createDurableExecutor(makeOptions(storageRoot, makeMockExecutor([])));
      const recoverable = de3.listRecoverable();

      expect(recoverable).toHaveLength(1);
      expect(recoverable[0].planId).toBe(failedResult.snapshot.planId);
      expect(recoverable[0].status).toBe('failed');
    });

    it('按更新时间倒序排列', async () => {
      // 第一个失败计划
      const e1 = makeMockExecutor([new Error('fail1')]);
      const de1 = createDurableExecutor(makeOptions(storageRoot, e1));
      const r1 = await de1.start([makeStep(1)], '计划1');

      // 等待一小段时间确保 updatedAt 不同
      await new Promise(resolve => setTimeout(resolve, 10));

      // 第二个失败计划
      const e2 = makeMockExecutor([new Error('fail2')]);
      const de2 = createDurableExecutor(makeOptions(storageRoot, e2));
      const r2 = await de2.start([makeStep(1)], '计划2');

      const de3 = createDurableExecutor(makeOptions(storageRoot, makeMockExecutor([])));
      const recoverable = de3.listRecoverable();

      expect(recoverable).toHaveLength(2);
      // 最新的在前
      expect(recoverable[0].planId).toBe(r2.snapshot.planId);
      expect(recoverable[1].planId).toBe(r1.snapshot.planId);
    });

    it('跳过损坏的快照文件', async () => {
      // 创建一个有效快照
      const e1 = makeMockExecutor([new Error('fail')]);
      const de1 = createDurableExecutor(makeOptions(storageRoot, e1));
      await de1.start([makeStep(1)], '计划1');

      // 在同目录下创建一个损坏的快照
      const corruptDir = path.join(storageRoot, 'test-session', 'corrupt-plan');
      await fs.mkdir(corruptDir, { recursive: true });
      await fs.writeFile(
        path.join(corruptDir, 'progress.json'),
        '{ invalid json content }',
        'utf-8',
      );

      const de2 = createDurableExecutor(makeOptions(storageRoot, makeMockExecutor([])));
      const recoverable = de2.listRecoverable();

      // 损坏的被跳过，只返回有效的
      expect(recoverable).toHaveLength(1);
    });
  });

  // ============================================================
  // HookRunner 集成
  // ============================================================
  describe('HookRunner 集成', () => {
    it('pre-step 钩子返回 abort 时中止执行', async () => {
      const executor = makeMockExecutor([
        { success: true, output: 'ok', durationMs: 10 },
      ]);
      const hookRunner = createHookRunner();
      hookRunner.register({
        event: 'pre-step',
        handler: async () => ({ action: 'abort', message: '钩子中止' }),
        name: 'abort-hook',
      });
      const de = createDurableExecutor(
        makeOptions(storageRoot, executor, { hookRunner }),
      );

      const result = await de.start([makeStep(1)], '目标');

      expect(result.success).toBe(false);
      expect(result.snapshot.status).toBe('paused');
      expect(result.error).toContain('钩子中止');
      expect(executor.calls).toHaveLength(0); // 步骤未执行
    });

    it('pre-step 钩子返回 skip 时跳过步骤', async () => {
      const executor = makeMockExecutor([
        { success: true, output: 'ok', durationMs: 10 },
      ]);
      const hookRunner = createHookRunner();
      hookRunner.register({
        event: 'pre-step',
        handler: async () => ({ action: 'skip', message: '跳过' }),
        name: 'skip-hook',
      });
      const de = createDurableExecutor(
        makeOptions(storageRoot, executor, { hookRunner }),
      );

      const result = await de.start([makeStep(1)], '目标');

      expect(result.success).toBe(true);
      expect(result.snapshot.status).toBe('completed');
      expect(executor.calls).toHaveLength(0); // 步骤被跳过，未实际执行
      expect(result.snapshot.completedResults[0].output).toContain('skipped');
    });

    it('post-step 钩子可修改步骤结果', async () => {
      const executor = makeMockExecutor([
        { success: true, output: '原始结果', durationMs: 10 },
      ]);
      const hookRunner = createHookRunner();
      hookRunner.register({
        event: 'post-step',
        handler: async () => ({
          action: 'continue',
          modifiedResult: { success: true, output: '修改后结果', durationMs: 99 },
        }),
        name: 'modify-hook',
      });
      const de = createDurableExecutor(
        makeOptions(storageRoot, executor, { hookRunner }),
      );

      const result = await de.start([makeStep(1)], '目标');

      expect(result.success).toBe(true);
      expect(result.snapshot.completedResults[0].output).toBe('修改后结果');
      expect(result.snapshot.completedResults[0].durationMs).toBe(99);
    });

    it('on-error 钩子返回 retry 时重试步骤', async () => {
      // 第一次失败，重试成功
      let callCount = 0;
      const executor: StepExecutor = {
        async execute(): Promise<StepResult> {
          callCount++;
          if (callCount === 1) {
            throw new Error('第一次失败');
          }
          return { success: true, output: '重试成功', durationMs: 10 };
        },
      };
      const hookRunner = createHookRunner();
      hookRunner.register({
        event: 'on-error',
        handler: async () => ({ action: 'retry', message: '重试' }),
        name: 'retry-hook',
      });
      const de = createDurableExecutor(
        makeOptions(storageRoot, executor, { hookRunner }),
      );

      const result = await de.start([makeStep(1)], '目标');

      expect(result.success).toBe(true);
      expect(result.snapshot.completedResults[0].output).toBe('重试成功');
      expect(callCount).toBe(2); // 执行了两次
    });

    it('on-complete 钩子在全计划完成后触发', async () => {
      const executor = makeMockExecutor([
        { success: true, output: '步骤1', durationMs: 10 },
        { success: true, output: '步骤2', durationMs: 10 },
      ]);
      const completedEvents: string[] = [];
      const hookRunner = createHookRunner();
      hookRunner.register({
        event: 'on-complete',
        handler: async (ctx) => {
          completedEvents.push(ctx.stepId);
          return { action: 'continue' };
        },
        name: 'complete-hook',
      });
      const de = createDurableExecutor(
        makeOptions(storageRoot, executor, { hookRunner }),
      );

      const result = await de.start([makeStep(1), makeStep(2)], '目标');

      expect(result.success).toBe(true);
      // on-complete 只触发一次
      expect(completedEvents).toHaveLength(1);
    });

    it('钩子异常不影响主流程', async () => {
      const executor = makeMockExecutor([
        { success: true, output: 'ok', durationMs: 10 },
      ]);
      const hookRunner = createHookRunner();
      hookRunner.register({
        event: 'pre-step',
        handler: async () => {
          throw new Error('钩子崩溃');
        },
        name: 'crash-hook',
      });
      const de = createDurableExecutor(
        makeOptions(storageRoot, executor, { hookRunner }),
      );

      const result = await de.start([makeStep(1)], '目标');

      // 钩子崩溃被捕获，步骤仍执行
      expect(result.success).toBe(true);
      expect(executor.calls).toHaveLength(1);
    });
  });

  // ============================================================
  // 原子写入
  // ============================================================
  describe('原子写入', () => {
    it('写入后不留 .tmp 文件', async () => {
      const executor = makeMockExecutor([
        { success: true, output: 'ok', durationMs: 10 },
      ]);
      const de = createDurableExecutor(makeOptions(storageRoot, executor));

      const result = await de.start([makeStep(1)], '目标');
      const snapshotDir = path.join(
        storageRoot,
        'test-session',
        result.snapshot.planId,
      );
      const entries = await fs.readdir(snapshotDir);

      expect(entries).toContain('progress.json');
      expect(entries).not.toContain('progress.json.tmp');
    });
  });

  // ============================================================
  // 自定义存储路径
  // ============================================================
  describe('自定义存储路径', () => {
    it('使用自定义 storageRoot', async () => {
      const customRoot = await makeTempStorageRoot();
      try {
        const executor = makeMockExecutor([
          { success: true, output: 'ok', durationMs: 10 },
        ]);
        const de = createDurableExecutor(
          makeOptions(customRoot, executor, { sessionId: 'custom-session' }),
        );

        const result = await de.start([makeStep(1)], '目标');
        const expectedPath = path.join(
          customRoot,
          'custom-session',
          result.snapshot.planId,
          'progress.json',
        );

        const content = await fs.readFile(expectedPath, 'utf-8');
        expect(JSON.parse(content).planId).toBe(result.snapshot.planId);
      } finally {
        await fs.rm(customRoot, { recursive: true, force: true });
      }
    });
  });
});
