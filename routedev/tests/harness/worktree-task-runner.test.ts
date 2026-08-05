// tests/harness/worktree-task-runner.test.ts
// B-16：task worktree 隔离——runner 在 worktree 路径内驱动 kernel 执行
//
// 契约：
// 1. 依赖缺失时返回失败结果（fail-open，不抛异常）
// 2. 路由 → client 检查 → worktree 内执行（渲染 cwd=worktreePath）
// 3. 写入型工具调用收集 modifiedFiles
// 4. 结果聚合（content/usage/error）与 onProgress 转发
// 5. runReAct 缺失时显式失败

import { describe, it, expect } from 'vitest';
import { WorktreeTaskRunner, type WorktreeTaskRunnerDeps } from '../../src/harness/worktree-task-runner.js';

/** 假 kernel：发射工具调用 + 完成事件 */
function fakeKernel(overrides: { toolCalls?: Array<{ name: string; path?: string }>; error?: string } = {}) {
  const toolCalls = overrides.toolCalls ?? [{ name: 'file_edit', path: 'src/a.ts' }];
  return {
    runReAct: async function* () {
      for (const tc of toolCalls) {
        yield { type: 'tool_call_start', toolName: tc.name, toolCallId: 'c1', args: { path: tc.path } };
        yield { type: 'tool_call_result', toolName: tc.name, toolCallId: 'c1', result: 'ok', isError: false };
      }
      if (overrides.error) {
        yield { type: 'error', error: overrides.error };
        yield { type: 'done', content: 'partial', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      } else {
        yield { type: 'done', content: '任务完成', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
      }
    },
  };
}

function makeDeps(overrides: Partial<WorktreeTaskRunnerDeps> = {}): WorktreeTaskRunnerDeps {
  return {
    kernel: fakeKernel() as never,
    config: { general: { language: 'zh-CN' } },
    clientManager: { get: () => ({ isReady: () => true }) },
    classifier: { classify: async () => ({ tier: 'deterministic' }) },
    modelRouter: {
      route: async () => ({ model: { id: 'test-model' }, providerId: 'mock', originalTier: 'simple' }),
    },
    prompts: {
      renderPromptZones: async (id: string, context: Record<string, unknown>) => ({
        stable: `stable:${id}`,
        dynamic: `dynamic:cwd=${String(context.cwd)}`,
      }),
    },
    ...overrides,
  };
}

describe('B-16 WorktreeTaskRunner', () => {
  it('依赖缺失时返回失败结果（fail-open）', async () => {
    const runner = new WorktreeTaskRunner({ kernel: null as never });
    const result = await runner.runInWorktree('/tmp/exp-1', '任务');
    expect(result.success).toBe(false);
    expect(result.error).toContain('依赖缺失');
  });

  it('在 worktree 路径内渲染提示并驱动 kernel 执行', async () => {
    let renderedCwd = '';
    const deps = makeDeps({
      prompts: {
        renderPromptZones: async (_id: string, context: Record<string, unknown>) => {
          renderedCwd = String(context.cwd);
          return { stable: 's', dynamic: 'd' };
        },
      },
    });
    const runner = new WorktreeTaskRunner(deps);
    const result = await runner.runInWorktree('C:/worktrees/exp-7', '修复 bug');
    expect(renderedCwd).toBe('C:/worktrees/exp-7');
    expect(result.success).toBe(true);
    expect(result.tokenUsage).toBe(30);
    expect(result.result).toContain('任务完成');
  });

  it('收集写入型工具修改的文件（file_edit/file_write），忽略只读工具', async () => {
    const deps = makeDeps({
      kernel: fakeKernel({
        toolCalls: [
          { name: 'file_edit', path: 'src/a.ts' },
          { name: 'file_write', path: 'src/b.ts' },
          { name: 'file_read', path: 'src/c.ts' }, // 只读不收集
        ],
      }) as never,
    });
    const runner = new WorktreeTaskRunner(deps);
    const result = await runner.runInWorktree('/tmp/exp-2', '改代码');
    expect(result.modifiedFiles).toContain('src/a.ts');
    expect(result.modifiedFiles).toContain('src/b.ts');
    expect(result.modifiedFiles).not.toContain('src/c.ts');
  });

  it('run 中出现 error 事件时标记失败并携带错误', async () => {
    const deps = makeDeps({ kernel: fakeKernel({ error: 'LLM connection failed' }) as never });
    const runner = new WorktreeTaskRunner(deps);
    const result = await runner.runInWorktree('/tmp/exp-3', '任务');
    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM connection failed');
  });

  it('client 不可用时任务不执行（provider 检查）', async () => {
    const deps = makeDeps({ clientManager: { get: () => ({ isReady: () => false }) } });
    const runner = new WorktreeTaskRunner(deps);
    const result = await runner.runInWorktree('/tmp/exp-4', '任务');
    expect(result.success).toBe(false);
    expect(result.error).toContain('不可用');
  });

  it('runReAct 缺失时显式失败', async () => {
    const deps = makeDeps({ kernel: {} as never });
    const runner = new WorktreeTaskRunner(deps);
    const result = await runner.runInWorktree('/tmp/exp-5', '任务');
    expect(result.success).toBe(false);
    expect(result.error).toContain('runReAct');
  });

  it('onProgress 转发 running/completed 阶段', async () => {
    const phases: string[] = [];
    const runner = new WorktreeTaskRunner(makeDeps());
    await runner.runInWorktree('/tmp/exp-6', '任务', {
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases).toContain('running');
    expect(phases).toContain('completed');
  });
});
