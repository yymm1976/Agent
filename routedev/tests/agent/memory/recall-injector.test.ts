// tests/agent/memory/recall-injector.test.ts
// Phase 71 Task B3：MemoryRecallInjector 单元测试
import { describe, it, expect, vi } from 'vitest';
import { MemoryRecallInjector } from '../../../src/agent/memory/recall-injector.js';
import type { KnowledgeGraph, GraphNode } from '../../../src/agent/memory/graph.js';

// mock KnowledgeGraph：只暴露 recall 方法
function makeMockGraph(
  recalled: Array<{ node: GraphNode; score: number; path: 'precise' | 'generalized' | 'both' }>,
): KnowledgeGraph {
  return {
    recall: vi.fn().mockReturnValue(recalled),
  } as unknown as KnowledgeGraph;
}

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'n1',
    type: 'fact',
    content: 'test fact',
    validatedCount: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deprecated: false,
    ...overrides,
  };
}

describe('MemoryRecallInjector', () => {
  it('空查询返回空字符串', () => {
    const graph = makeMockGraph([]);
    const injector = new MemoryRecallInjector(graph, 0.7, 5);
    expect(injector.recallToPrompt('')).toBe('');
    expect(injector.recallToPrompt('   ')).toBe('');
  });

  it('召回结果低于阈值时过滤', () => {
    const graph = makeMockGraph([
      { node: makeNode({ content: 'low confidence' }), score: 0.3, path: 'precise' },
      { node: makeNode({ content: 'high confidence' }), score: 0.9, path: 'precise' },
    ]);
    const injector = new MemoryRecallInjector(graph, 0.7, 5);
    const prompt = injector.recallToPrompt('test');
    expect(prompt).toContain('high confidence');
    expect(prompt).not.toContain('low confidence');
  });

  it('召回结果超过 maxMemories 时按 maxResults 截断', () => {
    // mock 的 recall 返回 10 条，但 maxMemories=3 应作为 maxResults 传给 recall
    // 这里验证 recallToPrompt 调用 recall 时传入了 maxResults=3
    const recallMock = vi.fn().mockImplementation((_q: string, options?: { maxResults?: number }) => {
      const max = options?.maxResults ?? 10;
      return Array.from({ length: Math.min(max, 10) }, (_, i) => ({
        node: makeNode({ id: `n${i}`, content: `fact ${i}` }),
        score: 0.9,
        path: 'precise' as const,
      }));
    });
    const graph = { recall: recallMock } as unknown as KnowledgeGraph;
    const injector = new MemoryRecallInjector(graph, 0.7, 3);
    const prompt = injector.recallToPrompt('test');
    // recall 应被调用一次，maxResults=3
    expect(recallMock).toHaveBeenCalledTimes(1);
    expect(recallMock.mock.calls[0][1]).toEqual({ maxResults: 3 });
    // prompt 中应有 3 条 fact
    const factCount = (prompt.match(/- fact/g) || []).length;
    expect(factCount).toBe(3);
  });

  it('KnowledgeGraph.recall 抛错时 fail-open 返回空', () => {
    const graph = {
      recall: vi.fn().mockImplementation(() => { throw new Error('graph error'); }),
    } as unknown as KnowledgeGraph;
    const injector = new MemoryRecallInjector(graph, 0.7, 5);
    expect(injector.recallToPrompt('test')).toBe('');
  });

  it('多条记忆格式化正确', () => {
    const graph = makeMockGraph([
      { node: makeNode({ content: 'fact A' }), score: 0.9, path: 'precise' },
      { node: makeNode({ content: 'fact B' }), score: 0.85, path: 'generalized' },
    ]);
    const injector = new MemoryRecallInjector(graph, 0.7, 5);
    const prompt = injector.recallToPrompt('test');
    expect(prompt).toContain('fact A');
    expect(prompt).toContain('fact B');
    expect(prompt).toContain('【相关记忆】');
  });

  it('置信度精确到 2 位小数', () => {
    const graph = makeMockGraph([
      { node: makeNode({ content: 'test' }), score: 0.857, path: 'precise' },
    ]);
    const injector = new MemoryRecallInjector(graph, 0.7, 5);
    const prompt = injector.recallToPrompt('test');
    expect(prompt).toContain('0.86'); // toFixed(2) 四舍五入
  });

  it('来源字段正确输出（GraphNode.type）', () => {
    const graph = makeMockGraph([
      { node: makeNode({ type: 'decision', content: 'decided X' }), score: 0.9, path: 'precise' },
    ]);
    const injector = new MemoryRecallInjector(graph, 0.7, 5);
    const prompt = injector.recallToPrompt('test');
    expect(prompt).toContain('来源: decision');
  });

  it('injectThreshold=0 时不过滤', () => {
    const graph = makeMockGraph([
      { node: makeNode({ content: 'low' }), score: 0.1, path: 'precise' },
    ]);
    const injector = new MemoryRecallInjector(graph, 0, 5);
    const prompt = injector.recallToPrompt('test');
    expect(prompt).toContain('low');
  });

  it('全部低于阈值时返回空字符串', () => {
    const graph = makeMockGraph([
      { node: makeNode({ content: 'a' }), score: 0.5, path: 'precise' },
      { node: makeNode({ content: 'b' }), score: 0.6, path: 'generalized' },
    ]);
    const injector = new MemoryRecallInjector(graph, 0.7, 5);
    expect(injector.recallToPrompt('test')).toBe('');
  });

  it('recall 返回空数组时返回空字符串', () => {
    const graph = makeMockGraph([]);
    const injector = new MemoryRecallInjector(graph, 0.7, 5);
    expect(injector.recallToPrompt('test')).toBe('');
  });
});
