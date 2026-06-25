// tests/harness/experiment-runner.test.ts
// Phase 39 Task 3：ExperimentRunner 测试
// 测试 runInWorktree（mock AgentLoop）、getModifiedFiles、chdir 恢复
//
// 使用真实临时 Git 仓库 + mock AgentLoop 验证

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExperimentRunner } from '../../src/harness/experiment-runner.js';
import type { IAgentLoop, AgentLoopEvent } from '../../src/harness/experiment-runner.js';
import type { ILLMClient, RoutingResult } from '../../src/router/types.js';
import type { ToolExecutorAdapter } from '../../src/agent/loop-config.js';

const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** 创建 mock LLM 客户端 */
function makeMockLLMClient(): ILLMClient {
  return {
    protocol: 'openai',
    providerId: 'test',
    isReady: () => true,
    complete: vi.fn(async () => ({
      content: 'mock response',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
      model: 'test-model',
    })),
    stream: vi.fn(async function* () {
      /* empty */
    }),
  };
}

/** 创建 mock 路由决策 */
function makeMockRouteDecision(): RoutingResult {
  return {
    model: {
      id: 'test-model',
      provider: 'openai',
      tier: 'simple',
      maxTokens: 4096,
    } as any,
    providerId: 'test',
    fallbackUsed: false,
    originalTier: 'simple',
    degraded: false,
  };
}

/** 创建 mock 工具执行器 */
function makeMockToolExecutor(): ToolExecutorAdapter {
  return {
    getToolDefinitions: () => [],
    executeTool: vi.fn(async () => 'mock result'),
    hasTool: () => false,
  };
}

/** 创建 mock AgentLoop，yield 指定事件序列 */
function makeMockAgentLoop(events: AgentLoopEvent[]): IAgentLoop {
  return {
    run: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe.skipIf(!HAS_GIT)('ExperimentRunner', () => {
  let tmpDir: string;
  let worktreePath: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-runner-'));
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.routedev/\n');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    // 创建 worktree
    worktreePath = path.join(tmpDir, 'worktree');
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'test-branch'], { cwd: tmpDir });
  });

  afterEach(() => {
    // 确保恢复原工作目录
    try {
      process.chdir(originalCwd);
    } catch {
      // 忽略
    }
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // 忽略
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runInWorktree：通过 mock AgentLoop 执行任务并收集结果', async () => {
    const mockEvents: AgentLoopEvent[] = [
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'World' },
      {
        type: 'done',
        content: 'Hello World',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
    ];

    const runner = new ExperimentRunner({
      llmClient: makeMockLLMClient(),
      routeDecision: makeMockRouteDecision(),
      systemPrompt: 'You are a test agent.',
      toolExecutor: makeMockToolExecutor(),
      agentLoopFactory: () => makeMockAgentLoop(mockEvents),
    });

    const result = await runner.runInWorktree(worktreePath, 'test task');

    expect(result.success).toBe(true);
    expect(result.result).toBe('Hello World');
    expect(result.tokenUsage).toBe(30);
    expect(result.modifiedFiles).toEqual([]);
  });

  it('runInWorktree：收集 worktree 中的变更文件', async () => {
    // mock AgentLoop 在 worktree 中创建文件（模拟工具调用副作用）
    const mockEvents: AgentLoopEvent[] = [
      {
        type: 'done',
        content: 'done',
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
      },
    ];

    const runner = new ExperimentRunner({
      llmClient: makeMockLLMClient(),
      routeDecision: makeMockRouteDecision(),
      systemPrompt: 'test',
      toolExecutor: makeMockToolExecutor(),
      agentLoopFactory: () => makeMockAgentLoop(mockEvents),
    });

    // 在 AgentLoop 执行前，先在 worktree 中创建文件（模拟工具调用产生的副作用）
    // 由于 mock 是同步的，我们在调用前预先创建文件
    fs.writeFileSync(path.join(worktreePath, 'new-file.txt'), 'new content');
    fs.writeFileSync(path.join(worktreePath, 'README.md'), '# Modified');

    const result = await runner.runInWorktree(worktreePath, 'test task');

    expect(result.success).toBe(true);
    expect(result.modifiedFiles).toContain('new-file.txt');
    expect(result.modifiedFiles).toContain('README.md');
  });

  it('runInWorktree：执行后恢复原工作目录（chdir 恢复）', async () => {
    const beforeCwd = process.cwd();
    const mockEvents: AgentLoopEvent[] = [
      {
        type: 'done',
        content: 'done',
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      },
    ];

    const runner = new ExperimentRunner({
      llmClient: makeMockLLMClient(),
      routeDecision: makeMockRouteDecision(),
      systemPrompt: 'test',
      toolExecutor: makeMockToolExecutor(),
      agentLoopFactory: () => makeMockAgentLoop(mockEvents),
    });

    await runner.runInWorktree(worktreePath, 'test task');

    // 执行后应恢复原工作目录
    expect(process.cwd()).toBe(beforeCwd);
  });

  it('runInWorktree：AgentLoop 抛出异常时仍恢复工作目录并返回失败', async () => {
    const beforeCwd = process.cwd();

    // mock AgentLoop 抛出异常
    const errorLoop: IAgentLoop = {
      run: async function* () {
        throw new Error('AgentLoop crashed');
      },
    };

    const runner = new ExperimentRunner({
      llmClient: makeMockLLMClient(),
      routeDecision: makeMockRouteDecision(),
      systemPrompt: 'test',
      toolExecutor: makeMockToolExecutor(),
      agentLoopFactory: () => errorLoop,
    });

    const result = await runner.runInWorktree(worktreePath, 'crash task');

    expect(result.success).toBe(false);
    expect(result.error).toContain('AgentLoop crashed');
    // 异常后仍恢复工作目录
    expect(process.cwd()).toBe(beforeCwd);
  });

  it('runInWorktree：通过 onProgress 回调报告进度', async () => {
    const mockEvents: AgentLoopEvent[] = [
      {
        type: 'done',
        content: 'completed',
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      },
    ];

    const progressCalls: string[] = [];

    const runner = new ExperimentRunner({
      llmClient: makeMockLLMClient(),
      routeDecision: makeMockRouteDecision(),
      systemPrompt: 'test',
      toolExecutor: makeMockToolExecutor(),
      agentLoopFactory: () => makeMockAgentLoop(mockEvents),
    });

    await runner.runInWorktree(worktreePath, 'progress task', {
      onProgress: progress => {
        progressCalls.push(progress.phase);
      },
    });

    // 应至少有 running 和 completed 两个进度回调
    expect(progressCalls).toContain('running');
    expect(progressCalls).toContain('completed');
  });
});
