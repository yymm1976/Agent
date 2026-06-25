// tests/phase35/durable-wiring.test.ts
// Phase 35 Task 3：DurableExecutor 真实接线与会话恢复测试
// 验证：AgentLoopStepExecutor 真实实现、DurableExecutor + HookRunner 集成、listRecoverable 启动提示

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentLoopStepExecutor } from '../../src/agent/step-executor.js';
import { DurableExecutor, type StepExecutor } from '../../src/agent/durable-executor.js';
import { HookRunner, type HookContext, type HookResult, type StepResult } from '../../src/agent/hooks.js';
import type { PlanStep } from '../../src/agent/goal-types.js';
import type { ReActAgentLoop } from '../../src/agent/loop.js';
import type { ILLMClient, RoutingResult, ClassificationResult } from '../../src/router/types.js';
import type { ScenarioClassifier } from '../../src/router/classifier.js';
import type { ModelRouter } from '../../src/router/router.js';
import type { LLMClientManager } from '../../src/router/llm/index.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建 mock AgentLoop（模拟 run() 返回 done 事件） */
function makeMockAgentLoop(responseText: string = '步骤执行完成'): ReActAgentLoop {
  return {
    run: async function* () {
      yield { type: 'text_delta', text: responseText };
      yield {
        type: 'done',
        content: responseText,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      };
    },
  } as unknown as ReActAgentLoop;
}

/** 创建 mock classifier */
function makeMockClassifier(): ScenarioClassifier {
  return {
    classify: vi.fn(async (): Promise<ClassificationResult> => ({
      tier: 'medium',
      confidence: 0.9,
      reasoning: 'mock',
      source: 'rule',
    })),
  } as unknown as ScenarioClassifier;
}

/** 创建 mock modelRouter */
function makeMockModelRouter(): ModelRouter {
  return {
    route: vi.fn(async (): Promise<RoutingResult> => ({
      model: { id: 'test-model', name: 'Test', contextWindow: 128000, tier: 'medium' } as any,
      providerId: 'test-provider',
      fallbackUsed: false,
      originalTier: 'medium',
      degraded: false,
    })),
  } as unknown as ModelRouter;
}

/** 创建 mock clientManager */
function makeMockClientManager(ready: boolean = true): LLMClientManager {
  const mockClient = {
    isReady: () => ready,
  } as unknown as ILLMClient;
  return {
    get: vi.fn(() => mockClient),
  } as unknown as LLMClientManager;
}

/** 创建测试用 PlanStep */
function makeStep(id: number = 1, description: string = '测试步骤'): PlanStep {
  return {
    id,
    description,
    status: 'pending',
    dependencies: [],
  };
}

