// tests/agent/patterns/reflection.test.ts
// Phase 49 Task 6.5：反思模式单元测试
//
// 覆盖蓝图 6.5 节测试要求：
//   1. ReflectionPattern 审查不通过时自动修正
//   2. 达到 maxReflections 时终止
//   3. 审查通过直接输出（不修正）
//   4. 初始即通过 iteration=0（额外覆盖）
//   5. maxReflections=0 只审查不修正（额外覆盖）

import { describe, it, expect, vi } from 'vitest';
import {
  ReflectionPattern,
  type ReflectionParams,
  type ReflectionEvent,
  type ReviewResult,
} from '../../../src/agent/patterns/reflection.js';

// ============================================================
// 辅助函数
// ============================================================

/** 收集所有 ReflectionEvent */
async function collectEvents(
  gen: AsyncGenerator<ReflectionEvent>,
): Promise<ReflectionEvent[]> {
  const events: ReflectionEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** 构造通过的审查结果 */
function passReview(reasoning: string = '通过'): ReviewResult {
  return { passed: true, issues: [], reasoning };
}

/** 构造不通过的审查结果 */
function failReview(issues: string[], reasoning: string = '不通过'): ReviewResult {
  return { passed: false, issues, reasoning };
}

// ============================================================
// 测试套件
// ============================================================

describe('ReflectionPattern (Phase 49 Task 6.5)', () => {
  // ============================================================
  // 测试 1：审查不通过时自动修正
  // ============================================================
  it('1. ReflectionPattern 审查不通过时自动修正', async () => {
    // 第一次审查不通过，第二次通过
    const reviewResults: ReviewResult[] = [
      failReview(['缺少边界情况处理'], '初次审查不通过'),
      passReview('修正后通过'),
    ];
    let reviewIdx = 0;
    const review = vi.fn(async () => reviewResults[reviewIdx++]);

    const revise = vi.fn(async (output: string, issues: string[]) => {
      // 修正：把 issues 拼到 output 后面
      return `${output}\n[已修正] ${issues.join('; ')}`;
    });

    const pattern = new ReflectionPattern(review, revise);
    const params: ReflectionParams = {
      initialOutput: '初始输出',
      criteria: '必须覆盖所有边界情况',
      maxReflections: 3,
    };

    const events = await collectEvents(pattern.run(params));

    // 应该有 1 个 reflection-iteration + 1 个 reflection-passed
    const iterations = events.filter(e => e.type === 'reflection-iteration');
    const passed = events.filter(e => e.type === 'reflection-passed');
    expect(iterations).toHaveLength(1);
    expect(passed).toHaveLength(1);

    // iteration 事件：iteration=1，包含修正后的输出
    if (iterations[0].type === 'reflection-iteration') {
      expect(iterations[0].iteration).toBe(1);
      expect(iterations[0].output).toContain('[已修正]');
      expect(iterations[0].issues).toContain('缺少边界情况处理');
    }

    // passed 事件：iteration=1（第一次修正后通过）
    if (passed[0].type === 'reflection-passed') {
      expect(passed[0].iteration).toBe(1);
      expect(passed[0].output).toContain('[已修正]');
    }

    // review 应该被调用 2 次（初次 + 修正后）
    expect(review).toHaveBeenCalledTimes(2);
    // revise 应该被调用 1 次
    expect(revise).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 测试 2：达到 maxReflections 时终止
  // ============================================================
  it('2. 达到 maxReflections 时终止并输出 reflection-exhausted', async () => {
    // 永远不通过
    const review = vi.fn(async () =>
      failReview(['一直有问题'], '始终不通过'),
    );
    const revise = vi.fn(async (output: string, issues: string[]) => {
      return `${output} → 修正${issues.length}`;
    });

    const pattern = new ReflectionPattern(review, revise);
    const params: ReflectionParams = {
      initialOutput: '初始',
      criteria: '严格标准',
      maxReflections: 2,
    };

    const events = await collectEvents(pattern.run(params));

    // 应该有 maxReflections 个 reflection-iteration + 1 个 reflection-exhausted
    const iterations = events.filter(e => e.type === 'reflection-iteration');
    const exhausted = events.filter(e => e.type === 'reflection-exhausted');
    const passed = events.filter(e => e.type === 'reflection-passed');

    expect(iterations).toHaveLength(2);
    expect(exhausted).toHaveLength(1);
    expect(passed).toHaveLength(0);

    // iteration 序号从 1 开始递增
    if (iterations[0].type === 'reflection-iteration') {
      expect(iterations[0].iteration).toBe(1);
    }
    if (iterations[1].type === 'reflection-iteration') {
      expect(iterations[1].iteration).toBe(2);
    }

    // exhausted 携带 maxIterations
    if (exhausted[0].type === 'reflection-exhausted') {
      expect(exhausted[0].maxIterations).toBe(2);
      // 输出是最后一次修正后的结果
      expect(exhausted[0].output).toContain('修正');
    }

    // review 被调用 3 次（初始 + 2 次修正后）
    expect(review).toHaveBeenCalledTimes(3);
    // revise 被调用 2 次（与 maxReflections 一致）
    expect(revise).toHaveBeenCalledTimes(2);
  });

  // ============================================================
  // 测试 3：审查通过直接输出（不修正）
  // ============================================================
  it('3. 审查通过直接输出，不调用 revise', async () => {
    const review = vi.fn(async () => passReview('初次即通过'));
    const revise = vi.fn(async (output: string) => output);

    const pattern = new ReflectionPattern(review, revise);
    const params: ReflectionParams = {
      initialOutput: '完美输出',
      criteria: '达到标准',
      maxReflections: 3,
    };

    const events = await collectEvents(pattern.run(params));

    // 应该只有 1 个 reflection-passed，没有 iteration 和 exhausted
    const passed = events.filter(e => e.type === 'reflection-passed');
    const iterations = events.filter(e => e.type === 'reflection-iteration');
    const exhausted = events.filter(e => e.type === 'reflection-exhausted');

    expect(passed).toHaveLength(1);
    expect(iterations).toHaveLength(0);
    expect(exhausted).toHaveLength(0);

    // passed 事件：iteration=0（初始即通过）
    if (passed[0].type === 'reflection-passed') {
      expect(passed[0].iteration).toBe(0);
      expect(passed[0].output).toBe('完美输出');
    }

    // review 被调用 1 次
    expect(review).toHaveBeenCalledTimes(1);
    // revise 不应被调用
    expect(revise).not.toHaveBeenCalled();
  });

  // ============================================================
  // 测试 4：maxReflections=0 时只审查一次，不修正
  // ============================================================
  it('4. maxReflections=0 时只审查不修正，直接 exhausted 或 passed', async () => {
    const review = vi.fn(async () => failReview(['不通过'], '未通过'));
    const revise = vi.fn(async (output: string) => output);

    const pattern = new ReflectionPattern(review, revise);
    const params: ReflectionParams = {
      initialOutput: '初始',
      criteria: '严格',
      maxReflections: 0,
    };

    const events = await collectEvents(pattern.run(params));

    // maxReflections=0 且审查不通过 → 直接 exhausted
    const exhausted = events.filter(e => e.type === 'reflection-exhausted');
    const iterations = events.filter(e => e.type === 'reflection-iteration');
    const passed = events.filter(e => e.type === 'reflection-passed');

    expect(exhausted).toHaveLength(1);
    expect(iterations).toHaveLength(0);
    expect(passed).toHaveLength(0);

    // review 被调用 1 次（只审查一次）
    expect(review).toHaveBeenCalledTimes(1);
    // revise 不应被调用
    expect(revise).not.toHaveBeenCalled();
  });

  // ============================================================
  // 测试 5：maxReflections=0 且初始通过 → passed with iteration=0
  // ============================================================
  it('5. maxReflections=0 且初始通过时仍能 passed', async () => {
    const review = vi.fn(async () => passReview('通过'));
    const revise = vi.fn(async (output: string) => output);

    const pattern = new ReflectionPattern(review, revise);
    const params: ReflectionParams = {
      initialOutput: '初始',
      criteria: '宽松',
      maxReflections: 0,
    };

    const events = await collectEvents(pattern.run(params));

    const passed = events.filter(e => e.type === 'reflection-passed');
    expect(passed).toHaveLength(1);
    if (passed[0].type === 'reflection-passed') {
      expect(passed[0].iteration).toBe(0);
    }
    expect(review).toHaveBeenCalledTimes(1);
    expect(revise).not.toHaveBeenCalled();
  });

  // ============================================================
  // 测试 6：review 回调接收正确的参数
  // ============================================================
  it('6. review 回调接收当前 output 和 criteria', async () => {
    const review = vi.fn(async (_output: string, _criteria: string) => passReview());
    const revise = vi.fn(async (output: string) => output);

    const pattern = new ReflectionPattern(review, revise);
    const params: ReflectionParams = {
      initialOutput: '待审查内容',
      criteria: '审查标准 XYZ',
      maxReflections: 2,
    };

    await collectEvents(pattern.run(params));

    // review 第一次被调用时应收到 initialOutput 和 criteria
    expect(review).toHaveBeenCalledWith('待审查内容', '审查标准 XYZ');
  });

  // ============================================================
  // 测试 7：revise 回调接收当前 output 和 issues
  // ============================================================
  it('7. revise 回调接收当前 output 和 issues 列表', async () => {
    const issues = ['问题1', '问题2'];
    const review = vi.fn(async () => failReview(issues, '不通过'));
    const revise = vi.fn(async (_output: string, _issues: string[]) => '修正后');

    const pattern = new ReflectionPattern(review, revise);
    const params: ReflectionParams = {
      initialOutput: '初始内容',
      criteria: '标准',
      maxReflections: 1,
    };

    await collectEvents(pattern.run(params));

    // revise 应收到初始 output 和 issues
    expect(revise).toHaveBeenCalledWith('初始内容', issues);
  });
});
