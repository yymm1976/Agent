// tests/agent/tool-execution-mode.test.ts
// Phase 73 Part B：工具并行执行精化（per-tool executionMode）测试
//
// 验证点：
//   1. batch 中有 sequential 工具时走串行分支（事件序：start→result→start→result）
//   2. batch 中全 parallel 工具时走并行分支（事件序：start→start→result→result）
//   3. executionMode 未声明时默认 parallel
//
// 判定原理：
//   - 并行分支：先 yield 所有 tool_call_start（阶段1确认），再 yield 所有 tool_call_result（阶段3）
//   - 串行分支：每个工具的 start 与 result 紧邻交替出现

import { describe, it, expect } from 'vitest';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import type { ReActEvent, ToolExecutorAdapter } from '../../src/agent/loop-config.js';
import type {
  ILLMClient,
  LLMStreamEvent,
  LLMRequestOptions,
  LLMResponse,
  RoutingResult,
} from '../../src/router/types.js';

// ============================================================
// Mock LLM 客户端：第一次返回 2 个工具调用，第二次返回纯文本
// ============================================================

/**
 * 创建一个返回 2 个工具调用的 Mock LLM 客户端
 * 第一次调用：yield 两个 tool_call（batch），触发工具执行
 * 第二次调用：返回纯文本，结束循环
 */
function createMockBatchToolCallClient(
  tool1: { name: string; args: Record<string, unknown> },
  tool2: { name: string; args: Record<string, unknown> },
  followUpText: string,
): ILLMClient {
  let callCount = 0;
  return {
    protocol: 'openai',
    providerId: 'mock',
    isReady: () => true,
    complete: async (): Promise<LLMResponse> => ({
      content: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
      model: 'mock',
    }),
    stream: async function* (): AsyncGenerator<LLMStreamEvent> {
      callCount++;
      if (callCount === 1) {
        // 第一次：返回两个工具调用（batch）
        yield { type: 'tool_call_start', toolCall: { id: 'call_1', name: tool1.name } };
        yield { type: 'tool_call_delta', toolCallId: 'call_1', argumentsDelta: JSON.stringify(tool1.args) };
        yield { type: 'tool_call_end', toolCallId: 'call_1' };

        yield { type: 'tool_call_start', toolCall: { id: 'call_2', name: tool2.name } };
        yield { type: 'tool_call_delta', toolCallId: 'call_2', argumentsDelta: JSON.stringify(tool2.args) };
        yield { type: 'tool_call_end', toolCallId: 'call_2' };

        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
        yield { type: 'done', finishReason: 'tool_use' };
      } else {
        // 第二次：返回纯文本，结束循环
        const words = followUpText.split(' ');
        for (const word of words) {
          yield { type: 'text_delta', text: word + ' ' };
        }
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 } };
        yield { type: 'done', finishReason: 'stop' };
      }
    },
  };
}

// ============================================================
// Mock 工具执行器：支持配置 executionMode + 执行时间追踪
// ============================================================

/**
 * 可配置 executionMode 的 Mock 工具执行器
 * sequentialModes：工具名 → 'sequential' | 'parallel' | undefined
 *   - 'sequential'：声明串行
 *   - 'parallel' 或 undefined：默认并行
 */
class ModeAwareToolExecutor implements ToolExecutorAdapter {
  private modes: Map<string, 'sequential' | 'parallel'>;
  /** 记录每个工具调用的开始/结束时间戳，用于判定并行/串行 */
  readonly executionLog: { toolName: string; start: number; end: number }[] = [];

  constructor(modes: Record<string, 'sequential' | 'parallel'> = {}) {
    this.modes = new Map(Object.entries(modes));
  }

  getToolDefinitions() {
    return [
      { name: 'tool_a', description: 'tool a', parameters: { type: 'object', properties: {} } },
      { name: 'tool_b', description: 'tool b', parameters: { type: 'object', properties: {} } },
      { name: 'seq_tool', description: 'sequential tool', parameters: { type: 'object', properties: {} } },
    ];
  }

  async executeTool(toolName: string, _toolCallId: string, _args: Record<string, unknown>): Promise<string> {
    const start = Date.now();
    // 模拟工具执行耗时，让并行/串行的时间差异可观测
    await new Promise(resolve => setTimeout(resolve, 30));
    const end = Date.now();
    this.executionLog.push({ toolName, start, end });
    return `${toolName} 执行完成`;
  }

  hasTool(toolName: string): boolean {
    return ['tool_a', 'tool_b', 'seq_tool'].includes(toolName);
  }

  getToolExecutionMode(toolName: string): 'sequential' | 'parallel' | undefined {
    return this.modes.get(toolName);
  }
}

// ============================================================
// 测试辅助
// ============================================================

function makeRouteDecision(): RoutingResult {
  return {
    model: {
      id: 'mock-model',
      name: 'mock-model',
      provider: 'mock',
      tier: 'simple',
      contextWindow: 128000,
      // B-14：声明运行时能力（并行测试依赖 parallel_tool_calls；真实模型经 router 从 catalog 合并）
      capabilities: ['tool_use', 'streaming', 'parallel_tool_calls'],
      latencyMs: 0,
      available: true,
    },
    providerId: 'mock',
    fallbackUsed: false,
    originalTier: 'simple',
    degraded: false,
  };
}

