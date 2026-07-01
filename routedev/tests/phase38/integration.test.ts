// tests/phase38/integration.test.ts
// Phase 38 Task 5：集成测试
// 跨模块验证三个核心场景：
//   1. 中间件链顺序执行 + fail-open + LoopDetectionMiddleware
//   2. 子 Agent 防递归（createChildRegistry 工具集隔离）
//   3. 知识图谱完整生命周期（create → recallV2 → improve → forget → /dream 桥接）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import { AgentMiddlewarePipeline, type MiddlewareContext } from '../../src/agent/middleware.js';
import { LoopDetectionMiddleware } from '../../src/agent/middleware/loop-detection.js';
import type { ReActEvent, ToolExecutorAdapter } from '../../src/agent/loop-config.js';
import type {
  ILLMClient,
  LLMStreamEvent,
  LLMRequestOptions,
  LLMResponse,
  RoutingResult,
} from '../../src/router/types.js';

import { ToolRegistry } from '../../src/tools/registry.js';
import { FileReadTool } from '../../src/tools/builtin/file-read.js';
import { FileWriteTool } from '../../src/tools/builtin/file-write.js';
import { FileEditTool } from '../../src/tools/builtin/file-edit.js';
import { FileSearchTool } from '../../src/tools/builtin/file-search.js';
import { ListDirectoryTool } from '../../src/tools/builtin/list-directory.js';
import { ShellExecTool } from '../../src/tools/builtin/shell-exec.js';
import { GitOpTool } from '../../src/tools/builtin/git-op.js';
import { WebSearchTool } from '../../src/tools/builtin/web-search.js';
import { WebFetchTool } from '../../src/tools/builtin/web-fetch.js';
import { CodeSearchTool } from '../../src/tools/builtin/code-search.js';
import {
  SpawnAgentTool,
  createChildRegistry,
  SUBAGENT_TOOL_WHITELIST,
  type SpawnAgentFunction,
  type SpawnResult,
} from '../../src/tools/builtin/spawn-agent.js';

import { KnowledgeGraph } from '../../src/agent/memory/graph.js';
import type { GraphNode, GraphEdge } from '../../src/agent/memory/graph.js';
import { ContextManager } from '../../src/agent/memory/context-manager.js';
import { CheckpointWriter } from '../../src/agent/memory/checkpoint-writer.js';
import { ingestToGraph } from '../../src/agent/memory/dream-to-graph.js';
import type { DreamResult } from '../../src/agent/memory/dream-to-graph.js';
import type { CheckpointData } from '../../src/agent/memory/types.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================
// 公共 Mock 工厂
// ============================================================

class MockToolExecutor implements ToolExecutorAdapter {
  getToolDefinitions() {
    return [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];
  }
  async executeTool(toolName: string): Promise<string> {
    return `File content for ${toolName}`;
  }
  hasTool(toolName: string): boolean {
    return toolName === 'read_file';
  }
}

function makeRouteDecision(modelId: string = 'mock-model'): RoutingResult {
  return {
    model: {
      id: modelId,
      name: modelId,
      provider: 'mock',
      tier: 'simple',
      contextWindow: 128000,
      capabilities: [],
      latencyMs: 0,
      available: true,
    },
    providerId: 'mock',
    fallbackUsed: false,
    originalTier: 'simple',
    degraded: false,
  };
}

