// tests/agent/session-status-aggregator.test.ts
// aggregateSessionStatus 单元测试——覆盖 fail-open 降级 / 5 路状态映射 / 截断逻辑 / idle 返回

import { describe, it, expect, vi } from 'vitest';
import { aggregateSessionStatus } from '../../src/agent/session-status-aggregator.js';
import type { PersistedGoal } from '../../src/agent/goal-persistence.js';
import type {
  SessionStatusGoalPersistence,
  SessionStatusBlackboard,
} from '../../src/agent/session-status-aggregator.js';

// ============================================================
// 辅助工厂
// ============================================================

/** 构造一个基础 PersistedGoal */
function makeGoal(overrides: Partial<PersistedGoal> = {}): PersistedGoal {
  return {
    id: 'g1',
    spec: { goal: '实现用户登录功能' } as PersistedGoal['spec'],
    plan: {
      steps: [
        { id: 's1', description: '设计数据库', status: 'completed', dependencies: [] },
        { id: 's2', description: '编写 API', status: 'in_progress', dependencies: ['s1'] },
        { id: 's3', description: '前端对接', status: 'pending', dependencies: ['s2'] },
      ],
    },
    status: 'executing',
    checkpointIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tokenUsed: 5000,
    tokenBudget: 100000,
    ...overrides,
  };
}

/** 构造 mock goalPersistence */
function makeMockPersistence(goal: PersistedGoal | null = makeGoal()): SessionStatusGoalPersistence {
  return {
    load: vi.fn().mockResolvedValue(goal),
    listResumable: vi.fn().mockResolvedValue([]),
  };
}

/** 构造 mock blackboard */
function makeMockBlackboard(
  facts: { key: string; value: string }[] = [],
): SessionStatusBlackboard {
  return {
    getSnapshot: () => ({
      currentGoal: { description: 'test', status: 'executing' },
      completedSteps: [],
      projectFacts: facts,
    }),
  };
}

// ============================================================
// 测试
// ============================================================

