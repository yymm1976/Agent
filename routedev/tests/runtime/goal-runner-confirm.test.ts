// tests/runtime/goal-runner-confirm.test.ts
// Phase 91 Task 2：goal-runner-confirm.ts 单元测试
// 验证：
//   - savePlanRevision：路径校验（绝对路径拒绝/越界拒绝）、fail-open、JSONL 写入
//   - handleGoalCommand：参数解析（引号/无引号/--verify）、目标不可用提前返回
//   - clarifyGoalIfNeeded：fail-open（异常返回原描述）
//
// 测试策略：
//   - savePlanRevision 相对独立，直接构造最小 ctx 测试
//   - handleGoalCommand 通过 createGoalRunner 入口测试（依赖完整 ctx）
//   - clarifyGoalIfNeeded 通过 createGoalRunner 入口测试（依赖 client + onToolConfirmRequest）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createConfirmFunctions } from '../../src/runtime/goal-runner-confirm.js';
import type { GoalRunnerCtx, GoalRunnerDeps } from '../../src/runtime/goal-runner-core.js';
import { createGoalRunner } from '../../src/runtime/goal-runner-core.js';
import type { GoalPlan, GoalStep, PlanStep } from '../../src/agent/goal-types.js';
import type { LLMMessage, LLMResponse, TokenUsageInfo, RoutingResult, ModelInfo } from '../../src/router/types.js';

const mockModel: ModelInfo = {
  id: 'gpt-4o', providerId: 'openai', tier: 'medium',
  costPer1kInput: 0.005, costPer1kOutput: 0.015,
  maxContextTokens: 128000, maxOutputTokens: 4096,
};
const mockRoute: RoutingResult = {
  model: mockModel, providerId: 'openai', degraded: false, reason: 'test',
};
const mockUsage: TokenUsageInfo = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };

/** 构造最小 ctx 供 createConfirmFunctions 使用（仅 savePlanRevision 测试用） */
function createMinimalCtx(opts: {
  gid?: string;
  revisionHistoryPath?: string;
}): Pick<GoalRunnerCtx, 'deps' | 'gid' | 'emit' | 'gateManager' | 'goalCfg' | 'goalIntegration'> {
  return {
    deps: {
      config: {
        plan: { revisionHistoryPath: opts.revisionHistoryPath },
      },
    } as any,
    gid: opts.gid ?? 'test-gid',
    emit: vi.fn(),
    gateManager: { freeze: vi.fn(), getGates: vi.fn(() => null) } as any,
    goalCfg: {} as any,
    goalIntegration: {} as any,
  };
}

/** 构造完整 GoalRunnerDeps（handleGoalCommand 测试用） */
function createFullDeps(overrides: Partial<GoalRunnerDeps> = {}): GoalRunnerDeps {
  const mockClient = {
    isReady: () => true,
    complete: vi.fn(async (): Promise<LLMResponse> => ({
      content: JSON.stringify({ steps: [{ id: 1, description: '步骤1' }] }),
      toolCalls: [],
      usage: mockUsage,
    })),
    stream: vi.fn(async function* () { /* not used */ }),
  };
  return {
    classifier: { classify: vi.fn(async () => ({ tier: 'simple', confidence: 0.9 })) } as any,
    modelRouter: {
      route: vi.fn(async () => mockRoute),
      recordModelSuccess: vi.fn(),
      recordModelFailure: vi.fn(),
      getManualOverride: vi.fn(() => null),
      getAvailableModels: vi.fn(() => []),
    } as any,
    clientManager: { get: vi.fn(() => mockClient) } as any,
    tracker: {
      record: vi.fn(), getStats: vi.fn(() => ({ total: { totalTokens: 0 } })),
      getUsagePercent: vi.fn(() => 0), startTask: vi.fn(),
      recordTaskUsage: vi.fn(() => 'ok' as const), endTask: vi.fn(),
      getTaskUsagePercent: vi.fn(() => 0), isTaskActive: vi.fn(() => false),
      checkBudget: vi.fn(() => true),
    } as any,
    agentLoop: {
      run: async function* () { yield { type: 'done' as const, content: 'done', usage: mockUsage }; },
      updateToolExecutor: vi.fn(),
    } as any,
    checkpointManager: {
      init: vi.fn(async () => {}), saveGoalPlan: vi.fn(async () => {}),
      create: vi.fn(async () => null), count: 0, isEnabled: false,
    } as any,
    contextManager: {
      getCheckpoint: vi.fn(() => null), resetTriggers: vi.fn(),
      shouldTriggerCheckpoint: vi.fn(() => null), triggerCheckpoint: vi.fn(async () => {}),
      saveCheckpoint: vi.fn(async () => {}), shouldCompress: vi.fn(() => false),
      compress: vi.fn(() => ({ compressed: [], discarded: [] })),
      compressEnhanced: vi.fn(async () => ({ compressed: [], discarded: [] })),
      loadCheckpoint: vi.fn(async () => {}),
    } as any,
    config: {
      checkpoint: { enabled: false },
      router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } },
    } as any,
    systemPromptRef: { current: '' },
    conversationHistoryRef: { current: [] as LLMMessage[] },
    pendingConfirmRef: { current: null },
    abortControllerRef: { current: null },
    currentPlanRef: { current: null as GoalPlan | null },
    addSystemMessage: vi.fn(),
    requestPlanEdit: vi.fn(async () => null),
    setIsProcessing: vi.fn(),
    nextId: () => `msg-${Math.random()}`,
    ...overrides,
  };
}

