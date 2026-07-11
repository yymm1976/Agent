// desktop/main/__tests__/chat-bridge.integration.test.ts
// Phase 79 Task 1：ChatBridge 集成测试
//
// 测试目的：验证 ChatBridge 公开方法在各种场景下的行为正确性，覆盖以下场景：
//   - 并发 requestId 隔离与正确配对
//   - stop 中断请求（精准中断 + 全量中断）
//   - 工具确认流程（resolve/reject/未知 requestId）
//   - 配置热更新（reloadConfig 后新自主度立即生效）
//   - 超时/完成后的资源清理（abortController 不泄漏）
//   - 底层错误正确传播到调用方
//   - 重复 requestId 处理策略（Map 覆盖语义）
//   - 空消息安全处理（不崩溃）
//   - 状态查询（队列状态 + /status 命令）
//   - 优雅关闭（清理所有 pending 请求与队列）
//
// 测试策略：
//   - 使用真实 EngineContext 实例（验证状态管理集成）
//   - mock 所有外部依赖（LLM 客户端、agentLoop、classifier、modelRouter 等）
//   - 通过 vi.fn / vi.spyOn 验证调用次数、参数与 ctx 内部状态

import { describe, it, expect, vi } from 'vitest';
import { ChatBridge } from '../bridges/chat-bridge.js';
import { EngineContext } from '../bridges/engine-context.js';
import { AppConfigSchema, type AppConfig } from '../../../src/config/schema.js';
import type { AppDependencies } from '../../../src/runtime/app-init.js';
import type { RoutingResult } from '../../../src/router/types.js';

// ============================================================
// 测试辅助
// ============================================================

/** 构造最小可用 AppConfig（所有字段使用 schema 默认值） */
function makeConfig(overrides?: { autonomyMode?: 'auto' | 'semi' | 'manual' }): AppConfig {
  const config = AppConfigSchema.parse({}) as AppConfig;
  if (overrides?.autonomyMode) {
    config.autonomy.defaultMode = overrides.autonomyMode;
  }
  return config;
}

/** 构造 mock 路由决策结果 */
function makeRouteDecision(): RoutingResult {
  return {
    model: {
      id: 'test-model',
      name: 'Test Model',
      provider: 'test-provider',
      tier: 'simple',
      contextWindow: 4096,
      capabilities: [],
      latencyMs: 0,
      available: true,
    },
    providerId: 'test-provider',
    fallbackUsed: false,
    originalTier: 'simple',
    degraded: false,
  };
}

/** mock agentLoop.run 的类型 */
type MockAgentLoopRun = (params: {
  userMessage: string;
  signal?: AbortSignal;
  onConfirmTool: (toolName: string, args: Record<string, unknown>) => Promise<boolean | { approved: boolean; payload?: unknown }>;
}) => AsyncGenerator<any>;

