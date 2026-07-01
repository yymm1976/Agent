// tests/skills/compositional-router.test.ts
// Phase 52 Task 4 单元测试：组合技能路由（decompose-retrieve-compose 框架）
//
// 覆盖：
//   1. decomposeWithSkillAwareness 复杂任务被分解为原子子任务
//   2. decomposeWithSkillAwareness SAD 迭代后未覆盖子任务重新分解
//   3. retrieveSkill 关键词匹配返回最匹配 Skill
//   4. retrieveSkill CJK bigram 检索（中文任务描述）
//   5. composeDAG 依赖关系正确（无环）
//   6. composeDAG 并行组识别（无依赖冲突）
//   7. topologicalSort 拓扑排序正确（A→B→C 输出 [A,B,C]）
//   8. hasCycle 循环依赖检测
//
// 使用 vi.fn() 创建 mock decomposeFn。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  decomposeWithSkillAwareness,
  retrieveSkill,
  composeDAG,
  topologicalSort,
  hasCycle,
  DEFAULT_ROUTING_CONFIG,
  type AtomicSubTask,
  type SkillMatch,
  type SkillDAGPlan,
  type SkillDAGNode,
  type CompositionalRoutingConfig,
} from '../../src/skills/compositional-router.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建一个 Skill 描述对象 */
function makeSkill(
  id: string,
  name: string,
  description: string,
  category: string,
): { id: string; name: string; description: string; category: string } {
  return { id, name, description, category };
}

/** 创建一个原子子任务 */
function makeSubTask(id: string, description: string, category = ''): AtomicSubTask {
  return { id, description, expectedSkillCategory: category };
}

/** 创建一个 SkillMatch */
function makeMatch(subTaskId: string, skillId: string, category: string, confidence = 0.8): SkillMatch {
  return {
    subTaskId,
    skillId,
    skillName: `skill-${skillId}`,
    confidence,
    category,
  };
}

