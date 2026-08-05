// tests/agent/tool-search-e2e.test.ts
// P2 复审：真实两轮 ReAct 端到端——tool_search 提升 → 下一轮 schema 含新工具 → 成功调用
//
// 覆盖完整链路（非纯函数测试）：
//   第 1 轮 mock 模型返回 tool_search(query)
//   → loop 执行真实 tool_search（提升 web_search）
//   → 第 2 轮 client.stream 收到的 tools 中出现 web_search
//   → 模型调用 web_search → 工具成功执行
//   → 第 3 轮返回文本 done

import { describe, expect, it } from 'vitest';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistryAdapter } from '../../src/tools/adapter.js';
import { TurnToolBoost, createToolSearchTool } from '../../src/tools/tool-search.js';
import type { ILLMClient, LLMRequestOptions, LLMStreamEvent, RoutingResult } from '../../src/router/types.js';

/** 一个可执行的 deferred 网页搜索工具 */
function makeWebSearchTool() {
  return {
    definition: {
      name: 'web_search',
      description: '搜索互联网网页，返回搜索结果摘要',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词' } },
        required: ['query'],
      },
      requiresApproval: false,
      category: 'web' as const,
      exposure: 'deferred' as const,
    },
    validateArgs: () => ({ valid: true, errors: [] as string[] }),
    async execute(args: Record<string, unknown>) {
      return { success: true, output: `[搜索] ${String(args.query ?? '')} 的结果` };
    },
  };
}

function makeRouteDecision(): RoutingResult {
  return {
    model: {
      id: 'deepseek-v4-flash',
      name: 'deepseek-v4-flash',
      provider: 'deepseek',
      tier: 'simple',
      contextWindow: 1048576,
      capabilities: ['tool_use', 'streaming', 'parallel_tool_calls'],
      latencyMs: 0,
      available: true,
    },
    providerId: 'deepseek',
    fallbackUsed: false,
    originalTier: 'simple',
    degraded: false,
  };
}

