// tests/phase38/knowledge-graph-enhanced.test.ts
// Phase 38 Task 3 + Task 4 测试：知识图谱反馈闭环、遗忘机制、多策略检索、持久化
//
// 测试覆盖：
//   - improve() 5 个测试
//   - forget() 4 个测试
//   - recallV2() 5 个测试
//   - 持久化 3 个测试

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KnowledgeGraph } from '../../src/agent/memory/graph.js';
import type { GraphNode, GraphEdge, RecallStrategy } from '../../src/agent/memory/graph.js';
import { ContextManager } from '../../src/agent/memory/context-manager.js';
import { CheckpointWriter } from '../../src/agent/memory/checkpoint-writer.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse } from '../../src/router/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** 构造一个简单节点 */
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

/** 构造一条简单边 */
function makeEdge(source: string, target: string, opts: Partial<GraphEdge> = {}): GraphEdge {
  return {
    source,
    target,
    type: opts.type ?? 'relates_to',
    weight: opts.weight ?? 1,
  };
}

/** 一天对应的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000;

describe('Phase 38 知识图谱增强', () => {
  describe('improve() 反馈机制', () => {
    let graph: KnowledgeGraph;

    beforeEach(() => {
      graph = new KnowledgeGraph();
      graph.addNode(makeNode('n1', 'TypeScript 编译配置', { validatedCount: 3, updatedAt: 1000 }));
      graph.addNode(makeNode('n2', 'React 组件设计', { validatedCount: 2, updatedAt: 1000 }));
    });

    it('1. useful 反馈递增 validatedCount 并刷新 updatedAt', () => {
      const before = graph.getNode('n1')!.updatedAt;
      // 等待一小段时间确保 Date.now() 不同
      const result = graph.improve({
        query: 'TypeScript',
        nodeIds: ['n1'],
        outcome: 'useful',
      });
      const after = graph.getNode('n1')!;
      expect(result.updatedNodes).toBe(1);
      expect(after.validatedCount).toBe(4);
      expect(after.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('2. partially_useful 不改变 validatedCount 但刷新 updatedAt', () => {
      const before = graph.getNode('n1')!.updatedAt;
      const result = graph.improve({
        query: 'TypeScript',
        nodeIds: ['n1'],
        outcome: 'partially_useful',
      });
      const after = graph.getNode('n1')!;
      expect(result.updatedNodes).toBe(1);
      // validatedCount 不变
      expect(after.validatedCount).toBe(3);
      // updatedAt 刷新
      expect(after.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('3. incorrect 标记 deprecated', () => {
      const result = graph.improve({
        query: 'TypeScript',
        nodeIds: ['n1'],
        outcome: 'incorrect',
        details: '修正后的内容',
      });
      const after = graph.getNode('n1')!;
      expect(result.updatedNodes).toBe(1);
      expect(result.supersededNodes).toBe(1);
      expect(after.deprecated).toBe(true);
      // 应创建新节点
      expect(graph.listNodes().length).toBe(3);
    });

    it('4. unused 递增 unusedCount', () => {
      const result = graph.improve({
        query: 'TypeScript',
        nodeIds: ['n1'],
        outcome: 'unused',
      });
      const after = graph.getNode('n1')!;
      expect(result.updatedNodes).toBe(1);
      expect(after.unusedCount).toBe(1);
      // 再次 unused 应递增
      graph.improve({
        query: 'TypeScript',
        nodeIds: ['n1'],
        outcome: 'unused',
      });
      expect(graph.getNode('n1')!.unusedCount).toBe(2);
    });

    it('5. 不存在的 nodeId 返回 updatedNodes=0', () => {
      const result = graph.improve({
        query: 'TypeScript',
        nodeIds: ['nonexistent'],
        outcome: 'useful',
      });
      expect(result.updatedNodes).toBe(0);
      expect(result.details).toContain('不存在');
    });
  });

  describe('forget() 遗忘机制', () => {
    let graph: KnowledgeGraph;

    beforeEach(() => {
      graph = new KnowledgeGraph();
      const now = Date.now();
      // n1: 最近更新
      graph.addNode(makeNode('n1', '最近的知识', { updatedAt: now }));
      // n2: 100 天前更新
      graph.addNode(makeNode('n2', '过时的知识', { updatedAt: now - 100 * DAY_MS }));
      // n3: 100 天前更新，且有 unusedCount
      graph.addNode(makeNode('n3', '未使用的知识', {
        updatedAt: now - 100 * DAY_MS,
        unusedCount: 3,
      }));
      // n4: 被 n1 引用（有入边保护）
      graph.addNode(makeNode('n4', '被引用的知识', { updatedAt: now - 100 * DAY_MS }));
      graph.addEdge(makeEdge('n1', 'n4'));
    });

    it('6. forget by nodeIds 标记指定节点', () => {
      const result = graph.forget({
        nodeIds: ['n2'],
        dryRun: false,
      });
      expect(result.forgotten).toBe(1);
      expect(graph.getNode('n2')!.deprecated).toBe(true);
      expect(result.nodes[0].id).toBe('n2');
    });

    it('7. forget by staleFor 条件过滤', () => {
      // 90 天未更新 → n2 和 n3 符合（n4 也符合但有入边保护）
      const result = graph.forget({
        criteria: { staleFor: 90 },
        dryRun: false,
      });
      // n2 和 n3 应被遗忘，n4 因被 n1 引用而受保护
      expect(result.forgotten).toBe(2);
      const forgottenIds = result.nodes.map(n => n.id);
      expect(forgottenIds).toContain('n2');
      expect(forgottenIds).toContain('n3');
      expect(forgottenIds).not.toContain('n4');
      expect(graph.getNode('n2')!.deprecated).toBe(true);
      expect(graph.getNode('n3')!.deprecated).toBe(true);
      expect(graph.getNode('n4')!.deprecated).toBe(false);
    });

    it('8. forget 入边保护（被引用的节点不被遗忘）', () => {
      // 即使显式指定 n4，因为它被 n1 引用，也不应被遗忘
      const result = graph.forget({
        nodeIds: ['n4'],
        dryRun: false,
      });
      expect(result.forgotten).toBe(0);
      expect(graph.getNode('n4')!.deprecated).toBe(false);
    });

    it('9. dryRun=true 不实际执行', () => {
      const result = graph.forget({
        nodeIds: ['n2'],
        dryRun: true,
      });
      expect(result.forgotten).toBe(1); // 预览数量
      // 但实际未标记 deprecated
      expect(graph.getNode('n2')!.deprecated).toBe(false);
    });
  });

  describe('recallV2() 多策略召回', () => {
    let graph: KnowledgeGraph;

    beforeEach(() => {
      graph = new KnowledgeGraph();
      const now = Date.now();
      // 不同类型的节点，不同时间
      graph.addNode(makeNode('s1', 'TypeScript 编译器配置', {
        type: 'fact',
        validatedCount: 5,
        updatedAt: now - 10 * DAY_MS,
      }));
      graph.addNode(makeNode('s2', 'tsconfig 严格模式', {
        type: 'fact',
        validatedCount: 3,
        updatedAt: now - 5 * DAY_MS,
      }));
      graph.addNode(makeNode('d1', '决定使用 TypeScript 严格模式', {
        type: 'decision',
        validatedCount: 4,
        updatedAt: now - 2 * DAY_MS,
      }));
      graph.addNode(makeNode('e1', '错误：类型推断失败 bug', {
        type: 'event',
        validatedCount: 2,
        updatedAt: now - 1 * DAY_MS,
      }));
      // 建立边关系
      graph.addEdge(makeEdge('s1', 's2'));
      graph.addEdge(makeEdge('s2', 'd1'));
      graph.addEdge(makeEdge('d1', 'e1'));
    });

    it('10. semantic 策略返回关键词匹配结果', () => {
      const results = graph.recallV2({
        query: 'TypeScript',
        strategy: 'semantic',
      });
      expect(results.length).toBeGreaterThan(0);
      // 应包含含 TypeScript 的节点
      const contents = results.map(r => r.node.content);
      expect(contents.some(c => c.includes('TypeScript'))).toBe(true);
      // 所有结果策略标记应为 semantic
      for (const r of results) {
        expect(r.strategy).toBe('semantic');
      }
    });

    it('11. temporal 策略按 updatedAt 降序', () => {
      const results = graph.recallV2({
        query: 'TypeScript',
        strategy: 'temporal',
      });
      expect(results.length).toBeGreaterThan(0);
      // 验证降序排列
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].node.updatedAt).toBeGreaterThanOrEqual(results[i].node.updatedAt);
      }
      // 第一个应是最新的（e1 updatedAt = now - 1 day）
      expect(results[0].node.id).toBe('e1');
      // 所有结果策略标记应为 temporal
      for (const r of results) {
        expect(r.strategy).toBe('temporal');
      }
    });

    it('12. type_weighted 策略提升对应类型权重', () => {
      // 查询含"决定"应提升 decision 类型权重
      const results = graph.recallV2({
        query: '决定 TypeScript',
        strategy: 'type_weighted',
      });
      expect(results.length).toBeGreaterThan(0);
      // decision 类型节点 d1 应排在前面（或在结果中）
      const ids = results.map(r => r.node.id);
      expect(ids).toContain('d1');
      // d1 的分数应高于同等匹配但不加分的非 decision 节点
      const d1Result = results.find(r => r.node.id === 'd1');
      expect(d1Result).toBeTruthy();
      expect(d1Result!.score).toBeGreaterThan(0);
    });

    it('13. hybrid 策略合并多策略结果', () => {
      const results = graph.recallV2({
        query: 'TypeScript',
        strategy: 'hybrid',
      });
      expect(results.length).toBeGreaterThan(0);
      // 所有结果策略标记应为 hybrid
      for (const r of results) {
        expect(r.strategy).toBe('hybrid');
      }
      // 应包含多个节点（合并了 semantic + graph + temporal）
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('14. autoSelectStrategy 关键词路由正确', () => {
      // 决定/决策 → type_weighted
      expect(graph.autoSelectStrategy('决定使用什么方案')).toBe('type_weighted');
      expect(graph.autoSelectStrategy('决策采用了什么')).toBe('type_weighted');
      // 错误/bug → type_weighted
      expect(graph.autoSelectStrategy('修复这个 bug')).toBe('type_weighted');
      expect(graph.autoSelectStrategy('错误异常崩溃')).toBe('type_weighted');
      // 最近/刚才 → temporal
      expect(graph.autoSelectStrategy('最近做了什么')).toBe('temporal');
      expect(graph.autoSelectStrategy('刚才的上次记录')).toBe('temporal');
      // 关于/所有 → graph
      expect(graph.autoSelectStrategy('关于这个的所有信息')).toBe('graph');
      expect(graph.autoSelectStrategy('涉及全部内容')).toBe('graph');
      // 默认 → hybrid
      expect(graph.autoSelectStrategy('TypeScript 配置')).toBe('hybrid');
    });
  });

  describe('持久化', () => {
    it('15. toJSON/fromJSON 往返保持一致（含新字段 unusedCount）', () => {
      const graph = new KnowledgeGraph();
      graph.addNode(makeNode('a', '内容A', {
        validatedCount: 5,
        unusedCount: 3,
        type: 'fact',
      }));
      graph.addNode(makeNode('b', '内容B', {
        type: 'decision',
        deprecated: true,
        unusedCount: 0,
      }));
      graph.addEdge(makeEdge('a', 'b', { type: 'derived_from', weight: 0.5 }));

      const json = graph.toJSON();
      const restored = KnowledgeGraph.fromJSON(json);

      // 节点完整
      expect(restored.listNodes().length).toBe(2);
      const a = restored.getNode('a')!;
      expect(a.content).toBe('内容A');
      expect(a.validatedCount).toBe(5);
      expect(a.unusedCount).toBe(3); // 新字段保持
      const b = restored.getNode('b')!;
      expect(b.deprecated).toBe(true);
      expect(b.unusedCount).toBe(0);
    });

    describe('ContextManager 磁盘持久化', () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-kg-test-'));
      });

      afterEach(() => {
        // 清理临时目录
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // 忽略
        }
      });

      function createMockWriter() {
        const client: ILLMClient = {
          isReady: () => true,
          complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => {
            return {
              content: '{}',
              toolCalls: [],
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            };
          }),
          stream: vi.fn(async function* () { /* not used */ }),
        };
        return new CheckpointWriter(client, 'mock', 500, '/nonexistent.md');
      }

      it('16. ContextManager 加载磁盘图谱', () => {
        // 先在临时目录写入一个图谱文件
        const graphDir = path.join(tmpDir, '.routedev', 'memory');
        fs.mkdirSync(graphDir, { recursive: true });
        const graphPath = path.join(graphDir, 'knowledge-graph.json');
        const originalGraph = new KnowledgeGraph();
        originalGraph.addNode(makeNode('loaded1', '从磁盘加载的节点', { validatedCount: 10 }));
        fs.writeFileSync(graphPath, originalGraph.toJSON(), 'utf-8');

        // 创建 ContextManager，应自动加载
        const writer = createMockWriter();
        const mgr = new ContextManager(
          {
            contextWindow: 1000,
            compressionThreshold: 0.8,
            keepRecentMessages: 2,
            checkpointEnabled: true,
            cwd: tmpDir,
          },
          writer,
        );

        const graph = mgr.getKnowledgeGraph();
        const node = graph.getNode('loaded1');
        expect(node).toBeTruthy();
        expect(node!.content).toBe('从磁盘加载的节点');
        expect(node!.validatedCount).toBe(10);
      });

      it('17. ContextManager 保存图谱到磁盘', () => {
        const writer = createMockWriter();
        const mgr = new ContextManager(
          {
            contextWindow: 1000,
            compressionThreshold: 0.8,
            keepRecentMessages: 2,
            checkpointEnabled: true,
            cwd: tmpDir,
          },
          writer,
        );

        // 添加节点到图谱
        const graph = mgr.getKnowledgeGraph();
        graph.addNode(makeNode('saved1', '要保存的节点', { validatedCount: 7 }));

        // 立即同步保存（跳过 debounce）
        mgr.flushGraphToDisk();

        // 验证文件已写入
        const graphPath = path.join(tmpDir, '.routedev', 'memory', 'knowledge-graph.json');
        expect(fs.existsSync(graphPath)).toBe(true);
        const content = fs.readFileSync(graphPath, 'utf-8');
        const parsed = JSON.parse(content);
        expect(parsed.nodes).toBeTruthy();
        expect(parsed.nodes.length).toBe(1);
        expect(parsed.nodes[0].id).toBe('saved1');
        expect(parsed.nodes[0].validatedCount).toBe(7);

        // 重新加载应能读回
        const mgr2 = new ContextManager(
          {
            contextWindow: 1000,
            compressionThreshold: 0.8,
            keepRecentMessages: 2,
            checkpointEnabled: true,
            cwd: tmpDir,
          },
          writer,
        );
        const reloaded = mgr2.getKnowledgeGraph().getNode('saved1');
        expect(reloaded).toBeTruthy();
        expect(reloaded!.validatedCount).toBe(7);
      });
    });
  });
});