describe('aggregateSessionStatus', () => {
  describe('fail-open 降级', () => {
    it('goalPersistence.load 抛错 → 降级为 idle', async () => {
      const persistence: SessionStatusGoalPersistence = {
        load: vi.fn().mockRejectedValue(new Error('磁盘读取失败')),
        listResumable: vi.fn().mockResolvedValue([]),
      };
      const status = await aggregateSessionStatus({
        goalPersistence: persistence,
        currentGoalId: 'g1',
        blackboard: makeMockBlackboard(),
      });
      expect(status.status).toBe('idle');
      expect(status.title).toBe('');
      expect(status.summary).toBe('当前无活跃目标');
    });

    it('blackboard.getSnapshot 抛错 → 事实列表降级为空，但 goal 状态正常返回', async () => {
      const blackboard: SessionStatusBlackboard = {
        getSnapshot: () => {
          throw new Error('黑板读取失败');
        },
      };
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(),
        currentGoalId: 'g1',
        blackboard,
      });
      // goal 仍正常返回（非 idle）
      expect(status.status).not.toBe('idle');
      expect(status.title).toBe('实现用户登录功能');
      // 事实列表降级为空
      expect(status.knownFacts).toEqual([]);
    });

    it('无 currentGoalId → 返回 idle', async () => {
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(),
        currentGoalId: null,
        blackboard: makeMockBlackboard(),
      });
      expect(status.status).toBe('idle');
      expect(status.title).toBe('');
    });

    it('currentGoalId 为空字符串 → 返回 idle', async () => {
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(),
        currentGoalId: '',
        blackboard: makeMockBlackboard(),
      });
      expect(status.status).toBe('idle');
    });

    it('无 goalPersistence → 返回 idle', async () => {
      const status = await aggregateSessionStatus({
        currentGoalId: 'g1',
        blackboard: makeMockBlackboard(),
      });
      expect(status.status).toBe('idle');
    });

    it('goalPersistence.load 返回 null → 返回 idle', async () => {
      const persistence: SessionStatusGoalPersistence = {
        load: vi.fn().mockResolvedValue(null),
        listResumable: vi.fn().mockResolvedValue([]),
      };
      const status = await aggregateSessionStatus({
        goalPersistence: persistence,
        currentGoalId: 'g1',
        blackboard: makeMockBlackboard(),
      });
      expect(status.status).toBe('idle');
    });
  });

  describe('5 路状态映射', () => {
    it('goal.status=executing → status=executing', async () => {
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(makeGoal({ status: 'executing' })),
        currentGoalId: 'g1',
      });
      expect(status.status).toBe('executing');
    });

    it('goal.status=planning → status=executing（映射）', async () => {
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(makeGoal({ status: 'planning' })),
        currentGoalId: 'g1',
      });
      expect(status.status).toBe('executing');
    });

    it('goal.status=paused → status=paused', async () => {
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(makeGoal({ status: 'paused' })),
        currentGoalId: 'g1',
      });
      expect(status.status).toBe('paused');
    });

    it('goal.status=completed → status=completed', async () => {
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(makeGoal({ status: 'completed' })),
        currentGoalId: 'g1',
      });
      expect(status.status).toBe('completed');
    });

    it('goal.status=failed → status=failed', async () => {
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(makeGoal({ status: 'failed' })),
        currentGoalId: 'g1',
      });
      expect(status.status).toBe('failed');
    });

    it('goal.status 为未知值 → status=idle（防御性降级）', async () => {
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(makeGoal({ status: 'unknown_xyz' as any })),
        currentGoalId: 'g1',
      });
      expect(status.status).toBe('idle');
    });
  });

  describe('knownFacts / openQuestions / todos 截断逻辑', () => {
    it('knownFacts 最多 8 条', async () => {
      const facts = Array.from({ length: 12 }, (_, i) => ({
        key: `k${i}`,
        value: `v${i}`,
      }));
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(),
        currentGoalId: 'g1',
        blackboard: makeMockBlackboard(facts),
      });
      expect(status.knownFacts).toHaveLength(8);
      expect(status.knownFacts[0]).toBe('k0: v0');
      expect(status.knownFacts[7]).toBe('k7: v7');
    });

    it('knownFacts 格式为 "key: value"', async () => {
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(),
        currentGoalId: 'g1',
        blackboard: makeMockBlackboard([{ key: 'lang', value: 'TypeScript' }]),
      });
      expect(status.knownFacts).toEqual(['lang: TypeScript']);
    });

    it('openQuestions 最多 8 条（status=blocked 的步骤）', async () => {
      const steps = Array.from({ length: 12 }, (_, i) => ({
        id: `s${i}`,
        description: `阻塞步骤 ${i}`,
        status: 'blocked',
        dependencies: [],
      }));
      const goal = makeGoal({ plan: { steps } });
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(goal),
        currentGoalId: 'g1',
      });
      expect(status.openQuestions).toHaveLength(8);
      expect(status.openQuestions[0]).toBe('阻塞步骤 0');
    });

    it('openQuestions 仅包含 blocked 步骤', async () => {
      const goal = makeGoal({
        plan: {
          steps: [
            { id: 's1', description: '已完成', status: 'completed', dependencies: [] },
            { id: 's2', description: '阻塞中', status: 'blocked', dependencies: [] },
            { id: 's3', description: '进行中', status: 'in_progress', dependencies: [] },
            { id: 's4', description: '也阻塞', status: 'blocked', dependencies: [] },
          ],
        },
      });
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(goal),
        currentGoalId: 'g1',
      });
      expect(status.openQuestions).toEqual(['阻塞中', '也阻塞']);
    });

    it('todos 最多 10 条', async () => {
      const steps = Array.from({ length: 15 }, (_, i) => ({
        id: `s${i}`,
        description: `待办 ${i}`,
        status: 'pending',
        dependencies: [],
      }));
      const goal = makeGoal({ plan: { steps } });
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(goal),
        currentGoalId: 'g1',
      });
      expect(status.todos).toHaveLength(10);
      expect(status.todos[0].text).toBe('待办 0');
    });

    it('todos done 字段映射 completed 状态', async () => {
      const goal = makeGoal({
        plan: {
          steps: [
            { id: 's1', description: '已完成', status: 'completed', dependencies: [] },
            { id: 's2', description: '未完成', status: 'pending', dependencies: [] },
          ],
        },
      });
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(goal),
        currentGoalId: 'g1',
      });
      expect(status.todos).toEqual([
        { text: '已完成', done: true },
        { text: '未完成', done: false },
      ]);
    });
  });

  describe('idle 状态返回', () => {
    it('idle 状态字段完整', async () => {
      const status = await aggregateSessionStatus({});
      expect(status.status).toBe('idle');
      expect(status.title).toBe('');
      expect(status.summary).toBe('当前无活跃目标');
      expect(status.knownFacts).toEqual([]);
      expect(status.openQuestions).toEqual([]);
      expect(status.todos).toEqual([]);
      expect(status.nextAction).toBeNull();
      expect(status.tokenUsed).toBe(0);
      expect(status.tokenBudget).toBe(0);
    });

    it('idle 状态 updatedAt 为有效 ISO 字符串', async () => {
      const status = await aggregateSessionStatus({});
      expect(status.updatedAt).toBeDefined();
      expect(new Date(status.updatedAt).getTime()).not.toBeNaN();
    });
  });

  describe('正常聚合字段', () => {
    it('title 来自 goal.spec.goal', async () => {
      const goal = makeGoal({ spec: { goal: '部署到生产环境' } as any });
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(goal),
        currentGoalId: 'g1',
      });
      expect(status.title).toBe('部署到生产环境');
    });

    it('summary 包含目标描述和完成步数', async () => {
      const goal = makeGoal({
        spec: { goal: '写测试' } as any,
        plan: {
          steps: [
            { id: 's1', description: 'a', status: 'completed', dependencies: [] },
            { id: 's2', description: 'b', status: 'completed', dependencies: [] },
            { id: 's3', description: 'c', status: 'in_progress', dependencies: [] },
          ],
        },
      });
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(goal),
        currentGoalId: 'g1',
      });
      expect(status.summary).toContain('写测试');
      expect(status.summary).toContain('2/3');
    });

    it('nextAction 来自 in_progress 步骤', async () => {
      const goal = makeGoal({
        plan: {
          steps: [
            { id: 's1', description: '已完成步', status: 'completed', dependencies: [] },
            { id: 's2', description: '当前进行中步', status: 'in_progress', dependencies: [] },
          ],
        },
      });
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(goal),
        currentGoalId: 'g1',
      });
      expect(status.nextAction).toBe('当前进行中步');
    });

    it('无 in_progress 步骤时 nextAction 为 null', async () => {
      const goal = makeGoal({
        plan: {
          steps: [
            { id: 's1', description: 'a', status: 'completed', dependencies: [] },
            { id: 's2', description: 'b', status: 'pending', dependencies: [] },
          ],
        },
      });
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(goal),
        currentGoalId: 'g1',
      });
      expect(status.nextAction).toBeNull();
    });

    it('tokenUsed / tokenBudget 来自 goal', async () => {
      const goal = makeGoal({ tokenUsed: 12345, tokenBudget: 67890 });
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(goal),
        currentGoalId: 'g1',
      });
      expect(status.tokenUsed).toBe(12345);
      expect(status.tokenBudget).toBe(67890);
    });

    it('updatedAt 来自 goal.updatedAt（转为 ISO）', async () => {
      const fixedTime = 1700000000000;
      const goal = makeGoal({ updatedAt: fixedTime });
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(goal),
        currentGoalId: 'g1',
      });
      expect(status.updatedAt).toBe(new Date(fixedTime).toISOString());
    });

    it('无 blackboard 时 knownFacts 为空', async () => {
      const status = await aggregateSessionStatus({
        goalPersistence: makeMockPersistence(),
        currentGoalId: 'g1',
        // 不传 blackboard
      });
      expect(status.knownFacts).toEqual([]);
      // 但 goal 状态正常返回
      expect(status.status).toBe('executing');
    });
  });
});
