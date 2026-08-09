// tests/agent/loop-length.test.ts
// Eval P1 regression：finish_reason=length 是 **非终止** 状态（False Success 修复）。
// L3-09 实证：无工具调用 + finishReason='length'（outputTokens=4096, content=""）
// 被旧逻辑记为 run_completed → 生产运行时 bug。
//
// 契约（评审指定）：
//   - llm_succeeded 仍记录（provider 请求确实成功）
//   - length 无工具调用 → append continuation 指令 → 继续 ReAct（最多连续 2 次）
//   - 仍 length → run_interrupted(reason=model_output_truncated)，绝不 run_completed
//   - length + content="" 必须旧行为 → 新行为（不产生 run_completed）
//   - length + 完整工具调用 → 工具执行一次 + 继续（不触发 continuation 计数）
//   - cancellation 优先于 continuation

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import { NativeAgentKernel } from '../../src/agent/kernel-native.js';
import { TraceCollector } from '../../src/harness/trace-collector.js';
import { RunEventLog } from '../../src/harness/run-event-log.js';
import type { ReActRunParams } from '../../src/agent/loop.js';
import type { ToolExecutorAdapter } from '../../src/agent/loop-config.js';
import type { AgentExecutionContext } from '../../src/agent/execution-context.js';
import type { ILLMClient, LLMStreamEvent, LLMRequestOptions, LLMResponse, TokenUsageInfo } from '../../src/router/types.js';

// ============================================================
// mock LLM：按序列返回流（每次 LLM 调用消费一个流）
// ============================================================

type StreamFactory = () => AsyncGenerator<LLMStreamEvent>;

function makeClient(streams: StreamFactory[], onCall?: (index: number) => void): ILLMClient {
  let i = 0;
  return {
    protocol: 'openai',
    providerId: 'mock',
    isReady: () => true,
    complete: async (_o: LLMRequestOptions): Promise<LLMResponse> => ({
      content: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
      model: 'mock-model',
    }),
    stream: async function* (_o: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
      const idx = Math.min(i, streams.length - 1);
      i += 1;
      onCall?.(idx);
      yield* streams[idx]();
    },
  };
}

/** 文本流（可空内容；finishReason 可指定） */
function textStream(content: string, finishReason: 'stop' | 'length'): StreamFactory {
  return async function* (): AsyncGenerator<LLMStreamEvent> {
    if (content) yield { type: 'text_delta', text: content };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4096, totalTokens: 4106 } };
    yield { type: 'done', finishReason };
  };
}

/** 工具调用流（L3-09 场景：outputTokens=4096 + 完整 tool call + finishReason=length） */
function toolCallStream(toolName: string, args: Record<string, unknown>): StreamFactory {
  return async function* (): AsyncGenerator<LLMStreamEvent> {
    yield { type: 'tool_call_start', toolCall: { id: 'call_len_1', name: toolName } };
    yield { type: 'tool_call_delta', toolCallId: 'call_len_1', argumentsDelta: JSON.stringify(args) };
    yield { type: 'tool_call_end', toolCallId: 'call_len_1' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4096, totalTokens: 4106 } };
    yield { type: 'done', finishReason: 'length' };
  };
}

// ============================================================
// 工具执行器（计数）
// ============================================================

class CountingExecutor implements ToolExecutorAdapter {
  calls = 0;
  getToolDefinitions() {
    return [{ name: 'echo_tool', description: 'echo', parameters: { type: 'object', properties: { v: { type: 'string' } } } }];
  }
  hasTool(name: string): boolean {
    return name === 'echo_tool';
  }
  async executeTool(_name: string, _id: string, _args: Record<string, unknown>): Promise<string> {
    this.calls += 1;
    return 'done';
  }
}

// ============================================================
// kernel 装配（与 eval harness / 生产一致：RunEventLog 经 trace storageDir）
// ============================================================