describe('P2 复审：tool_search 真实两轮 ReAct 端到端', () => {
  it('第 1 轮提升 → 第 2 轮 schema 含 web_search → 调用成功 → 第 3 轮 done', async () => {
    const registry = new ToolRegistry();
    const boost = new TurnToolBoost();
    registry.register(makeWebSearchTool() as never);
    registry.register(createToolSearchTool({ registry, boost }));
    const executor = new ToolExecutor(registry);
    executor.setSecurityChecker({
      checkFilePath: () => ({ allowed: true }),
      checkCommand: () => ({ allowed: true }),
      checkNetworkRequest: async () => ({ allowed: true }),
    } as never);
    const adapter = new ToolRegistryAdapter(registry, executor, {
      workingDirectory: process.cwd(),
      allowedDirectories: [process.cwd()],
      environment: {},
      timeoutMs: 30000,
    } as never);
    adapter.setToolBoost(boost);

    // mock 模型：轮次 1=tool_search；轮次 2=web_search；轮次 3=文本
    const schemaNamesByRound: string[][] = [];
    let callCount = 0;
    const client: ILLMClient = {
      protocol: 'openai',
      providerId: 'deepseek',
      isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      stream: async function* (options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
        callCount += 1;
        schemaNamesByRound.push((options.tools ?? []).map((t) => t.name));
        if (callCount === 1) {
          yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'tool_search' } };
          yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{"query":"搜索"}' };
          yield { type: 'tool_call_end', toolCallId: 'c1' };
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
          yield { type: 'done', finishReason: 'tool_use' };
        } else if (callCount === 2) {
          yield { type: 'tool_call_start', toolCall: { id: 'c2', name: 'web_search' } };
          yield { type: 'tool_call_delta', toolCallId: 'c2', argumentsDelta: '{"query":"routedev"}' };
          yield { type: 'tool_call_end', toolCallId: 'c2' };
          yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
          yield { type: 'done', finishReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: '完成 ' };
          yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 } };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };

    const loop = new ReActAgentLoop(adapter as never, { toolsEnabled: true });
    const events: string[] = [];
    for await (const event of loop.run({
      userMessage: '搜索 routedev 的资料',
      llmClient: client,
      routeDecision: makeRouteDecision(),
      conversationHistory: [],
      onConfirmTool: async () => true,
    })) {
      if (event.type === 'tool_call_start') events.push(`start:${event.toolName}`);
      if (event.type === 'tool_call_result') events.push(`result:${event.toolName}:${event.isError ? 'err' : 'ok'}`);
      if (event.type === 'done') events.push(`done:${event.content.trim()}`);
    }

    // 核心断言：第 2 轮 schema 必须包含 tool_search 提升的 web_search
    expect(schemaNamesByRound.length).toBeGreaterThanOrEqual(3);
    expect(schemaNamesByRound[0]).not.toContain('web_search'); // 第 1 轮：deferred 不可见
    expect(schemaNamesByRound[1]).toContain('web_search'); // 第 2 轮：提升后可见 ✓
    // 完整调用链：tool_search 执行 → web_search 执行成功 → done
    expect(events).toContain('start:tool_search');
    expect(events).toContain('result:tool_search:ok');
    expect(events).toContain('start:web_search');
    expect(events).toContain('result:web_search:ok');
    expect(events.some((e) => e.startsWith('done:'))).toBe(true);
  });

  it('P1 复审：跨 Run boost 清理——Run A 提升未消费，Run B 从干净 boost 开始', async () => {
    const registry = new ToolRegistry();
    const boost = new TurnToolBoost();
    registry.register(makeWebSearchTool() as never);
    registry.register(createToolSearchTool({ registry, boost }));
    const executor = new ToolExecutor(registry);
    executor.setSecurityChecker({
      checkFilePath: () => ({ allowed: true }),
      checkCommand: () => ({ allowed: true }),
      checkNetworkRequest: async () => ({ allowed: true }),
    } as never);
    const adapter = new ToolRegistryAdapter(registry, executor, {
      workingDirectory: process.cwd(),
      allowedDirectories: [process.cwd()],
      environment: {},
      timeoutMs: 30000,
    } as never);
    adapter.setToolBoost(boost);

    // Run A：mock 模型第 1 轮调 tool_search（提升 web_search）后直接结束（不消费）
    const clientA: ILLMClient = {
      protocol: 'openai', providerId: 'deepseek', isReady: () => true,
      complete: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop', model: 'm' }),
      stream: async function* () {
        yield { type: 'tool_call_start', toolCall: { id: 'c1', name: 'tool_search' } };
        yield { type: 'tool_call_delta', toolCallId: 'c1', argumentsDelta: '{"query":"搜索"}' };
        yield { type: 'tool_call_end', toolCallId: 'c1' };
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
        yield { type: 'done', finishReason: 'tool_use' };
        // 第 2 轮：不再调用工具，直接结束
        yield { type: 'text_delta', text: '完毕 ' };
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const loopA = new ReActAgentLoop(adapter as never, { toolsEnabled: true });
    for await (const _e of loopA.run({
      userMessage: '搜索一下',
      llmClient: clientA,
      routeDecision: makeRouteDecision(),
      conversationHistory: [],
      onConfirmTool: async () => true,
    })) { /* 消费 */ }
    // Run A 结束时 boost 必须被清理（finally resetBoost）
    expect(boost.names.size).toBe(0);

    // Run B：ChatBridge 语义——进入 loop 前读取 boost 渲染摘要；应无残留
    const preRunBoost = [...boost.names];
    expect(preRunBoost).not.toContain('web_search');

    // Run B 首轮 schema（loop 开始前 adapter 视角）：无 web_search
    const runBFirstSchema = adapter.getToolDefinitions({ mode: 'coding' }).map((d) => d.name);
    expect(runBFirstSchema).not.toContain('web_search');
  });
});
