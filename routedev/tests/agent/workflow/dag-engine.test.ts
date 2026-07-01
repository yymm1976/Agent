// tests/agent/workflow/dag-engine.test.ts
// DagEngine 单元测试
// 覆盖：拓扑排序、循环依赖检测、分层并行执行、变量替换、重试与阈值跳过

import { describe, it, expect, vi } from 'vitest';
import {
  DagEngine,
  type DagNode,
  type DagWorkflow,
} from '../../../src/agent/workflow/dag-engine.js';

/** 构造无依赖单节点 */
function makeNode(id: string, action = '', dependsOn: string[] = []): DagNode {
  return { id, action, dependsOn };
}

describe('DagEngine', () => {
  // ============================================================
  // layeredSort
  // ============================================================
  describe('layeredSort', () => {
    it('同层无依赖节点分到同一层', () => {
      const engine = new DagEngine();
      const nodes = [
        makeNode('A'),
        makeNode('B'),
        makeNode('C', '', ['A']),
      ];
      const layers = engine.layeredSort(nodes);
      expect(layers).not.toBeNull();
      expect(layers!.length).toBe(2);
      expect(layers![0].map(n => n.id).sort()).toEqual(['A', 'B']);
      expect(layers![1].map(n => n.id)).toEqual(['C']);
    });

    it('循环依赖返回 null', () => {
      const engine = new DagEngine();
      const nodes = [
        makeNode('A', '', ['B']),
        makeNode('B', '', ['A']),
      ];
      expect(engine.layeredSort(nodes)).toBeNull();
    });

    it('链式依赖每层一个节点', () => {
      const engine = new DagEngine();
      const nodes = [
        makeNode('A'),
        makeNode('B', '', ['A']),
        makeNode('C', '', ['B']),
      ];
      const layers = engine.layeredSort(nodes);
      expect(layers).not.toBeNull();
      expect(layers!.length).toBe(3);
      expect(layers![0].map(n => n.id)).toEqual(['A']);
      expect(layers![1].map(n => n.id)).toEqual(['B']);
      expect(layers![2].map(n => n.id)).toEqual(['C']);
    });
  });

  // ============================================================
  // resolveVariables
  // ============================================================
  describe('resolveVariables', () => {
    it('{{variable}} 替换为对应值', () => {
      const engine = new DagEngine();
      const result = engine.resolveVariables('Hello {{name}}!', { name: 'RouteDev' });
      expect(result).toBe('Hello RouteDev!');
    });

    it('多个变量同时替换', () => {
      const engine = new DagEngine();
      const result = engine.resolveVariables(
        '{{greeting}}, {{name}}. Task: {{task}}',
        { greeting: '你好', name: '杨铭', task: '实现 DAG' },
      );
      expect(result).toBe('你好, 杨铭. Task: 实现 DAG');
    });

    it('未定义变量替换为空字符串', () => {
      const engine = new DagEngine();
      const result = engine.resolveVariables('val=[{{missing}}]', {});
      expect(result).toBe('val=[]');
    });

    it('null 值替换为空字符串', () => {
      const engine = new DagEngine();
      const result = engine.resolveVariables('x={{y}}', { y: null });
      expect(result).toBe('x=');
    });

    it('支持变量名两侧空白 {{ name }}', () => {
      const engine = new DagEngine();
      const result = engine.resolveVariables('Hello {{ name }}!', { name: 'X' });
      expect(result).toBe('Hello X!');
    });

    it('数字类型变量被 String() 转换', () => {
      const engine = new DagEngine();
      const result = engine.resolveVariables('count={{n}}', { n: 42 });
      expect(result).toBe('count=42');
    });

    it('无模板的字符串原样返回', () => {
      const engine = new DagEngine();
      const result = engine.resolveVariables('plain text', { foo: 'bar' });
      expect(result).toBe('plain text');
    });
  });

  // ============================================================
  // execute
  // ============================================================
  describe('execute', () => {
    it('同层独立节点 A, B 都被执行（并行）', async () => {
      const engine = new DagEngine();
      const executor = vi.fn(async (node: DagNode) => `result-${node.id}`);
      const workflow: DagWorkflow = {
        nodes: [makeNode('A', 'a'), makeNode('B', 'b')],
        variables: {},
      };
      const result = await engine.execute(workflow, executor);
      // A、B 无依赖，应都在第 0 层并行执行
      expect(executor).toHaveBeenCalledTimes(2);
      expect(executor).toHaveBeenCalledWith(expect.objectContaining({ id: 'A' }), 'a');
      expect(executor).toHaveBeenCalledWith(expect.objectContaining({ id: 'B' }), 'b');
      expect(result.failedNodes).toEqual([]);
      expect(result.executionOrder.sort()).toEqual(['A', 'B']);
      expect(result.results.get('A')).toBe('result-A');
      expect(result.results.get('B')).toBe('result-B');
    });

    it('链式依赖按拓扑序执行 A→B→C', async () => {
      const engine = new DagEngine();
      const callOrder: string[] = [];
      const executor = vi.fn(async (node: DagNode) => {
        callOrder.push(node.id);
        return `done-${node.id}`;
      });
      const workflow: DagWorkflow = {
        nodes: [
          makeNode('A', 'a'),
          makeNode('B', 'b', ['A']),
          makeNode('C', 'c', ['B']),
        ],
        variables: {},
      };
      const result = await engine.execute(workflow, executor);
      expect(result.executionOrder).toEqual(['A', 'B', 'C']);
      expect(callOrder).toEqual(['A', 'B', 'C']);
      expect(result.failedNodes).toEqual([]);
    });

    it('执行时对 action 做变量替换', async () => {
      const engine = new DagEngine();
      const executor = vi.fn(async (_node: DagNode, action: string) => action);
      const workflow: DagWorkflow = {
        nodes: [makeNode('A', 'Hello {{name}}!')],
        variables: { name: 'World' },
      };
      const result = await engine.execute(workflow, executor);
      expect(executor).toHaveBeenCalledWith(expect.anything(), 'Hello World!');
      expect(result.results.get('A')).toBe('Hello World!');
    });

    it('节点级 variables 覆盖工作流级 variables', async () => {
      const engine = new DagEngine();
      const executor = vi.fn(async (_node: DagNode, action: string) => action);
      const workflow: DagWorkflow = {
        nodes: [
          {
            id: 'A',
            dependsOn: [],
            action: 'lang={{lang}}',
            variables: { lang: 'TypeScript' },
          },
        ],
        variables: { lang: 'JavaScript' },
      };
      const result = await engine.execute(workflow, executor);
      expect(executor).toHaveBeenCalledWith(expect.anything(), 'lang=TypeScript');
      expect(result.results.get('A')).toBe('lang=TypeScript');
    });

    it('失败重试 retryLimit 次后仍失败 → 记录到 failedNodes', async () => {
      const engine = new DagEngine({ retryLimit: 2, humanEscalationThreshold: 99 });
      const executor = vi.fn(async () => {
        throw new Error('boom');
      });
      const workflow: DagWorkflow = {
        nodes: [makeNode('A', 'a')],
        variables: {},
      };
      const result = await engine.execute(workflow, executor);
      // 初始 1 + retryLimit 2 = 3 次尝试
      expect(executor).toHaveBeenCalledTimes(3);
      expect(result.failedNodes).toEqual(['A']);
      expect(result.executionOrder).toEqual([]);
      expect(result.results.size).toBe(0);
    });

    it('失败后重试成功 → 不进入 failedNodes', async () => {
      const engine = new DagEngine({ retryLimit: 2 });
      let calls = 0;
      const executor = vi.fn(async (node: DagNode) => {
        calls += 1;
        if (calls < 3) throw new Error('retry me');
        return `ok-${node.id}`;
      });
      const workflow: DagWorkflow = {
        nodes: [makeNode('A', 'a')],
        variables: {},
      };
      const result = await engine.execute(workflow, executor);
      expect(executor).toHaveBeenCalledTimes(3);
      expect(result.failedNodes).toEqual([]);
      expect(result.executionOrder).toEqual(['A']);
      expect(result.results.get('A')).toBe('ok-A');
    });

    it('累计失败次数达 humanEscalationThreshold → 第二次 execute 跳过该节点', async () => {
      // retryLimit=2, humanEscalationThreshold=3
      // 第一次 execute：3 次失败，failureCounts['A'] = 3
      // 第二次 execute：阈值已达到 → 跳过，executor 不再调用
      const engine = new DagEngine({ retryLimit: 2, humanEscalationThreshold: 3 });
      const executor = vi.fn(async () => {
        throw new Error('always fails');
      });
      const workflow: DagWorkflow = {
        nodes: [makeNode('A', 'a')],
        variables: {},
      };
      const r1 = await engine.execute(workflow, executor);
      expect(r1.failedNodes).toEqual(['A']);
      expect(executor).toHaveBeenCalledTimes(3);

      const beforeSecond = executor.mock.calls.length;
      const r2 = await engine.execute(workflow, executor);
      // 阈值已达到 → 直接跳过，不调用 executor
      expect(executor.mock.calls.length).toBe(beforeSecond);
      expect(r2.failedNodes).toEqual(['A']);
      expect(r2.executionOrder).toEqual([]);
    });

    it('工作流存在环 → 全部节点失败，executor 不被调用', async () => {
      const engine = new DagEngine();
      const executor = vi.fn(async () => 'should not run');
      const workflow: DagWorkflow = {
        nodes: [
          makeNode('A', 'a', ['B']),
          makeNode('B', 'b', ['A']),
        ],
        variables: {},
      };
      const result = await engine.execute(workflow, executor);
      expect(executor).not.toHaveBeenCalled();
      expect(result.failedNodes.sort()).toEqual(['A', 'B']);
      expect(result.executionOrder).toEqual([]);
    });

    it('空工作流返回空结果', async () => {
      const engine = new DagEngine();
      const executor = vi.fn(async () => 'x');
      const result = await engine.execute({ nodes: [], variables: {} }, executor);
      expect(executor).not.toHaveBeenCalled();
      expect(result.results.size).toBe(0);
      expect(result.executionOrder).toEqual([]);
      expect(result.failedNodes).toEqual([]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('maxParallel 限制同层并发批次大小', async () => {
      // 5 个无依赖节点 + maxParallel=2 → 至少 3 批（2+2+1）
      // 用执行时间戳验证并发受控
      const engine = new DagEngine({ maxParallel: 2 });
      const startTimes: Record<string, number> = {};
      const executor = vi.fn(async (node: DagNode) => {
        startTimes[node.id] = Date.now();
        await new Promise(resolve => setTimeout(resolve, 20));
        return node.id;
      });
      const workflow: DagWorkflow = {
        nodes: ['A', 'B', 'C', 'D', 'E'].map(id => makeNode(id, id)),
        variables: {},
      };
      const result = await engine.execute(workflow, executor);
      expect(result.executionOrder.sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect(result.failedNodes).toEqual([]);
      // 至少执行了 3 批（如果完全无并发限制会 1 批完成）
      // 验证：第一批 A、B 同时开始；第三批（最后 1 个）开始时间晚于第一批结束
      const firstBatchStart = Math.min(startTimes['A'], startTimes['B']);
      const lastStart = startTimes['E'];
      expect(lastStart).toBeGreaterThanOrEqual(firstBatchStart + 15); // 后续批次晚于第一批
    });
  });
});