async function driveRun(client: ILLMClient, executor: ToolExecutorAdapter, opts?: { signal?: AbortSignal }): Promise<{
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  projection: { completed: boolean; interruptedReason?: string } | null;
  executor: CountingExecutor;
}> {
  const base = mkdtempSync(join(tmpdir(), 'rdev-len-'));
  try {
    const loop = new ReActAgentLoop(executor, {
      toolsEnabled: true,
      maxIterations: 30,
      parallelToolExecution: false,
      maxLengthContinuations: 2,
    });
    const trace = new TraceCollector({ storageDir: join(base, 'traces') });
    const kernel = new NativeAgentKernel(loop, { trace });
    const ctx = {
      sessionId: `sess-len-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      workspace: { workingDirectory: base, allowedDirectories: [base] },
    } as unknown as AgentExecutionContext;
    const params: ReActRunParams = {
      requestId: `run-len-${Date.now()}`,
      userMessage: 'test',
      llmClient: client as never,
      routeDecision: {
        model: {
          id: 'mock-model', name: 'mock', provider: 'eval', tier: 'simple' as const,
          contextWindow: 64000, maxSchemaTokens: 4096, capabilities: ['tool_use'] as const,
          latencyMs: 0, available: true,
        },
        providerId: 'eval', fallbackUsed: false, originalTier: 'simple' as const, degraded: false,
      },
      conversationHistory: [],
      autonomyMode: 'auto' as const,
      signal: opts?.signal,
      onConfirmTool: async () => true,
    };
    for await (const _ev of kernel.runReAct(ctx, params)) { /* drain */ }
    const replay = RunEventLog.replay(join(base, 'traces'), params.requestId!);
    return {
      events: replay.events.map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> })),
      projection: replay.projection,
      executor: executor as CountingExecutor,
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ============================================================
// 测试
// ============================================================

describe('fix(agent): finish_reason=length is non-terminal', () => {
  it('length → stop：注入续写指令后继续，最终 run_completed（continuation 一次）', async () => {
    const client = makeClient([textStream('partial output', 'length'), textStream('completed', 'stop')]);
    const { events, projection } = await driveRun(client, new CountingExecutor());
    expect(projection?.completed).toBe(true);
    const completed = events.filter((e) => e.type === 'run_completed');
    const interrupted = events.filter((e) => e.type === 'run_interrupted');
    expect(completed).toHaveLength(1);
    expect(interrupted).toHaveLength(0);
    expect(events.filter((e) => e.type === 'llm_succeeded')).toHaveLength(2); // 续写后第二轮
  });

  it('empty length → stop：content="" 的截断同样触发续写，最终完成（不因空内容直接成功）', async () => {
    const client = makeClient([textStream('', 'length'), textStream('final', 'stop')]);
    const { events, projection } = await driveRun(client, new CountingExecutor());
    expect(projection?.completed).toBe(true);
    expect(events.filter((e) => e.type === 'run_completed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'run_interrupted')).toHaveLength(0);
  });

  it('repeated length（> 上限 2 次）→ run_interrupted(model_output_truncated)，绝不 run_completed', async () => {
    const client = makeClient([textStream('a', 'length'), textStream('b', 'length'), textStream('c', 'length')]);
    const { events, projection } = await driveRun(client, new CountingExecutor());
    expect(projection?.completed).toBe(false);
    expect(projection?.interruptedReason).toBe('model_output_truncated');
    expect(events.filter((e) => e.type === 'run_completed')).toHaveLength(0);
    const interrupted = events.filter((e) => e.type === 'run_interrupted');
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].payload.reason).toBe('model_output_truncated');
  });

  it('length + 完整工具调用 → 工具执行一次 + 继续（length 不影响工具轮）', async () => {
    const executor = new CountingExecutor();
    const client = makeClient([
      toolCallStream('echo_tool', { v: 'x' }),
      textStream('done after tool', 'stop'),
    ]);
    const { projection, executor: ex } = await driveRun(client, executor);
    expect(ex.calls).toBe(1); // 工具只执行一次
    expect(projection?.completed).toBe(true);
  });

  it('cancellation wins over continuation：流返回后 signal 已 aborted → 取消而非续写', async () => {
    const controller = new AbortController();
    const client = makeClient(
      [textStream('truncated', 'length'), textStream('should not run', 'stop')],
      (idx) => {
        // 第一次流返回后立即取消（continuation 决策前 signal 已翻转）
        if (idx === 0) controller.abort();
      },
    );
    const { events, projection } = await driveRun(client, new CountingExecutor(), { signal: controller.signal });
    expect(projection?.completed).toBe(false);
    expect(events.filter((e) => e.type === 'run_completed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'run_interrupted')).toHaveLength(1);
    // 取消后不得发起续写 LLM 调用（仅第一次请求）
    expect(events.filter((e) => e.type === 'llm_requested')).toHaveLength(1);
  });

  it('L3-09 regression：outputTokens=4096 + finishReason=length + toolCalls=[] + content="" ⇒ run_completed count = 0', async () => {
    // 直接复现 eval L3-09 最后一步：模型输出被 maxTokens 截断且内容为空
    const client = makeClient([
      textStream('', 'length'), // attempt 8 复刻：content=""，finishReason=length
      textStream('', 'length'),
      textStream('', 'length'), // 连续 3 次截断 → 超过 2 次续写上限
    ]);
    const { events, projection } = await driveRun(client, new CountingExecutor());
    const completed = events.filter((e) => e.type === 'run_completed');
    expect(completed).toHaveLength(0); // 旧逻辑此处错误记 1 次 run_completed
    expect(projection?.interruptedReason).toBe('model_output_truncated');
  });
});