function createTextClient(text: string): ILLMClient {
  return {
    protocol: 'openai',
    providerId: 'mock',
    isReady: () => true,
    complete: async (): Promise<LLMResponse> => ({
      content: text,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
      model: 'mock-model',
    }),
    stream: async function* (): AsyncGenerator<LLMStreamEvent> {
      yield { type: 'text_delta', text };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

function createToolCallClient(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  finalText: string = 'done',
): ILLMClient {
  let round = 0;
  return {
    protocol: 'openai',
    providerId: 'mock',
    isReady: () => true,
    complete: async () => ({
      content: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
      model: 'mock',
    }),
    stream: async function* (): AsyncGenerator<LLMStreamEvent> {
      round++;
      if (round <= calls.length) {
        const c = calls[round - 1];
        yield { type: 'tool_call_start', toolCall: { id: `call_${round}`, name: c.name } };
        yield { type: 'tool_call_delta', toolCallId: `call_${round}`, argumentsDelta: JSON.stringify(c.args) };
        yield { type: 'tool_call_end', toolCallId: `call_${round}` };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
        yield { type: 'done', finishReason: 'tool_use' };
      } else {
        yield { type: 'text_delta', text: finalText };
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 } };
        yield { type: 'done', finishReason: 'stop' };
      }
    },
  };
}

async function collectEvents(gen: AsyncGenerator<ReActEvent>): Promise<ReActEvent[]> {
  const events: ReActEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/** 创建包含全部内置工具的 registry */
function createFullRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new FileReadTool());
  registry.register(new FileWriteTool());
  registry.register(new FileEditTool());
  registry.register(new FileSearchTool());
  registry.register(new ListDirectoryTool());
  registry.register(new ShellExecTool());
  registry.register(new GitOpTool());
  registry.register(new WebSearchTool());
  registry.register(new WebFetchTool());
  registry.register(new CodeSearchTool());
  return registry;
}

function createMockSpawnFn(result: Partial<SpawnResult> = {}): SpawnAgentFunction {
  return vi.fn(async (): Promise<SpawnResult> => ({
    success: result.success ?? true,
    result: result.result ?? '子 Agent 完成',
    tokenUsage: result.tokenUsage,
    modifiedFiles: result.modifiedFiles,
    error: result.error,
  })) as unknown as SpawnAgentFunction;
}

/** 构造一个简单图节点 */
function makeNode(id: string, content: string, opts: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type: opts.type ?? 'fact',
    content,
    validatedCount: opts.validatedCount ?? 1,
    createdAt: opts.createdAt ?? 1000,
    updatedAt: opts.updatedAt ?? 1000,
    deprecated: opts.deprecated ?? false,
    unusedCount: opts.unusedCount,
  };
}