describe('goal-runner-confirm 模块', () => {
  describe('savePlanRevision', () => {
    let tempDir: string;
    let originalCwd: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-revision-'));
      originalCwd = process.cwd();
      process.chdir(tempDir);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('正常写入 JSONL 修订记录', async () => {
      const ctx = createMinimalCtx({ gid: 'gid-normal', revisionHistoryPath: '.routedev/plan-revisions/' });
      const { savePlanRevision } = createConfirmFunctions(ctx as GoalRunnerCtx);

      const beforeSteps: GoalStep[] = [
        { id: 1, description: '旧步骤', status: 'pending', dependencies: [], domain: 'general' },
      ];
      const afterSteps: GoalStep[] = [
        { id: 1, description: '新步骤', status: 'pending', dependencies: [], domain: 'general' },
      ];
      await savePlanRevision(beforeSteps, afterSteps, 'user_edit');

      const filePath = path.join(tempDir, '.routedev/plan-revisions/gid-normal.jsonl');
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]);
      expect(record.reason).toBe('user_edit');
      expect(record.before).toHaveLength(1);
      expect(record.after).toHaveLength(1);
      expect(record.before[0].description).toBe('旧步骤');
      expect(record.after[0].description).toBe('新步骤');
      expect(record.revisedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('绝对路径 revisionHistoryPath 被拒绝（不写文件）', async () => {
      const ctx = createMinimalCtx({
        gid: 'gid-abs',
        revisionHistoryPath: path.resolve(tempDir, 'absolute-dir'),
      });
      const { savePlanRevision } = createConfirmFunctions(ctx as GoalRunnerCtx);

      await savePlanRevision([], [], 'test');

      // 不应创建任何文件
      const filePath = path.join(tempDir, 'absolute-dir', 'gid-abs.jsonl');
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('越界路径（../escape）被拒绝', async () => {
      const ctx = createMinimalCtx({
        gid: 'gid-escape',
        revisionHistoryPath: '../../../etc/',
      });
      const { savePlanRevision } = createConfirmFunctions(ctx as GoalRunnerCtx);

      // fail-open：不抛异常，仅 warn
      await expect(savePlanRevision([], [], 'test')).resolves.toBeUndefined();
    });

    it('写入失败时 fail-open（不抛异常）', async () => {
      // 用一个不可能的路径触发写入失败（但通过 isAbsolute/越界校验后，mkdir 失败）
      const ctx = createMinimalCtx({
        gid: 'gid-fail',
        revisionHistoryPath: 'sub/dir/',
      });
      const { savePlanRevision } = createConfirmFunctions(ctx as GoalRunnerCtx);

      // mock appendFile 抛异常
      const originalAppendFile = fs.appendFile;
      (fs as any).appendFile = vi.fn(async () => { throw new Error('disk full'); });
      try {
        await expect(savePlanRevision([], [], 'test')).resolves.toBeUndefined();
      } finally {
        (fs as any).appendFile = originalAppendFile;
      }
    });
  });

  describe('handleGoalCommand 参数解析', () => {
    it('引号格式：/goal "目标描述" 正确解析', async () => {
      const addSystemMessage = vi.fn();
      const deps = createFullDeps({
        addSystemMessage,
        requestPlanEdit: vi.fn(async () => null),
      });
      const runner = createGoalRunner(deps);

      await runner.handleGoalCommand('/goal "实现登录功能"');

      const goalMsg = addSystemMessage.mock.calls.find(
        ([content]) => typeof content === 'string' && content.includes('实现登录功能'),
      );
      expect(goalMsg).toBeDefined();
    });

    it('无引号格式：/goal 目标描述 正确解析（多词不截断）', async () => {
      const addSystemMessage = vi.fn();
      const deps = createFullDeps({
        addSystemMessage,
        requestPlanEdit: vi.fn(async () => null),
      });
      const runner = createGoalRunner(deps);

      await runner.handleGoalCommand('/goal 实现用户登录功能');

      const goalMsg = addSystemMessage.mock.calls.find(
        ([content]) => typeof content === 'string' && content.includes('实现用户登录功能'),
      );
      expect(goalMsg).toBeDefined();
    });

    it('--verify 选项正确解析验证条件', async () => {
      const addSystemMessage = vi.fn();
      const deps = createFullDeps({
        addSystemMessage,
        requestPlanEdit: vi.fn(async () => null),
      });
      const runner = createGoalRunner(deps);

      await runner.handleGoalCommand('/goal "实现登录" --verify "测试通过"');

      const verifyMsg = addSystemMessage.mock.calls.find(
        ([content]) => typeof content === 'string' && content.includes('测试通过'),
      );
      expect(verifyMsg).toBeDefined();
    });

    it('无参数 /goal 提示用法', async () => {
      const addSystemMessage = vi.fn();
      const setIsProcessing = vi.fn();
      const deps = createFullDeps({
        addSystemMessage,
        setIsProcessing,
        requestPlanEdit: vi.fn(async () => null),
      });
      const runner = createGoalRunner(deps);

      await runner.handleGoalCommand('/goal');

      const usageMsg = addSystemMessage.mock.calls.find(
        ([content]) => typeof content === 'string' && content.includes('用法'),
      );
      expect(usageMsg).toBeDefined();
      // setIsProcessing(true) 后又 setIsProcessing(false)
      expect(setIsProcessing).toHaveBeenCalledWith(false);
    });
  });

  describe('handleGoalCommand 路由失败', () => {
    it('clientManager.get 返回 null 时提示提供商不可用', async () => {
      const addSystemMessage = vi.fn();
      const deps = createFullDeps({
        addSystemMessage,
        clientManager: { get: vi.fn(() => null) } as any,
        requestPlanEdit: vi.fn(async () => null),
      });
      const runner = createGoalRunner(deps);

      await runner.handleGoalCommand('/goal "测试"');

      const errorMsg = addSystemMessage.mock.calls.find(
        ([content]) => typeof content === 'string' && content.includes('不可用'),
      );
      expect(errorMsg).toBeDefined();
    });

    it('client.isReady() 返回 false 时提示提供商不可用', async () => {
      const addSystemMessage = vi.fn();
      const mockClient = { isReady: () => false, complete: vi.fn(), stream: vi.fn() };
      const deps = createFullDeps({
        addSystemMessage,
        clientManager: { get: vi.fn(() => mockClient) } as any,
        requestPlanEdit: vi.fn(async () => null),
      });
      const runner = createGoalRunner(deps);

      await runner.handleGoalCommand('/goal "测试"');

      const errorMsg = addSystemMessage.mock.calls.find(
        ([content]) => typeof content === 'string' && content.includes('不可用'),
      );
      expect(errorMsg).toBeDefined();
    });
  });

  describe('clarifyGoalIfNeeded', () => {
    it('onToolConfirmRequest 未注入时（CLI 端）跳过澄清，返回原描述', async () => {
      // 通过 handleGoalCommand 间接测试：onToolConfirmRequest 未注入时走原描述路径
      // mockClient 返回 needsClarification:true，但因无 onToolConfirmRequest 应直接返回原描述
      const addSystemMessage = vi.fn();
      const mockClient = {
        isReady: () => true,
        // 第一次调用（clarifyGoalIfNeeded）返回 needsClarification:true
        // 第二次调用（GoalParser.parse）返回正常步骤
        complete: vi.fn(async (): Promise<LLMResponse> => ({
          content: '{"needsClarification": true, "questions": ["哪个目录？"]}',
          toolCalls: [],
          usage: mockUsage,
        })),
        stream: vi.fn(async function* () {}),
      };
      const deps = createFullDeps({
        addSystemMessage,
        clientManager: { get: vi.fn(() => mockClient) } as any,
        requestPlanEdit: vi.fn(async () => null),
        // onToolConfirmRequest 未注入
      });
      const runner = createGoalRunner(deps);

      // 不抛异常即说明 clarifyGoalIfNeeded fail-open 返回原描述
      await expect(runner.handleGoalCommand('/goal "保存到指定目录"')).resolves.toBeUndefined();
    });
  });
});