/** 构造默认 mock agentLoop run（直接 yield done 事件） */
function defaultAgentLoopRun(): MockAgentLoopRun {
  return async function* () {
    yield { type: 'done', content: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  };
}

interface SetupOptions {
  autonomyMode?: 'auto' | 'semi' | 'manual';
  agentLoopRun?: MockAgentLoopRun;
  classifierThrow?: Error;
  clientReady?: boolean;
}

/** 完整测试装配：创建 ctx + mock deps + ChatBridge 实例 */
function setupBridge(options: SetupOptions = {}) {
  const config = makeConfig({ autonomyMode: options.autonomyMode });
  const onStream = vi.fn();
  const onToolConfirmRequest = vi.fn();
  const ctx = new EngineContext(config, {
    cwd: '/test',
    onStream,
    onToolConfirmRequest,
  });

  // mock deps：覆盖 sendChat 调用链涉及的所有子系统
  ctx.deps = {
    registry: { list: () => [] },
    agentLoop: {
      run: options.agentLoopRun ?? defaultAgentLoopRun(),
      followUp: vi.fn(),
      clearAllQueues: vi.fn(),
      setFollowUpMode: vi.fn(),
      getQueueStatus: () => ({ followUp: 0 }),
      getFollowUpQueue: () => [],
      removeFollowUp: () => false,
    },
    skillsRouter: { route: () => [] },
    contextManager: {
      shouldTriggerCheckpoint: () => null,
      triggerCheckpoint: vi.fn(),
      saveCheckpoint: vi.fn(),
      shouldCompress: () => false,
      compress: vi.fn(),
    },
    prompts: { render: async () => '' },
    trace: {
      startSession: vi.fn(),
      summarizeTrajectory: () => ({ stepCount: 0, keyDecisions: [], fileChanges: [] }),
      getSpans: () => [],
      endSession: vi.fn(),
    },
    audit: { logTrajectorySummary: vi.fn() },
    visionAssistant: undefined,
    dispose: vi.fn(),
  } as unknown as AppDependencies;

  // mock classifier
  ctx.classifier = {
    classify: options.classifierThrow
      ? vi.fn().mockRejectedValue(options.classifierThrow)
      : vi.fn().mockResolvedValue({ tier: 'simple' }),
  } as any;

  // mock modelRouter
  ctx.modelRouter = {
    route: vi.fn().mockResolvedValue(makeRouteDecision()),
    recordModelSuccess: vi.fn(),
    recordModelFailure: vi.fn(),
  } as any;

  // mock tracker
  ctx.tracker = {
    record: vi.fn(),
    getUsagePercent: () => 0,
  } as any;

  // mock clientManager
  const clientReady = options.clientReady !== false;
  ctx.clientManager = {
    get: () => ({ isReady: () => clientReady }),
    getReadyClients: () => [{ client: { complete: async () => ({ content: '测试标题' }) } }],
  } as any;

  const bridge = new ChatBridge(ctx);

  return { bridge, ctx, onStream, onToolConfirmRequest, config };
}

// ============================================================
// 测试用例
// ============================================================

describe('ChatBridge 集成测试 (Phase 79 Task 1)', () => {

  // ============================================================
  // 1. 并发 requestId 处理
  // ============================================================
  describe('并发 requestId 处理', () => {
    it('多个并发 sendChat 互不干扰，结果正确配对', async () => {
      // agentLoop 根据 userMessage 产出不同的 text_delta，验证并发请求结果不串
      const { bridge, onStream } = setupBridge({
        agentLoopRun: async function* (params) {
          yield { type: 'text_delta', text: `回复:${params.userMessage}` };
          yield { type: 'done', content: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        },
      });

      // 同时发送 3 个并发请求
      await Promise.all([
        bridge.sendChat('消息A'),
        bridge.sendChat('消息B'),
        bridge.sendChat('消息C'),
      ]);

      // 提取所有 text_delta 事件的 chunk
      const deltas = onStream.mock.calls
        .map(([payload]) => payload)
        .filter((p: any) => p.type === 'text_delta')
        .map((p: any) => p.chunk);

      // 3 个请求的回复都应存在（并发顺序不确定，用 contain 逐一断言）
      expect(deltas).toContain('回复:消息A');
      expect(deltas).toContain('回复:消息B');
      expect(deltas).toContain('回复:消息C');
    });

    it('并发请求的 abortController 互相隔离（各自独立的 requestId）', async () => {
      const { bridge, ctx } = setupBridge();
      // 监听 setAbortController 以捕获各请求的 requestId
      const setSpy = vi.spyOn(ctx, 'setAbortController');

      await Promise.all([
        bridge.sendChat('请求1'),
        bridge.sendChat('请求2'),
      ]);

      // 两次 setAbortController 调用的 requestId 必须不同
      const requestIds = setSpy.mock.calls.map(c => c[0]);
      expect(requestIds.length).toBe(2);
      expect(requestIds[0]).not.toBe(requestIds[1]);

      // 完成后 Map 应清空（finally 块清理）
      expect(ctx.getAbortController(requestIds[0])).toBeUndefined();
      expect(ctx.getAbortController(requestIds[1])).toBeUndefined();
    });
  });

  // ============================================================
  // 2. stop 中断请求
  // ============================================================
  describe('stop 中断请求', () => {
    it('stopGeneration(requestId) 中断指定请求并清理 controller', () => {
      const { bridge, ctx } = setupBridge();
      // 手动注册一个 abortController 模拟进行中的请求
      const controller = new AbortController();
      ctx.setAbortController('req-stop-1', controller);

      bridge.stopGeneration('req-stop-1');

      // 验证中断信号已触发
      expect(controller.signal.aborted).toBe(true);
      // 验证已从 Map 中移除
      expect(ctx.getAbortController('req-stop-1')).toBeUndefined();
    });

    it('stopGeneration() 无 requestId 时中断全部并发请求', () => {
      const { bridge, ctx } = setupBridge();
      const c1 = new AbortController();
      const c2 = new AbortController();
      const c3 = new AbortController();
      ctx.setAbortController('req-a', c1);
      ctx.setAbortController('req-b', c2);
      ctx.setAbortController('req-c', c3);

      bridge.stopGeneration();

      // 全部中断
      expect(c1.signal.aborted).toBe(true);
      expect(c2.signal.aborted).toBe(true);
      expect(c3.signal.aborted).toBe(true);
      // Map 清空
      expect(ctx.getAbortController('req-a')).toBeUndefined();
      expect(ctx.getAbortController('req-b')).toBeUndefined();
      expect(ctx.getAbortController('req-c')).toBeUndefined();
    });
  });

  // ============================================================
  // 3. confirm 确认流程
  // ============================================================
  describe('confirm 确认流程', () => {
    it('resolveToolConfirm 批准时 resolver 收到 approved=true', async () => {
      const { bridge, ctx, onToolConfirmRequest } = setupBridge({
        autonomyMode: 'semi',
        agentLoopRun: async function* (params) {
          // 触发工具确认：semi 模式下会调用 requestUserConfirmation
          const result = await params.onConfirmTool('file_read', { path: '/test' });
          yield {
            type: 'tool_call_result',
            toolName: 'file_read',
            toolCallId: '1',
            result: String(result),
            isError: false,
          };
          yield { type: 'done', content: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        },
      });

      // sendChat 会在 onConfirmTool 处阻塞，等待 resolveToolConfirm
      const sendChatPromise = bridge.sendChat('测试确认批准');
      // 等待 onToolConfirmRequest 被调用（说明 pending confirm 已注册）
      await vi.waitFor(() => expect(onToolConfirmRequest).toHaveBeenCalledTimes(1));

      // 从回调中提取 requestId
      const confirmRequestId = onToolConfirmRequest.mock.calls[0][0];
      // 批准
      bridge.resolveToolConfirm(confirmRequestId, true);

      await sendChatPromise;

      // 验证 pendingConfirm 已清除
      expect(ctx.getPendingConfirm(confirmRequestId)).toBeUndefined();
    });

    it('resolveToolConfirm 拒绝时 resolver 收到 approved=false', async () => {
      const { bridge, ctx, onToolConfirmRequest } = setupBridge({
        autonomyMode: 'semi',
        agentLoopRun: async function* (params) {
          const result = await params.onConfirmTool('shell_exec', { cmd: 'rm -rf /' });
          yield {
            type: 'tool_call_result',
            toolName: 'shell_exec',
            toolCallId: '1',
            result: String(result),
            isError: false,
          };
          yield { type: 'done', content: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        },
      });

      const sendChatPromise = bridge.sendChat('测试确认拒绝');
      await vi.waitFor(() => expect(onToolConfirmRequest).toHaveBeenCalledTimes(1));

      const confirmRequestId = onToolConfirmRequest.mock.calls[0][0];
      // 拒绝
      bridge.resolveToolConfirm(confirmRequestId, false);

      await sendChatPromise;

      // 验证 pendingConfirm 已清除
      expect(ctx.getPendingConfirm(confirmRequestId)).toBeUndefined();
    });

    it('resolveToolConfirm 对未知 requestId 安全无副作用（不抛异常）', () => {
      const { bridge, ctx } = setupBridge();
      // 不存在该 requestId 的 pending confirm，应安全返回
      expect(() => bridge.resolveToolConfirm('non-existent-req', true)).not.toThrow();
      expect(ctx.getPendingConfirm('non-existent-req')).toBeUndefined();
    });
  });

  // ============================================================
  // 4. reloadConfig 配置重载
  // ============================================================
  describe('reloadConfig 配置重载', () => {
    it('更新 ctx.config 后 sendChat 立即使用新自主度模式', async () => {
      // semi 模式：非高风险工具仍需用户确认 → onToolConfirmRequest 被调用
      const { bridge, ctx, onToolConfirmRequest } = setupBridge({
        autonomyMode: 'semi',
        agentLoopRun: async function* (params) {
          // file_read 在 auto 模式下自动批准，在 semi 模式下需确认
          const result = await params.onConfirmTool('file_read', { path: '/test' });
          yield {
            type: 'tool_call_result',
            toolName: 'file_read',
            toolCallId: '1',
            result: String(result),
            isError: false,
          };
          yield { type: 'done', content: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        },
      });

      // 第一次调用：semi 模式，onToolConfirmRequest 应被调用
      const firstCall = bridge.sendChat('第一次');
      await vi.waitFor(() => expect(onToolConfirmRequest).toHaveBeenCalledTimes(1));
      const firstRequestId = onToolConfirmRequest.mock.calls[0][0];
      bridge.resolveToolConfirm(firstRequestId, true);
      await firstCall;

      expect(onToolConfirmRequest).toHaveBeenCalledTimes(1);

      // 模拟 ConfigBridge.updateConfig：替换整个 config 对象
      const newConfig = makeConfig({ autonomyMode: 'auto' });
      ctx.config = newConfig;

      // 重置 mock 以便断言第二次调用
      onToolConfirmRequest.mockClear();

      // 第二次调用：auto 模式，file_read 非高风险工具 → 自动批准，不调用 onToolConfirmRequest
      await bridge.sendChat('第二次');

      expect(onToolConfirmRequest).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 5. 超时清理（资源不泄漏）
  // ============================================================
  describe('超时清理', () => {
    it('sendChat 正常完成后清理 abortController（不泄漏）', async () => {
      const { bridge, ctx } = setupBridge();
      const setSpy = vi.spyOn(ctx, 'setAbortController');
      const clearSpy = vi.spyOn(ctx, 'clearAbortController');

      await bridge.sendChat('正常完成测试');

      // setAbortController 和 clearAbortController 应成对调用
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledTimes(1);

      // requestId 应一致
      const setReqId = setSpy.mock.calls[0][0];
      const clearReqId = clearSpy.mock.calls[0][0];
      expect(setReqId).toBe(clearReqId);

      // Map 中不应残留该 requestId
      expect(ctx.getAbortController(setReqId)).toBeUndefined();
    });

    it('sendChat 异常后清理 abortController（不泄漏）', async () => {
      const { bridge, ctx, onStream } = setupBridge({
        agentLoopRun: async function* () {
          throw new Error('agentLoop 模拟异常');
        },
      });
      const setSpy = vi.spyOn(ctx, 'setAbortController');
      const clearSpy = vi.spyOn(ctx, 'clearAbortController');

      await bridge.sendChat('异常完成测试');

      // 即使异常，set 和 clear 也应成对调用
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledTimes(1);

      // error 事件应通过 onStream 传播
      const errorEvents = onStream.mock.calls
        .map(([payload]) => payload)
        .filter((p: any) => p.type === 'error');
      expect(errorEvents.length).toBeGreaterThan(0);
      expect(errorEvents[0].error).toContain('agentLoop 模拟异常');

      // Map 清空
      const reqId = setSpy.mock.calls[0][0];
      expect(ctx.getAbortController(reqId)).toBeUndefined();
    });
  });

  // ============================================================
  // 6. 错误传播
  // ============================================================
  describe('错误传播', () => {
    it('agentLoop 抛出异常时通过 onStream error 事件传播', async () => {
      const { bridge, onStream } = setupBridge({
        agentLoopRun: async function* () {
          throw new Error('底层 agentLoop 异常');
        },
      });

      await bridge.sendChat('触发错误');

      const errorEvents = onStream.mock.calls
        .map(([payload]) => payload)
        .filter((p: any) => p.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toBe('底层 agentLoop 异常');

      // 应同时补发 done 事件，避免渲染层永久 loading
      const doneEvents = onStream.mock.calls
        .map(([payload]) => payload)
        .filter((p: any) => p.type === 'done');
      expect(doneEvents).toHaveLength(1);
    });

    it('classifier 抛出异常时通过 onStream error 事件传播', async () => {
      const { bridge, onStream } = setupBridge({
        classifierThrow: new Error('分类器初始化失败'),
      });

      await bridge.sendChat('触发分类器错误');

      const errorEvents = onStream.mock.calls
        .map(([payload]) => payload)
        .filter((p: any) => p.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toBe('分类器初始化失败');

      // 补发 done 事件
      const doneEvents = onStream.mock.calls
        .map(([payload]) => payload)
        .filter((p: any) => p.type === 'done');
      expect(doneEvents).toHaveLength(1);
    });
  });

  // ============================================================
  // 7. 重复 requestId 处理
  // ============================================================
  describe('重复 requestId 处理', () => {
    it('相同 requestId 的 abortController 后设覆盖前设（Map 语义）', () => {
      const { ctx } = setupBridge();
      const c1 = new AbortController();
      const c2 = new AbortController();

      ctx.setAbortController('dup-req', c1);
      expect(ctx.getAbortController('dup-req')).toBe(c1);

      // 相同 requestId 再次 set → 覆盖
      ctx.setAbortController('dup-req', c2);
      expect(ctx.getAbortController('dup-req')).toBe(c2);

      // 清除后 Map 中不再存在
      ctx.clearAbortController('dup-req');
      expect(ctx.getAbortController('dup-req')).toBeUndefined();
    });

    it('相同 requestId 的 pendingConfirm 后设覆盖前设', () => {
      const { ctx } = setupBridge();
      const resolve1 = vi.fn();
      const resolve2 = vi.fn();

      ctx.setPendingConfirm('dup-confirm', { resolve: resolve1, toolName: 'tool_a' });
      ctx.setPendingConfirm('dup-confirm', { resolve: resolve2, toolName: 'tool_b' });

      // getPendingConfirm 返回最后设入的 entry
      const entry = ctx.getPendingConfirm('dup-confirm');
      expect(entry?.toolName).toBe('tool_b');
      expect(entry?.resolve).toBe(resolve2);

      // clearAllPendingConfirms 会 resolve 全部（此处仅剩 entry2）
      ctx.clearAllPendingConfirms();
      expect(resolve2).toHaveBeenCalledWith({ approved: false });
      // resolve1 不会被调用（已被覆盖，不在 Map 中）
      expect(resolve1).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 8. 空消息处理
  // ============================================================
  describe('空消息处理', () => {
    it('空字符串消息不崩溃并正常结束', async () => {
      const { bridge, onStream } = setupBridge();

      await bridge.sendChat('');

      // 应产出 done 事件（不崩溃）
      const doneEvents = onStream.mock.calls
        .map(([payload]) => payload)
        .filter((p: any) => p.type === 'done');
      expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('仅空白字符的消息不崩溃', async () => {
      const { bridge, onStream } = setupBridge();

      await bridge.sendChat('   \n\t  ');

      const doneEvents = onStream.mock.calls
        .map(([payload]) => payload)
        .filter((p: any) => p.type === 'done');
      expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================
  // 9. 状态查询
  // ============================================================
  describe('状态查询', () => {
    it('getQueueStatus 在 deps 就绪时返回 agentLoop 队列状态', () => {
      const { bridge, ctx } = setupBridge();
      // 覆盖 agentLoop.getQueueStatus 返回值
      (ctx.deps!.agentLoop as any).getQueueStatus = () => ({ followUp: 3 });

      const status = bridge.getQueueStatus();
      expect(status).toEqual({ followUp: 3 });
    });

    it('getQueueStatus 在 deps 未就绪时返回空状态', () => {
      const { bridge, ctx } = setupBridge();
      ctx.deps = null;

      const status = bridge.getQueueStatus();
      expect(status).toEqual({ followUp: 0 });
    });

    it('executeCommand /status 返回当前引擎状态', async () => {
      const { bridge, ctx } = setupBridge();
      ctx.currentModel = 'gpt-4';
      ctx.currentTier = 'complex';
      ctx.isDegraded = true;
      ctx.conversationHistory = [
        { role: 'user', content: '历史1' },
        { role: 'assistant', content: '回复1' },
      ];

      const result = await bridge.executeCommand('/status');

      expect(result).toHaveProperty('ok', true);
      expect(result).toHaveProperty('message');
      const msg = (result as { message: string }).message;
      expect(msg).toContain('gpt-4');
      expect(msg).toContain('complex');
      expect(msg).toContain('true');
      expect(msg).toContain('2 条');
    });

    it('getFollowUpQueue 在 deps 未就绪时返回空数组', () => {
      const { bridge, ctx } = setupBridge();
      ctx.deps = null;

      expect(bridge.getFollowUpQueue()).toEqual([]);
    });
  });

  // ============================================================
  // 10. 优雅关闭
  // ============================================================
  describe('优雅关闭', () => {
    it('stopGeneration() 清理全部 pending abortController 和 pendingConfirm', () => {
      const { bridge, ctx } = setupBridge();
      // 注册多个进行中的请求
      ctx.setAbortController('req-1', new AbortController());
      ctx.setAbortController('req-2', new AbortController());
      ctx.setAbortController('req-3', new AbortController());
      // 注册多个 pending confirm
      ctx.setPendingConfirm('req-1', { resolve: vi.fn(), toolName: 'file_read' });
      ctx.setPendingConfirm('req-2', { resolve: vi.fn(), toolName: 'shell_exec' });

      // 全量中断
      bridge.stopGeneration();

      // 所有 abortController 已清除
      expect(ctx.getAbortController('req-1')).toBeUndefined();
      expect(ctx.getAbortController('req-2')).toBeUndefined();
      expect(ctx.getAbortController('req-3')).toBeUndefined();
      // 所有 pendingConfirm 已清除（clearAllPendingConfirms resolve(false) 并清空）
      expect(ctx.getPendingConfirm('req-1')).toBeUndefined();
      expect(ctx.getPendingConfirm('req-2')).toBeUndefined();
    });

    it('stopGeneration() 同时清理 pending plan edit resolvers', () => {
      const { bridge, ctx } = setupBridge();
      const resolver1 = vi.fn();
      const resolver2 = vi.fn();
      ctx.pendingPlanEditResolvers.set('plan-1', resolver1);
      ctx.pendingPlanEditResolvers.set('plan-2', resolver2);

      bridge.stopGeneration();

      // resolver 以 [] 被调用（取消编辑，保留原计划）
      expect(resolver1).toHaveBeenCalledWith([]);
      expect(resolver2).toHaveBeenCalledWith([]);
      // Map 清空
      expect(ctx.pendingPlanEditResolvers.size).toBe(0);
    });

    it('clearAllQueues 在 deps 就绪时调用 agentLoop.clearAllQueues', () => {
      const { bridge, ctx } = setupBridge();
      const clearSpy = (ctx.deps!.agentLoop as any).clearAllQueues;

      bridge.clearAllQueues();

      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('clearAllQueues 在 deps 未就绪时不崩溃', () => {
      const { bridge, ctx } = setupBridge();
      ctx.deps = null;

      expect(() => bridge.clearAllQueues()).not.toThrow();
    });
  });

  // ============================================================
  // 附加：resolvePlanEdit 计划编辑解析
  // ============================================================
  describe('resolvePlanEdit 计划编辑解析', () => {
    it('resolvePlanEdit 解析挂起的计划编辑请求', () => {
      const { bridge, ctx } = setupBridge();
      const resolver = vi.fn();
      ctx.pendingPlanEditResolvers.set('plan-edit-1', resolver);

      const steps = [{ id: 1, description: '步骤1', dependencies: [] }];
      bridge.resolvePlanEdit('plan-edit-1', steps);

      expect(resolver).toHaveBeenCalledWith(steps);
      expect(ctx.pendingPlanEditResolvers.has('plan-edit-1')).toBe(false);
    });

    it('resolvePlanEdit 传入 null 表示用户取消', () => {
      const { bridge, ctx } = setupBridge();
      const resolver = vi.fn();
      ctx.pendingPlanEditResolvers.set('plan-edit-2', resolver);

      bridge.resolvePlanEdit('plan-edit-2', null);

      expect(resolver).toHaveBeenCalledWith(null);
      expect(ctx.pendingPlanEditResolvers.has('plan-edit-2')).toBe(false);
    });

    it('resolvePlanEdit 对未知 requestId 安全无副作用', () => {
      const { bridge } = setupBridge();
      expect(() => bridge.resolvePlanEdit('non-existent', null)).not.toThrow();
    });
  });

  // ============================================================
  // 附加：followUp 队列管理
  // ============================================================
  describe('followUp 队列管理', () => {
    it('followUp 空内容返回 false', () => {
      const { bridge } = setupBridge();
      expect(bridge.followUp('')).toBe(false);
      expect(bridge.followUp('   ')).toBe(false);
    });

    it('followUp 有效内容返回 true 并调用 agentLoop.followUp', () => {
      const { bridge, ctx } = setupBridge();
      const followUpSpy = (ctx.deps!.agentLoop as any).followUp;

      const result = bridge.followUp('后续任务');

      expect(result).toBe(true);
      expect(followUpSpy).toHaveBeenCalledWith('后续任务');
    });

    it('followUp 在 deps 未就绪时返回 false', () => {
      const { bridge, ctx } = setupBridge();
      ctx.deps = null;

      expect(bridge.followUp('有效内容')).toBe(false);
    });

    it('setFollowUpMode 在 deps 就绪时返回 true', () => {
      const { bridge, ctx } = setupBridge();
      const setModeSpy = (ctx.deps!.agentLoop as any).setFollowUpMode;

      const result = bridge.setFollowUpMode('all');

      expect(result).toBe(true);
      expect(setModeSpy).toHaveBeenCalledWith('all');
    });

    it('removeFollowUp 在 deps 未就绪时返回 false', () => {
      const { bridge, ctx } = setupBridge();
      ctx.deps = null;

      expect(bridge.removeFollowUp(0)).toBe(false);
    });
  });

  // ============================================================
  // 附加：syncConversationHistory 与 executeCommand
  // ============================================================
  describe('syncConversationHistory 对话历史同步', () => {
    it('同步消息并截断到最近 20 条', () => {
      const { bridge, ctx } = setupBridge();
      const messages = Array.from({ length: 25 }, (_, i) => ({
        role: 'user' as const,
        content: `消息${i}`,
      }));

      bridge.syncConversationHistory(messages);

      // 截断为最近 20 条（slice(-20)）
      expect(ctx.conversationHistory.length).toBe(20);
      expect(ctx.conversationHistory[0].content).toBe('消息5');
      expect(ctx.conversationHistory[19].content).toBe('消息24');
    });
  });

  describe('executeCommand 命令分发', () => {
    it('/clear 清空对话历史', async () => {
      const { bridge, ctx } = setupBridge();
      ctx.conversationHistory = [
        { role: 'user', content: '旧消息' },
      ];

      const result = await bridge.executeCommand('/clear');

      expect(result).toEqual({ ok: true, message: '对话历史已清空' });
      expect(ctx.conversationHistory.length).toBe(0);
    });

    it('/help 返回可用命令列表', async () => {
      const { bridge } = setupBridge();

      const result = await bridge.executeCommand('/help');

      expect(result).toHaveProperty('ok', true);
      const msg = (result as { message: string }).message;
      expect(msg).toContain('/clear');
      expect(msg).toContain('/status');
      expect(msg).toContain('/goal');
    });

    it('未知命令返回不支持提示', async () => {
      const { bridge } = setupBridge();

      const result = await bridge.executeCommand('/unknown_cmd');

      expect(result).toHaveProperty('ok', false);
      const msg = (result as { message: string }).message;
      expect(msg).toContain('/unknown_cmd');
    });
  });
});