/**
 * 从事件流中提取 tool_call 事件序列（仅 start 与 result），保留顺序
 * 用于判定并行 vs 串行的事件模式
 */
function extractToolEventSequence(events: ReActEvent[]): string[] {
  return events
    .filter(e => e.type === 'tool_call_start' || e.type === 'tool_call_result')
    .map(e => {
      if (e.type === 'tool_call_start') return `start:${(e as { toolName: string }).toolName}`;
      return `result:${(e as { toolName: string }).toolName}`;
    });
}

/** 运行 loop 并收集所有事件 */
async function runLoop_collectEvents(
  loop: ReActAgentLoop,
  client: ILLMClient,
): Promise<ReActEvent[]> {
  const events: ReActEvent[] = [];
  for await (const event of loop.run({
    userMessage: '执行两个工具',
    llmClient: client,
    routeDecision: makeRouteDecision(),
    conversationHistory: [],
  })) {
    events.push(event);
  }
  return events;
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 73 Part B：per-tool executionMode', () => {
  describe('batch 级 sequential 检测', () => {
    it('batch 中有 sequential 工具时走串行分支（start→result→start→result 交替）', async () => {
      // tool_a 声明为 sequential，整个 batch 回退串行
      const executor = new ModeAwareToolExecutor({
        tool_a: 'sequential',
      });
      const loop = new ReActAgentLoop(executor, {
        toolsEnabled: true,
        parallelToolExecution: true,
        // 不需要确认回调，工具默认 approved
      });
      const client = createMockBatchToolCallClient(
        { name: 'tool_a', args: {} },
        { name: 'tool_b', args: {} },
        '两个工具都执行完成',
      );

      const events = await runLoop_collectEvents(loop, client);
      const seq = extractToolEventSequence(events);

      // 串行模式：start(A) → result(A) → start(B) → result(B)
      expect(seq).toEqual(['start:tool_a', 'result:tool_a', 'start:tool_b', 'result:tool_b']);
    });

    it('batch 中全 parallel 工具时走并行分支（start→start→result→result 聚合）', async () => {
      // 两个工具都声明为 parallel
      const executor = new ModeAwareToolExecutor({
        tool_a: 'parallel',
        tool_b: 'parallel',
      });
      const loop = new ReActAgentLoop(executor, {
        toolsEnabled: true,
        parallelToolExecution: true,
      });
      const client = createMockBatchToolCallClient(
        { name: 'tool_a', args: {} },
        { name: 'tool_b', args: {} },
        '两个工具都执行完成',
      );

      const events = await runLoop_collectEvents(loop, client);
      const seq = extractToolEventSequence(events);

      // 并行模式：start(A) → start(B) → result(A) → result(B)
      expect(seq).toEqual(['start:tool_a', 'start:tool_b', 'result:tool_a', 'result:tool_b']);
    });

    it('executionMode 默认 parallel（未设置时走并行分支）', async () => {
      // 不设置任何 executionMode → 默认 parallel → 走并行分支
      const executor = new ModeAwareToolExecutor({});
      const loop = new ReActAgentLoop(executor, {
        toolsEnabled: true,
        parallelToolExecution: true,
      });
      const client = createMockBatchToolCallClient(
        { name: 'tool_a', args: {} },
        { name: 'tool_b', args: {} },
        '两个工具都执行完成',
      );

      const events = await runLoop_collectEvents(loop, client);
      const seq = extractToolEventSequence(events);

      // 并行模式：start(A) → start(B) → result(A) → result(B)
      expect(seq).toEqual(['start:tool_a', 'start:tool_b', 'result:tool_a', 'result:tool_b']);
    });
  });

  describe('executionMode 声明消费点', () => {
    it('ToolRegistryAdapter.getToolExecutionMode 返回工具定义中的 executionMode', async () => {
      // 直接验证 adapter 层的 consumption 点：getToolExecutionMode 读取 definition.executionMode
      const { ToolRegistryAdapter } = await import('../../src/tools/adapter.js');
      const { ToolRegistry } = await import('../../src/tools/registry.js');
      const { AskUserTool } = await import('../../src/tools/builtin/ask-user.js');

      const registry = new ToolRegistry();
      registry.register(new AskUserTool());
      const adapter = new ToolRegistryAdapter(
        registry,
        // executor 桩：getToolExecutionMode 不调用 executor，传 null 即可
        null as unknown as Parameters<typeof ToolRegistryAdapter>[1],
        { workingDirectory: '.', allowedDirectories: [], environment: {}, timeoutMs: 1000 },
      );

      // ask_user 已声明 sequential
      expect(adapter.getToolExecutionMode('ask_user')).toBe('sequential');
      // 不存在的工具返回 undefined
      expect(adapter.getToolExecutionMode('not_exist')).toBeUndefined();
    });

    it('ask_user / file_edit / shell_exec 均声明为 sequential', async () => {
      const { AskUserTool } = await import('../../src/tools/builtin/ask-user.js');
      const { FileEditTool } = await import('../../src/tools/builtin/file-edit.js');
      const { ShellExecTool } = await import('../../src/tools/builtin/shell-exec.js');

      expect(new AskUserTool().definition.executionMode).toBe('sequential');
      expect(new FileEditTool().definition.executionMode).toBe('sequential');
      expect(new ShellExecTool().definition.executionMode).toBe('sequential');
    });
  });
});