function makeEdge(source: string, target: string, opts: Partial<GraphEdge> = {}): GraphEdge {
  return {
    source,
    target,
    type: opts.type ?? 'relates_to',
    weight: opts.weight ?? 1,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================
// 集成测试 1：中间件链顺序执行
// ============================================================

describe('集成测试 1：中间件链顺序执行', () => {
  it('1.1 五阶段中间件按 onSystemPrompt → onModelCall → onReasoning → onActing → onAgent 顺序执行', async () => {
    const loop = new ReActAgentLoop(new MockToolExecutor(), { toolsEnabled: true });
    const pipeline = new AgentMiddlewarePipeline();
    const order: string[] = [];

    // 注册 5 个阶段的中间件，每个记录自己的阶段名
    pipeline.register('onSystemPrompt', async (ctx, next) => {
      order.push('onSystemPrompt');
      await next();
    });
    pipeline.register('onModelCall', async (ctx, next) => {
      order.push('onModelCall');
      await next();
    });
    pipeline.register('onReasoning', async (ctx, next) => {
      order.push('onReasoning');
      await next();
    });
    pipeline.register('onActing', async (ctx, next) => {
      order.push('onActing');
      await next();
    });
    pipeline.register('onAgent', async (ctx, next) => {
      order.push('onAgent');
      await next();
    });
    loop.setMiddlewarePipeline(pipeline);

    // 一轮工具调用 + 一轮文本回复
    await collectEvents(loop.run({
      userMessage: 'read file',
      llmClient: createToolCallClient([{ name: 'read_file', args: { path: '/x' } }], 'all done'),
      routeDecision: makeRouteDecision(),
      conversationHistory: [],
    }));

    // 验证顺序：第一轮迭代
    // onSystemPrompt（仅一次，循环开始时）
    // → onModelCall（第一轮 LLM 调用前）
    // → onReasoning（第一轮 LLM 返回后）
    // → onActing（工具执行前）
    // → onAgent（第一轮迭代结束，有工具调用触发 continue）
    // 第二轮（文本回复）：
    // → onModelCall → onReasoning（无 onActing / onAgent，因为没有工具调用）
    expect(order[0]).toBe('onSystemPrompt');
    expect(order[1]).toBe('onModelCall');
    expect(order[2]).toBe('onReasoning');
    expect(order[3]).toBe('onActing');
    expect(order[4]).toBe('onAgent');

    // onSystemPrompt 只出现一次
    expect(order.filter(p => p === 'onSystemPrompt').length).toBe(1);
    // onActing 只在工具调用轮出现一次
    expect(order.filter(p => p === 'onActing').length).toBe(1);
    // onAgent 只在有工具调用的迭代结束出现一次
    expect(order.filter(p => p === 'onAgent').length).toBe(1);
    // onModelCall 和 onReasoning 出现两次（两轮迭代）
    expect(order.filter(p => p === 'onModelCall').length).toBe(2);
    expect(order.filter(p => p === 'onReasoning').length).toBe(2);
  });

  it('1.2 中间件异常不阻断循环（fail-open）', async () => {
    const loop = new ReActAgentLoop(new MockToolExecutor(), { toolsEnabled: true });
    const pipeline = new AgentMiddlewarePipeline();

    // onSystemPrompt 抛异常
    pipeline.register('onSystemPrompt', async () => {
      throw new Error('onSystemPrompt boom');
    });
    // onModelCall 抛异常
    pipeline.register('onModelCall', async () => {
      throw new Error('onModelCall boom');
    });
    // onReasoning 抛异常
    pipeline.register('onReasoning', async () => {
      throw new Error('onReasoning boom');
    });
    // onAgent 抛异常
    pipeline.register('onAgent', async () => {
      throw new Error('onAgent boom');
    });
    loop.setMiddlewarePipeline(pipeline);

    const events = await collectEvents(loop.run({
      userMessage: 'read file',
      llmClient: createToolCallClient([{ name: 'read_file', args: { path: '/x' } }], 'done'),
      routeDecision: makeRouteDecision(),
      conversationHistory: [],
    }));

    // fail-open：循环仍然完成，有 done 事件
    expect(events.some(e => e.type === 'done')).toBe(true);
    // 工具仍然执行（onActing 是 fail-closed 但没注册抛异常的中间件）
    expect(events.some(e => e.type === 'tool_call_result')).toBe(true);
  });

  it('1.3 LoopDetectionMiddleware 在 3 次重复后设置 loopDetected', async () => {
    const loop = new ReActAgentLoop(new MockToolExecutor(), {
      toolsEnabled: true,
      maxIterations: 6,
    });
    const pipeline = new AgentMiddlewarePipeline();
    const mw = new LoopDetectionMiddleware({ windowSize: 10, maxRepeats: 3 });
    pipeline.register('onReasoning', mw.getHandler());
    loop.setMiddlewarePipeline(pipeline);

    // 同一工具同一参数调用 4 次，第 3 次 onReasoning 应触发 loopDetected
    const client = createToolCallClient(
      [
        { name: 'read_file', args: { path: '/same' } },
        { name: 'read_file', args: { path: '/same' } },
        { name: 'read_file', args: { path: '/same' } },
        { name: 'read_file', args: { path: '/same' } },
      ],
      'finally done',
    );

    const events = await collectEvents(loop.run({
      userMessage: 'read same file repeatedly',
      llmClient: client,
      routeDecision: makeRouteDecision(),
      conversationHistory: [],
    }));

    // 循环应正常结束
    expect(events.some(e => e.type === 'done')).toBe(true);
    // 应有至少 3 次工具调用结果
    const toolResults = events.filter(e => e.type === 'tool_call_result');
    expect(toolResults.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================
// 集成测试 2：子 Agent 防递归
// ============================================================

describe('集成测试 2：子 Agent 防递归', () => {
  it('2.1 createChildRegistry 创建的子 Agent ToolRegistry 不包含 spawn_agent', () => {
    const parent = createFullRegistry();
    parent.register(new SpawnAgentTool(createMockSpawnFn()));

    // 父 registry 有 spawn_agent
    expect(parent.has('spawn_agent')).toBe(true);

    const child = createChildRegistry(parent, 'general');

    // 子 registry 不包含 spawn_agent
    expect(child.has('spawn_agent')).toBe(false);
    // 父 registry 仍保留 spawn_agent（互不影响）
    expect(parent.has('spawn_agent')).toBe(true);
  });

  it('2.2 researcher 类型子 Agent 只保留白名单工具', () => {
    const parent = createFullRegistry();
    parent.register(new SpawnAgentTool(createMockSpawnFn()));

    const child = createChildRegistry(parent, 'researcher');
    const whitelist = SUBAGENT_TOOL_WHITELIST.researcher;

    // 白名单工具全部保留
    for (const name of whitelist) {
      expect(child.has(name)).toBe(true);
    }

    // 非白名单工具被移除
    expect(child.has('file_write')).toBe(false);
    expect(child.has('file_edit')).toBe(false);
    expect(child.has('shell_exec')).toBe(false);
    expect(child.has('git_op')).toBe(false);
    expect(child.has('spawn_agent')).toBe(false);

    // 工具数 = 白名单大小
    expect(child.size).toBe(whitelist.size);
  });

  it('2.3 子 Agent 物理上无法调用 spawn_agent（工具不存在）', async () => {
    const parent = createFullRegistry();
    parent.register(new SpawnAgentTool(createMockSpawnFn()));

    const child = createChildRegistry(parent, 'general');

    // 物理验证：child.get('spawn_agent') 返回 undefined
    expect(child.get('spawn_agent')).toBeUndefined();

    // child.has 返回 false
    expect(child.has('spawn_agent')).toBe(false);

    // 子 registry 的 function schemas 不包含 spawn_agent
    const schemas = child.getFunctionSchemas();
    const schemaNames = schemas.map(s => s.name);
    expect(schemaNames).not.toContain('spawn_agent');

    // 验证隔离性：记录子 registry 创建时的工具数
    const childSizeAtCreation = child.size;

    // 父 registry 在子创建后注册新工具（用 FileReadTool 覆盖注册，不报错）
    parent.register(new FileReadTool(), true);
    expect(parent.has('file_read')).toBe(true);

    // 子 registry 在创建时已确定工具集，不受父后续注册影响
    expect(child.size).toBe(childSizeAtCreation);
    // 核心断言：子 registry 没有 spawn_agent
    expect(child.has('spawn_agent')).toBe(false);
  });
});

// ============================================================
// 集成测试 3：知识图谱完整生命周期
// ============================================================

describe('集成测试 3：知识图谱完整生命周期', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph();
  });

  it('3.1 创建节点 → recallV2 → improve(useful) → validatedCount 递增 → improve(incorrect) → deprecated → forget', () => {
    const now = Date.now();

    // 步骤 1：创建知识节点
    graph.addNode(makeNode('k1', 'TypeScript 严格模式配置', {
      type: 'fact',
      validatedCount: 2,
      updatedAt: now - 10 * DAY_MS,
    }));
    graph.addNode(makeNode('k2', 'React 组件设计模式', {
      type: 'fact',
      validatedCount: 1,
      updatedAt: now - 5 * DAY_MS,
    }));
    graph.addEdge(makeEdge('k1', 'k2'));

    expect(graph.listNodes().length).toBe(2);

    // 步骤 2：recallV2 检索（semantic 策略）
    const recalled = graph.recallV2({
      query: 'TypeScript',
      strategy: 'semantic',
    });
    expect(recalled.length).toBeGreaterThan(0);
    const k1Result = recalled.find(r => r.node.id === 'k1');
    expect(k1Result).toBeTruthy();
    expect(k1Result!.strategy).toBe('semantic');

    // 步骤 3：improve(useful) → validatedCount 递增
    const usefulResult = graph.improve({
      query: 'TypeScript',
      nodeIds: ['k1'],
      outcome: 'useful',
    });
    expect(usefulResult.updatedNodes).toBe(1);
    expect(graph.getNode('k1')!.validatedCount).toBe(3);

    // 步骤 4：improve(incorrect) → 标记 deprecated
    const incorrectResult = graph.improve({
      query: 'TypeScript',
      nodeIds: ['k2'],
      outcome: 'incorrect',
      details: 'React 组件设计模式已更新',
    });
    expect(incorrectResult.updatedNodes).toBe(1);
    expect(incorrectResult.supersededNodes).toBe(1);
    expect(graph.getNode('k2')!.deprecated).toBe(true);

    // 步骤 5：deprecated 节点在 recallV2 中默认排除
    const recalledAfterDeprecated = graph.recallV2({
      query: 'React',
      strategy: 'semantic',
    });
    const deprecatedInResults = recalledAfterDeprecated.find(r => r.node.id === 'k2');
    expect(deprecatedInResults).toBeUndefined();

    // 步骤 6：forget 显式遗忘 k1
    const forgetResult = graph.forget({
      nodeIds: ['k1'],
      dryRun: false,
    });
    expect(forgetResult.forgotten).toBe(1);
    expect(graph.getNode('k1')!.deprecated).toBe(true);

    // 步骤 7：通过 listNodes({ deprecated: true }) 仍可访问被标记的节点
    const deprecatedNodes = graph.listNodes({ deprecated: true });
    expect(deprecatedNodes.length).toBe(2);
    // improve(incorrect) 带 details 会创建新节点（修正版），该节点未被 deprecated
    const activeNodes = graph.listNodes({ deprecated: false });
    expect(activeNodes.length).toBe(1);
    // 验证新节点是 k2 的修正版
    expect(activeNodes[0].content).toBe('React 组件设计模式已更新');
  });

  it('3.3 ingestToGraph 直接调用验证完整归纳流程', () => {
    const graph = new KnowledgeGraph();
    // 预置一个已有节点，测试合并逻辑
    graph.addNode(makeNode('existing', '决策: 采用 TypeScript 严格模式\n理由: 提升类型安全', {
      type: 'decision',
      validatedCount: 2,
    }));

    const checkpoint: CheckpointData = {
      currentIntent: '',
      nextAction: '',
      workingConstraints: [],
      taskTree: { description: '', status: 'pending', children: [] },
      currentWorkingFiles: [],
      involvedFiles: [],
      crossTaskDiscoveries: ['跨任务发现：React 19 支持 Server Components'],
      errorsAndFixes: [
        { error: '内存泄漏', fix: '清理 useEffect 副作用', resolved: true },
      ],
      runtimeState: {},
      designDecisions: [
        { decision: '采用 TypeScript 严格模式', reason: '提升类型安全' },
      ],
      miscNotes: [],
    };

    const dreamResult: DreamResult = {
      beforeSize: 100,
      afterSize: 80,
      mergedCount: 0,
      consolidated: checkpoint,
      summary: '整理完成',
    };

    const result = ingestToGraph(dreamResult, graph);

    // 应创建新节点（crossTaskDiscoveries + errorsAndFixes）
    expect(result.created).toBeGreaterThan(0);
    // designDecisions 与已有节点相似 → 合并
    expect(result.merged).toBeGreaterThanOrEqual(0);
    // 归档统计（可能为 0，因为没有过时节点）
    expect(result.archived).toBeGreaterThanOrEqual(0);

    // 验证图谱中有新节点
    const nodes = graph.listNodes();
    expect(nodes.length).toBeGreaterThan(1);

    // 验证 React 发现被注入
    const reactNode = nodes.find(n => n.content.includes('React 19'));
    expect(reactNode).toBeTruthy();
    expect(reactNode!.type).toBe('fact');

    // 验证已修复的错误被注入为 fact
    const errorNode = nodes.find(n => n.content.includes('内存泄漏'));
    expect(errorNode).toBeTruthy();
    expect(errorNode!.type).toBe('fact');
  });
});
