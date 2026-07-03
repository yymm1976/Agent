// tests/skills/kan-obstacle-checker.test.ts
// Phase 68 Task 4: KanObstacleChecker 测试

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProvenanceGraph } from '../../src/memory/provenance-graph.js';
import type { TypedArtifact } from '../../src/memory/provenance-graph.js';
import { KanObstacleChecker } from '../../src/skills/kan-obstacle-checker.js';
import type { InputDependency } from '../../src/skills/kan-obstacle-checker.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

function makeArtifact(id: string, artifactType: string): TypedArtifact {
  return {
    id,
    artifactType: artifactType as any,
    producingOperation: 'retrieval',
    parentIds: [],
    content: `test ${id}`,
    timestamp: Date.now(),
    sessionId: 'test-session',
  };
}

describe('KanObstacleChecker', () => {
  let graph: ProvenanceGraph;

  beforeEach(() => {
    graph = new ProvenanceGraph();
  });

  it('应检测已有制品的类型，不产生障碍', () => {
    graph.addArtifact(makeArtifact('a1', 'decision'));

    const checker = new KanObstacleChecker(graph, { enabled: true, blockOnObstacle: false });
    const result = checker.check([{ requiredType: 'decision', description: '需要决策制品' }]);

    expect(result.hasObstacle).toBe(false);
    expect(result.emptyTypes).toHaveLength(0);
    expect(result.warning).toBe('');
  });

  it('应检测类型存在但无实例的情况，产生障碍', () => {
    const checker = new KanObstacleChecker(graph, { enabled: true, blockOnObstacle: false });
    const result = checker.check([{ requiredType: 'pattern', description: '需要模式制品' }]);

    expect(result.hasObstacle).toBe(true);
    expect(result.emptyTypes).toContain('pattern');
    expect(result.warning).toContain('Kan 障碍');
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('应通过迁运源填充缺失类型，不产生障碍', () => {
    graph.addArtifact(makeArtifact('a1', 'decision'));

    const checker = new KanObstacleChecker(graph, { enabled: true, blockOnObstacle: false });
    const result = checker.check([
      {
        requiredType: 'pattern',
        description: '需要模式制品',
        transportableFrom: ['decision'],
      },
    ]);

    expect(result.hasObstacle).toBe(false);
    expect(result.emptyTypes).toHaveLength(0);
    expect(result.suggestions[0]).toContain('迁运填充');
  });

  it('应检测无制品且无迁运源的情况，产生障碍', () => {
    const checker = new KanObstacleChecker(graph, { enabled: true, blockOnObstacle: false });
    const result = checker.check([
      {
        requiredType: 'pitfall',
        description: '需要陷阱制品',
        transportableFrom: ['pattern'],
      },
    ]);

    expect(result.hasObstacle).toBe(true);
    expect(result.emptyTypes).toContain('pitfall');
    expect(result.warning).toContain('Kan 障碍');
  });

  it('当 blockOnObstacle=true 时应阻止注册', () => {
    const checker = new KanObstacleChecker(graph, { enabled: true, blockOnObstacle: true });
    const decision = checker.checkAndDecide([{ requiredType: 'decision', description: '需要决策制品' }]);

    expect(decision.allowed).toBe(false);
    expect(decision.result.hasObstacle).toBe(true);
  });

  it('当 blockOnObstacle=false 时应允许但警告', () => {
    const checker = new KanObstacleChecker(graph, { enabled: true, blockOnObstacle: false });
    const decision = checker.checkAndDecide([{ requiredType: 'decision', description: '需要决策制品' }]);

    expect(decision.allowed).toBe(true);
    expect(decision.result.hasObstacle).toBe(true);
  });

  it('当 enabled=false 时应始终返回无障碍', () => {
    const checker = new KanObstacleChecker(graph, { enabled: false, blockOnObstacle: false });
    const result = checker.check([{ requiredType: 'decision', description: '需要决策制品' }]);

    expect(result.hasObstacle).toBe(false);
    expect(result.emptyTypes).toHaveLength(0);
    expect(result.warning).toBe('');
    expect(result.suggestions).toHaveLength(0);
  });

  it('应处理多个依赖，部分有障碍部分无障碍', () => {
    graph.addArtifact(makeArtifact('a1', 'decision'));

    const checker = new KanObstacleChecker(graph, { enabled: true, blockOnObstacle: false });
    const result = checker.check([
      { requiredType: 'decision', description: '需要决策制品' },
      { requiredType: 'pattern', description: '需要模式制品' },
      { requiredType: 'pitfall', description: '需要陷阱制品' },
    ]);

    expect(result.hasObstacle).toBe(true);
    expect(result.emptyTypes).toHaveLength(2);
    expect(result.emptyTypes).toContain('pattern');
    expect(result.emptyTypes).toContain('pitfall');
    expect(result.suggestions.length).toBe(2);
  });

  it('空依赖数组应返回无障碍', () => {
    const checker = new KanObstacleChecker(graph, { enabled: true, blockOnObstacle: false });
    const result = checker.check([]);

    expect(result.hasObstacle).toBe(false);
    expect(result.emptyTypes).toHaveLength(0);
    expect(result.warning).toBe('');
    expect(result.suggestions).toHaveLength(0);
  });
});