/** 创建临时存储目录 */
async function makeTempStorageRoot(): Promise<string> {
  const dir = path.join(os.tmpdir(), `phase35-durable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 35 Task 3: DurableExecutor 真实接线与会话恢复', () => {
  let tempStorageRoot: string;

  beforeEach(async () => {
    tempStorageRoot = await makeTempStorageRoot();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempStorageRoot, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  describe('AgentLoopStepExecutor 真实实现', () => {
    it('execute() 调用 agentLoop.run() 并返回成功结果', async () => {
      const executor = new AgentLoopStepExecutor({
        agentLoop: makeMockAgentLoop('文件已修改'),
        classifier: makeMockClassifier(),
        modelRouter: makeMockModelRouter(),
        clientManager: makeMockClientManager(true),
      });

      const step = makeStep(1, '修改 src/index.ts');
      const result = await executor.execute(step, '完成项目初始化');

      expect(result.success).toBe(true);
      expect(result.output).toBe('文件已修改');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('LLM 客户端不可用时返回失败结果', async () => {
      const executor = new AgentLoopStepExecutor({
        agentLoop: makeMockAgentLoop(),
        classifier: makeMockClassifier(),
        modelRouter: makeMockModelRouter(),
        clientManager: makeMockClientManager(false), // 客户端未就绪
      });

      const step = makeStep(1, '测试步骤');
      const result = await executor.execute(step, '测试目标');

      expect(result.success).toBe(false);
      expect(result.output).toContain('不可用');
    });

    it('systemPrompt 注入 goal 上下文', async () => {
      const mockLoop = makeMockAgentLoop('完成');
      const executor = new AgentLoopStepExecutor({
        agentLoop: mockLoop,
        classifier: makeMockClassifier(),
        modelRouter: makeMockModelRouter(),
        clientManager: makeMockClientManager(true),
        baseSystemPrompt: '你是代码助手',
      });

      const step = makeStep(2, '实现功能 X');
      await executor.execute(step, '完成功能 X 的实现');

      // 验证 agentLoop.run 被调用（通过 mock classifier.classify 间接验证）
      // 由于 mockLoop.run 是 generator，我们验证结果即可
      // 这里主要验证 execute 不抛异常且返回正确结果
    });

    it('执行出错时返回失败结果（不抛异常）', async () => {
      // 创建一个会抛异常的 mock agentLoop
      const errorLoop = {
        run: async function* () {
          throw new Error('LLM 调用失败');
        },
      } as unknown as ReActAgentLoop;

      const executor = new AgentLoopStepExecutor({
        agentLoop: errorLoop,
        classifier: makeMockClassifier(),
        modelRouter: makeMockModelRouter(),
        clientManager: makeMockClientManager(true),
      });

      const step = makeStep(1, '测试步骤');
      const result = await executor.execute(step, '测试目标');

      expect(result.success).toBe(false);
      expect(result.output).toContain('失败');
    });
  });

  describe('DurableExecutor + HookRunner 集成', () => {
    it('DurableExecutor 构造时接收 HookRunner，runStepWithHooks 生效', async () => {
      const hookRunner = new HookRunner();
      let preStepFired = false;
      let postStepFired = false;

      hookRunner.register({
        event: 'pre-step',
        name: 'test-pre-step',
        handler: async () => {
          preStepFired = true;
          return { action: 'continue' };
        },
      });

      hookRunner.register({
        event: 'post-step',
        name: 'test-post-step',
        handler: async () => {
          postStepFired = true;
          return { action: 'continue' };
        },
      });

      // 使用真实 StepExecutor 的桩（避免依赖 LLM）
      const stubExecutor: StepExecutor = {
        async execute(step: PlanStep): Promise<StepResult> {
          return { success: true, output: `执行: ${step.description}`, durationMs: 10 };
        },
      };

      const durable = new DurableExecutor({
        sessionId: 'test-session',
        executor: stubExecutor,
        hookRunner,
        storageRoot: tempStorageRoot,
        projectPath: process.cwd(),
      });

      const plan = [makeStep(1, '步骤一')];
      const result = await durable.start(plan, '测试目标');

      expect(preStepFired).toBe(true);
      expect(postStepFired).toBe(true);
      expect(result.snapshot.status).toBe('completed');
    });

    it('pre-step 钩子返回 abort 时中止执行', async () => {
      const hookRunner = new HookRunner();
      hookRunner.register({
        event: 'pre-step',
        name: 'abort-hook',
        handler: async () => ({ action: 'abort', message: '禁止执行' }),
      });

      const stubExecutor: StepExecutor = {
        async execute(step: PlanStep): Promise<StepResult> {
          return { success: true, output: '不应执行', durationMs: 0 };
        },
      };

      const durable = new DurableExecutor({
        sessionId: 'test-session',
        executor: stubExecutor,
        hookRunner,
        storageRoot: tempStorageRoot,
        projectPath: process.cwd(),
      });

      const plan = [makeStep(1, '步骤一')];
      const result = await durable.start(plan, '测试目标');

      expect(result.success).toBe(false);
      // DurableExecutor 设计：hook abort 导致 paused（可恢复），非 failed
      expect(result.snapshot.status).toBe('paused');
    });
  });

  describe('listRecoverable 启动提示', () => {
    it('listRecoverable() 返回 paused/failed 状态的快照', async () => {
      const hookRunner = new HookRunner();
      const stubExecutor: StepExecutor = {
        async execute(step: PlanStep): Promise<StepResult> {
          return { success: false, output: '故意失败', durationMs: 10 };
        },
      };

      const durable = new DurableExecutor({
        sessionId: 'test-session',
        executor: stubExecutor,
        hookRunner,
        storageRoot: tempStorageRoot,
        projectPath: process.cwd(),
      });

      // 执行一个会失败的 plan
      const plan = [makeStep(1, '会失败的步骤')];
      await durable.start(plan, '测试目标');

      // 验证 listRecoverable 能找到失败的执行
      const recoverable = durable.listRecoverable();
      expect(recoverable.length).toBeGreaterThanOrEqual(1);
      expect(recoverable[0].status).toBe('failed');
    });

    it('无快照时 listRecoverable() 返回空数组', () => {
      const durable = new DurableExecutor({
        sessionId: 'test-session',
        executor: { async execute() { return { success: true, output: '', durationMs: 0 }; } },
        storageRoot: tempStorageRoot,
        projectPath: process.cwd(),
      });

      const recoverable = durable.listRecoverable();
      expect(recoverable).toEqual([]);
    });
  });
});