/** 创建一个 DAG 节点（用于拓扑/环测试） */
function makeNode(id: string, category = 'default'): SkillDAGNode {
  return {
    id,
    subTask: makeSubTask(id, `task ${id}`, category),
    skillMatch: makeMatch(id, id, category),
    status: 'pending',
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 52 Task 4: compositional-router 单元测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----------------------------------------------------------
  // 1. decomposeWithSkillAwareness 复杂任务被分解为原子子任务
  // ----------------------------------------------------------

  it('1.1 decomposeWithSkillAwareness 复杂任务被分解为原子子任务', async () => {
    const decomposeFn = vi.fn(async () => [
      makeSubTask('sub-1', 'review the authentication code'),
      makeSubTask('sub-2', 'refactor the database access layer'),
    ]);
    const skills = [
      makeSkill('s1', 'code-reviewer', 'review code for issues', 'code-review'),
      makeSkill('s2', 'refactor', 'refactor code structure', 'refactor'),
    ];

    const result = await decomposeWithSkillAwareness(
      'review and refactor',
      skills,
      DEFAULT_ROUTING_CONFIG,
      decomposeFn,
    );

    expect(result.length).toBe(2);
    expect(decomposeFn).toHaveBeenCalledTimes(1);
    expect(decomposeFn).toHaveBeenCalledWith('review and refactor');
    expect(result[0].id).toBe('sub-1');
    expect(result[1].id).toBe('sub-2');
  });

  it('1.2 decomposeWithSkillAwareness decomposeFn 返回空数组时返回空', async () => {
    const decomposeFn = vi.fn(async () => [] as AtomicSubTask[]);
    const result = await decomposeWithSkillAwareness(
      'simple task',
      [makeSkill('s1', 'a', 'b', 'c')],
      DEFAULT_ROUTING_CONFIG,
      decomposeFn,
    );
    expect(result.length).toBe(0);
  });

  // ----------------------------------------------------------
  // 2. decomposeWithSkillAwareness SAD 迭代后未覆盖子任务重新分解
  // ----------------------------------------------------------

  it('1.3 SAD 迭代后未覆盖子任务重新分解（maxDecompositionIterations=2）', async () => {
    // 第 1 轮：返回 2 个子任务，第 2 个无法匹配任何 Skill
    // 第 2 轮：对第 2 个重新分解为 2 个更细的子任务
    let callCount = 0;
    const decomposeFn = vi.fn(async (task: string) => {
      callCount++;
      if (callCount === 1) {
        // 第 1 轮：第 1 个能匹配，第 2 个不能（关键词完全不重合）
        return [
          makeSubTask('sub-1', 'review code', 'code-review'),
          makeSubTask('sub-2', 'unmatched task xyz12345', 'unknown-cat'),
        ];
      }
      // 第 2 轮（重新分解 sub-2）
      expect(task).toBe('unmatched task xyz12345');
      return [
        makeSubTask('sub-2.a', 'review code part a', 'code-review'),
        makeSubTask('sub-2.b', 'review code part b', 'code-review'),
      ];
    });
    const skills = [makeSkill('s1', 'code-reviewer', 'review code', 'code-review')];

    const config: CompositionalRoutingConfig = {
      maxDecompositionIterations: 2,
      semanticRetrieval: true,
      maxParallelSkills: 2,
    };
    const result = await decomposeWithSkillAwareness('complex task', skills, config, decomposeFn);

    // 第 1 个子任务保留（sub-1），第 2 个被重新分解为 sub-2.a / sub-2.b
    expect(result.length).toBe(3);
    expect(decomposeFn).toHaveBeenCalledTimes(2);
    // 重新分解出的子任务 ID 应加上父任务 ID 前缀
    const ids = result.map((r) => r.id);
    expect(ids).toContain('sub-1');
    expect(ids.some((id) => id.startsWith('sub-2.'))).toBe(true);
  });

  it('1.4 SAD 全部子任务都匹配时不再迭代', async () => {
    const decomposeFn = vi.fn(async () => [
      makeSubTask('sub-1', 'review code', 'code-review'),
      makeSubTask('sub-2', 'refactor code', 'refactor'),
    ]);
    const skills = [
      makeSkill('s1', 'code-reviewer', 'review code', 'code-review'),
      makeSkill('s2', 'refactor', 'refactor code', 'refactor'),
    ];
    const config: CompositionalRoutingConfig = {
      maxDecompositionIterations: 3,
      semanticRetrieval: true,
      maxParallelSkills: 2,
    };
    await decomposeWithSkillAwareness('complex', skills, config, decomposeFn);
    // 全部匹配 → 只调用 1 次
    expect(decomposeFn).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------
  // 3. retrieveSkill 关键词匹配返回最匹配 Skill
  // ----------------------------------------------------------

  it('2.1 retrieveSkill 关键词匹配返回最匹配 Skill', () => {
    const sub = makeSubTask('sub-1', 'review the code', 'code-review');
    const skills = [
      makeSkill('s1', 'test-generator', 'generate test cases', 'test'),
      makeSkill('s2', 'code-reviewer', 'review code for issues', 'code-review'),
      makeSkill('s3', 'refactor', 'refactor code structure', 'refactor'),
    ];
    const match = retrieveSkill(sub, skills);
    expect(match).not.toBeNull();
    expect(match!.skillId).toBe('s2');
    expect(match!.category).toBe('code-review');
    expect(match!.confidence).toBeGreaterThan(0);
    expect(match!.subTaskId).toBe('sub-1');
  });

  it('2.2 retrieveSkill 无匹配时返回 null', () => {
    const sub = makeSubTask('sub-1', 'xyz12345', 'unknown');
    const skills = [
      makeSkill('s1', 'code-reviewer', 'review code', 'code-review'),
    ];
    const match = retrieveSkill(sub, skills);
    expect(match).toBeNull();
  });

  it('2.3 retrieveSkill 空描述或空 Skill 列表时返回 null', () => {
    expect(retrieveSkill(makeSubTask('x', '', 'c'), [])).toBeNull();
    expect(retrieveSkill(makeSubTask('x', '', 'c'), [makeSkill('s', 'a', 'b', 'c')])).toBeNull();
  });

  // ----------------------------------------------------------
  // 4. retrieveSkill CJK bigram 检索（中文任务描述）
  // ----------------------------------------------------------

  it('2.4 retrieveSkill CJK bigram 检索（中文任务描述命中中文 Skill）', () => {
    // 中文任务描述 + 中文 Skill 描述 → 应通过 bigram 匹配命中
    const sub = makeSubTask('sub-cn', '审查代码并修复', 'code-review');
    const skills = [
      makeSkill('s1', '代码审查器', '审查代码，发现代码中的问题', 'code-review'),
      makeSkill('s2', '测试生成器', '生成测试用例', 'test'),
    ];
    const match = retrieveSkill(sub, skills);
    expect(match).not.toBeNull();
    expect(match!.skillId).toBe('s1');
    expect(match!.confidence).toBeGreaterThan(0);
  });

  it('2.5 retrieveSkill 中英文混合任务描述也能匹配', () => {
    const sub = makeSubTask('sub-mix', 'review 代码', 'code-review');
    const skills = [
      makeSkill('s1', 'code-reviewer', 'review 代码', 'code-review'),
    ];
    const match = retrieveSkill(sub, skills);
    expect(match).not.toBeNull();
    expect(match!.skillId).toBe('s1');
  });

  // ----------------------------------------------------------
  // 5. composeDAG 依赖关系正确（无环）
  // ----------------------------------------------------------

  it('3.1 composeDAG 依赖关系正确（同类 Skill 串行 control 边，无环）', () => {
    // 两个同类 Skill 匹配 → 应有 1 条 control 边
    const matches = [
      makeMatch('sub-1', 's1', 'code-review'),
      makeMatch('sub-2', 's2', 'code-review'),
    ];
    const subTasks = [
      makeSubTask('sub-1', 'review part 1', 'code-review'),
      makeSubTask('sub-2', 'review part 2', 'code-review'),
    ];
    const plan = composeDAG(matches, subTasks);

    expect(plan.nodes.length).toBe(2);
    expect(plan.edges.length).toBe(1);
    expect(plan.edges[0].from).toBe('sub-1');
    expect(plan.edges[0].to).toBe('sub-2');
    expect(plan.edges[0].dependencyType).toBe('control');
    // 无环
    expect(hasCycle(plan)).toBe(false);
  });

  it('3.2 composeDAG 不同类 Skill 默认并行（无边）', () => {
    const matches = [
      makeMatch('sub-1', 's1', 'code-review'),
      makeMatch('sub-2', 's2', 'refactor'),
    ];
    const subTasks = [
      makeSubTask('sub-1', 'review code', 'code-review'),
      makeSubTask('sub-2', 'refactor code', 'refactor'),
    ];
    const plan = composeDAG(matches, subTasks);

    expect(plan.nodes.length).toBe(2);
    expect(plan.edges.length).toBe(0);
  });

  it('3.3 composeDAG 数据依赖提示词触发 data 边', () => {
    // 后继子任务描述包含"基于" → 视为依赖前驱
    const matches = [
      makeMatch('sub-1', 's1', 'code-review'),
      makeMatch('sub-2', 's2', 'refactor'),
    ];
    const subTasks = [
      makeSubTask('sub-1', 'review the code', 'code-review'),
      makeSubTask('sub-2', '基于 review 结果重构', 'refactor'),
    ];
    const plan = composeDAG(matches, subTasks);

    expect(plan.edges.length).toBe(1);
    expect(plan.edges[0].dependencyType).toBe('data');
    expect(plan.edges[0].from).toBe('sub-1');
    expect(plan.edges[0].to).toBe('sub-2');
  });

  // ----------------------------------------------------------
  // 6. composeDAG 并行组识别（无依赖冲突）
  // ----------------------------------------------------------

  it('3.4 composeDAG 并行组识别（无依赖冲突的节点分到同一层）', () => {
    // 4 个节点：A/B/C/D，A→C, B→D（不同类串行组）
    // 第 1 层应包含 A 和 B（互不依赖），第 2 层应包含 C 和 D
    const matches = [
      makeMatch('A', 's1', 'cat-a'),
      makeMatch('B', 's2', 'cat-b'),
      makeMatch('C', 's1', 'cat-a'),
      makeMatch('D', 's2', 'cat-b'),
    ];
    const subTasks = [
      makeSubTask('A', 'do a', 'cat-a'),
      makeSubTask('B', 'do b', 'cat-b'),
      makeSubTask('C', 'do c', 'cat-a'),
      makeSubTask('D', 'do d', 'cat-b'),
    ];
    const plan = composeDAG(matches, subTasks);

    expect(plan.parallelGroups.length).toBe(2);
    // 第 1 层：A 和 B
    expect(plan.parallelGroups[0].map((n) => n.id).sort()).toEqual(['A', 'B']);
    // 第 2 层：C 和 D
    expect(plan.parallelGroups[1].map((n) => n.id).sort()).toEqual(['C', 'D']);
  });

  // ----------------------------------------------------------
  // 7. topologicalSort 拓扑排序正确（A→B→C 输出 [A,B,C]）
  // ----------------------------------------------------------

  it('4.1 topologicalSort 拓扑排序正确（A→B→C 输出 [A,B,C]）', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const edges = [
      { from: 'A', to: 'B', dependencyType: 'control' as const },
      { from: 'B', to: 'C', dependencyType: 'control' as const },
    ];
    const plan: SkillDAGPlan = { nodes, edges, parallelGroups: [] };

    const groups = topologicalSort(plan);
    // 3 层（每层 1 个节点）
    expect(groups.length).toBe(3);
    expect(groups[0][0].id).toBe('A');
    expect(groups[1][0].id).toBe('B');
    expect(groups[2][0].id).toBe('C');
  });

  it('4.2 topologicalSort 无依赖时所有节点都在第 1 层', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const plan: SkillDAGPlan = { nodes, edges: [], parallelGroups: [] };

    const groups = topologicalSort(plan);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(3);
  });

  it('4.3 topologicalSort 空节点返回空数组', () => {
    const plan: SkillDAGPlan = { nodes: [], edges: [], parallelGroups: [] };
    expect(topologicalSort(plan)).toEqual([]);
  });

  // ----------------------------------------------------------
  // 8. hasCycle 循环依赖检测
  // ----------------------------------------------------------

  it('5.1 hasCycle 无环 DAG 返回 false', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const edges = [
      { from: 'A', to: 'B', dependencyType: 'control' as const },
      { from: 'B', to: 'C', dependencyType: 'control' as const },
    ];
    const plan: SkillDAGPlan = { nodes, edges, parallelGroups: [] };
    expect(hasCycle(plan)).toBe(false);
  });

  it('5.2 hasCycle 有环 DAG 返回 true（A→B→C→A）', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const edges = [
      { from: 'A', to: 'B', dependencyType: 'control' as const },
      { from: 'B', to: 'C', dependencyType: 'control' as const },
      { from: 'C', to: 'A', dependencyType: 'control' as const }, // 回边 → 环
    ];
    const plan: SkillDAGPlan = { nodes, edges, parallelGroups: [] };
    expect(hasCycle(plan)).toBe(true);
  });

  it('5.3 hasCycle 自环返回 true', () => {
    const nodes = [makeNode('A')];
    const edges = [
      { from: 'A', to: 'A', dependencyType: 'control' as const },
    ];
    const plan: SkillDAGPlan = { nodes, edges, parallelGroups: [] };
    expect(hasCycle(plan)).toBe(true);
  });

  it('5.4 hasCycle 空节点返回 false', () => {
    const plan: SkillDAGPlan = { nodes: [], edges: [], parallelGroups: [] };
    expect(hasCycle(plan)).toBe(false);
  });
});
