// tests/skills/sad-decomposer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { decomposeWithSAD } from '../../src/skills/sad-decomposer.js';
import type { SADConfig, AtomicSubTask, SkillMatch } from '../../src/skills/sad-decomposer.js';

const SKILLS = [
  { id: 's1', name: 'code-reviewer', description: 'review code quality', category: 'review' },
  { id: 's2', name: 'test-generator', description: 'generate unit tests', category: 'test' },
  { id: 's3', name: 'refactor-tool', description: 'refactor code structure', category: 'refactor' },
];

function makeSubTask(id: string, desc: string, cat = 'review'): AtomicSubTask {
  return { id, description: desc, expectedSkillCategory: cat };
}

function makeConfig(overrides: Partial<SADConfig> = {}): SADConfig {
  return { maxIterations: 1, convergenceTau: 0.6, inputSideFeedback: true, ...overrides };
}

const alwaysMatchRetrieve = (sub: AtomicSubTask, skills: typeof SKILLS): SkillMatch | null => {
  const s = skills[0];
  return { subTaskId: sub.id, skillId: s.id, skillName: s.name, confidence: 0.8, category: s.category };
};

const neverMatchRetrieve = (_sub: AtomicSubTask, _skills: typeof SKILLS): SkillMatch | null => null;

describe('decomposeWithSAD', () => {
  it('空 D⁽⁰⁾ 直接返回空', async () => {
    const decomposeFn = vi.fn().mockResolvedValue([]);
    const result = await decomposeWithSAD('task', SKILLS, makeConfig(), decomposeFn, alwaysMatchRetrieve);
    expect(result.subTasks).toHaveLength(0);
    expect(result.iterations).toBe(0);
    expect(result.converged).toBe(true);
  });

  it('maxIter=1 只做 two-pass 不再迭代', async () => {
    const sub = makeSubTask('t1', 'review code');
    const decomposeFn = vi.fn().mockResolvedValue([sub]);
    const result = await decomposeWithSAD('review code', SKILLS, makeConfig({ maxIterations: 1 }), decomposeFn, alwaysMatchRetrieve);
    expect(result.iterations).toBe(1);
    expect(result.subTasks).toHaveLength(1);
    expect(decomposeFn).toHaveBeenCalledTimes(1);
  });

  it('Pass2 带 hint 重分解时 decomposeFn 第二参数被传入 hints', async () => {
    const sub1 = makeSubTask('t1', 'review code');
    const sub2 = makeSubTask('t2', 'generate tests', 'test');
    const decomposeFn = vi.fn()
      .mockResolvedValueOnce([sub1])
      .mockResolvedValueOnce([sub2]);
    const result = await decomposeWithSAD(
      'review and test code',
      SKILLS,
      makeConfig({ maxIterations: 2 }),
      decomposeFn,
      alwaysMatchRetrieve,
    );
    expect(decomposeFn).toHaveBeenCalledTimes(2);
    const secondCallHints = decomposeFn.mock.calls[1][1];
    expect(Array.isArray(secondCallHints)).toBe(true);
    expect(secondCallHints!.length).toBeGreaterThan(0);
    expect(result.iterations).toBe(2);
  });

  it('Jaccard > τ 时提前收敛，不耗尽 maxIter', async () => {
    const sub = makeSubTask('t1', 'review code');
    let callCount = 0;
    const decomposeFn = vi.fn().mockImplementation(async (_task: string, hints?: string[]) => {
      callCount++;
      return [sub];
    });
    const result = await decomposeWithSAD(
      'review code',
      SKILLS,
      makeConfig({ maxIterations: 5, convergenceTau: 0.6 }),
      decomposeFn,
      alwaysMatchRetrieve,
    );
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThan(5);
  });

  it('重分解失败 fail-open：保留 Pass1 结果，converged=false', async () => {
    const sub = makeSubTask('t1', 'review code');
    const decomposeFn = vi.fn()
      .mockResolvedValueOnce([sub])
      .mockRejectedValueOnce(new Error('LLM timeout'));
    const result = await decomposeWithSAD(
      'review code',
      SKILLS,
      makeConfig({ maxIterations: 3 }),
      decomposeFn,
      alwaysMatchRetrieve,
    );
    expect(result.converged).toBe(false);
    expect(result.subTasks).toContain(sub);
  });

  it('inputSideFeedback=false 时降级，不传 hints', async () => {
    const sub = makeSubTask('t1', 'review code');
    const decomposeFn = vi.fn().mockResolvedValue([sub]);
    const result = await decomposeWithSAD(
      'review code',
      SKILLS,
      makeConfig({ inputSideFeedback: false }),
      decomposeFn,
      alwaysMatchRetrieve,
    );
    expect(decomposeFn).toHaveBeenCalledTimes(1);
    expect(decomposeFn.mock.calls[0][1]).toBeUndefined();
    expect(result.converged).toBe(true);
  });

  it('retrieveFn 无命中时 hint set 为空，hintJaccard 记录 0', async () => {
    const sub = makeSubTask('t1', 'unknown task');
    const decomposeFn = vi.fn().mockResolvedValue([sub]);
    const result = await decomposeWithSAD(
      'unknown task',
      SKILLS,
      makeConfig({ maxIterations: 2 }),
      decomposeFn,
      neverMatchRetrieve,
    );
    expect(result.hintJaccard[0]).toBe(0);
  });

  it('有限技能库保证有限轮收敛（不动点保证）', async () => {
    const subs = [makeSubTask('t1', 'review'), makeSubTask('t2', 'test')];
    const decomposeFn = vi.fn().mockResolvedValue(subs);
    const result = await decomposeWithSAD(
      'review and test',
      SKILLS,
      makeConfig({ maxIterations: 10, convergenceTau: 0.5 }),
      decomposeFn,
      alwaysMatchRetrieve,
    );
    expect(result.iterations).toBeLessThanOrEqual(10);
    expect(result.subTasks.length).toBeGreaterThan(0);
  });

  it('hintJaccard 历史长度与迭代轮数一致', async () => {
    const sub = makeSubTask('t1', 'review code');
    const decomposeFn = vi.fn().mockResolvedValue([sub]);
    const result = await decomposeWithSAD(
      'review code',
      SKILLS,
      makeConfig({ maxIterations: 3 }),
      decomposeFn,
      alwaysMatchRetrieve,
    );
    expect(result.hintJaccard.length).toBe(result.iterations);
  });
});
