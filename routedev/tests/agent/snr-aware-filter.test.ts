// tests/agent/snr-aware-filter.test.ts
// Phase 67 Task 2：SNR 感知过滤器单元测试
//
// 覆盖蓝图 Task 2 测试要求：
//   1. top-p 0.9 保留前 90% 高 RV 任务
//   2. batch 拒绝（零信号占比 > 0.7）
//   3. 不拒绝（零信号占比 ≤ 0.7）
//   4. 空任务列表降级
//   5. estimateRewardVariance 历史模式
//   6. estimateRewardVariance 采样模式
//   7. 降级默认 RV=0.5
//   8. 配置关闭时全部保留

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SNRAwareFilter,
  type WorkerTaskWithRV,
  DEFAULT_SNR_AWARE_FILTER_CONFIG,
} from '../../src/agent/snr-aware-filter.js';

// ============================================================
// 辅助函数
// ============================================================

/** 构造 worker 任务 */
function makeTask(taskId: string, rv: number): WorkerTaskWithRV {
  return {
    taskId,
    description: `task-${taskId}`,
    estimatedRewardVariance: rv,
    retained: false,
  };
}

/** 批量构造任务 */
function makeTasks(rvs: number[]): WorkerTaskWithRV[] {
  return rvs.map((rv, i) => makeTask(`t${i + 1}`, rv));
}

// ============================================================
// 测试套件
// ============================================================

describe('SNRAwareFilter (Phase 67 Task 2)', () => {
  let filter: SNRAwareFilter;

  beforeEach(() => {
    filter = new SNRAwareFilter({
      enabled: true,
      topP: 0.9,
      minRVThreshold: 0.01,
      batchRejectRatio: 0.7,
    });
  });

  // ============================================================
  // 测试 1：top-p 0.9 保留前 90% 高 RV 任务
  // ============================================================
  it('1. top-p=0.9 应保留前 90% 高 RV 任务', () => {
    // 10 个任务，RV 从 0.1 到 1.0
    const tasks = makeTasks([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
    const result = filter.filter(tasks);

    expect(result.batchRejected).toBe(false);
    // 10 * 0.9 = 9（向上取整）
    expect(result.retainedTasks.length).toBe(9);
    expect(result.filteredOutTasks.length).toBe(1);
    // 实际保留比例
    expect(result.actualRetainRatio).toBeCloseTo(0.9, 5);

    // 保留的应是 RV 最高的 9 个（最高的 9 个，过滤掉 RV=0.1 的）
    const retainedRvs = result.retainedTasks.map(t => t.estimatedRewardVariance).sort((a, b) => a - b);
    expect(retainedRvs[0]).toBe(0.2); // 最小的保留值是 0.2（0.1 被过滤）

    // 被过滤掉的应是 RV 最低的那个
    expect(result.filteredOutTasks[0].estimatedRewardVariance).toBe(0.1);
    // 所有保留任务的 retained 标记应为 true
    expect(result.retainedTasks.every(t => t.retained === true)).toBe(true);
    expect(result.filteredOutTasks.every(t => t.retained === false)).toBe(true);
  });

  // ============================================================
  // 测试 2：batch 拒绝（零信号占比 > 0.7）
  // ============================================================
  it('2. 零信号占比 > 0.7 时应拒绝整个 batch', () => {
    // 10 个任务，8 个 RV=0.005（零信号，< 0.01），2 个 RV=0.5
    // 零信号占比 = 8/10 = 0.8 > 0.7
    const tasks = makeTasks([
      0.005, 0.005, 0.005, 0.005, 0.005,
      0.005, 0.005, 0.005, 0.5, 0.5,
    ]);
    const result = filter.filter(tasks);

    expect(result.batchRejected).toBe(true);
    expect(result.retainedTasks.length).toBe(0);
    expect(result.filteredOutTasks.length).toBe(10);
    expect(result.actualRetainRatio).toBe(0);
    // 所有任务标记为未保留
    expect(result.filteredOutTasks.every(t => t.retained === false)).toBe(true);
  });

  // ============================================================
  // 测试 3：不拒绝（零信号占比 ≤ 0.7）
  // ============================================================
  it('3. 零信号占比 ≤ 0.7 时不应拒绝 batch', () => {
    // 10 个任务，7 个 RV=0.005（零信号），3 个 RV=0.5
    // 零信号占比 = 7/10 = 0.7（恰好等于阈值，不触发拒绝）
    const tasks = makeTasks([
      0.005, 0.005, 0.005, 0.005, 0.005,
      0.005, 0.005, 0.5, 0.5, 0.5,
    ]);
    const result = filter.filter(tasks);

    expect(result.batchRejected).toBe(false);
    // 仍按 topP 过滤
    expect(result.retainedTasks.length).toBe(9); // ceil(10 * 0.9)
  });

  // ============================================================
  // 测试 4：空任务列表降级
  // ============================================================
  it('4. 空任务列表应返回空结果（不抛异常）', () => {
    const result = filter.filter([]);

    expect(result.batchRejected).toBe(false);
    expect(result.retainedTasks.length).toBe(0);
    expect(result.filteredOutTasks.length).toBe(0);
    expect(result.actualRetainRatio).toBe(0);
  });

  // ============================================================
  // 测试 5：estimateRewardVariance 历史模式
  // ============================================================
  it('5. estimateRewardVariance 历史模式：匹配描述的 reward 方差', () => {
    const taskDesc = 'fix bug in auth module';
    const history = [
      { description: 'fix bug in auth module', reward: 0.8 },
      { description: 'fix bug in auth module', reward: 0.4 },
      { description: 'fix bug in auth module', reward: 0.6 },
      { description: 'other task', reward: 0.1 },
    ];

    // 匹配的 reward = [0.8, 0.4, 0.6]，均值=0.6
    // 方差 = ((0.8-0.6)^2 + (0.4-0.6)^2 + (0.6-0.6)^2) / 3 = (0.04+0.04+0) / 3 = 0.08/3 ≈ 0.02667
    const rv = filter.estimateRewardVariance(taskDesc, history);

    expect(rv).toBeCloseTo(0.08 / 3, 5);
    expect(rv).not.toBe(0.5); // 不是降级默认值
  });

  // ============================================================
  // 测试 6：estimateRewardVariance 采样模式
  // ============================================================
  it('6. estimateRewardVariance 采样模式：取最近 4 条的方差', () => {
    const taskDesc = 'new task (no history match)';

    // 6 条历史，但都不匹配 taskDesc；取最近 4 条
    // 最近 4 条 reward = [0.5, 0.7, 0.3, 0.5]，均值=0.5
    // 方差 = ((0)^2 + (0.2)^2 + (-0.2)^2 + (0)^2) / 4 = 0.08 / 4 = 0.02
    const history = [
      { description: 'other1', reward: 0.9 }, // 不参与最近 4 条
      { description: 'other2', reward: 0.1 }, // 不参与最近 4 条
      { description: 'other3', reward: 0.5 },
      { description: 'other4', reward: 0.7 },
      { description: 'other5', reward: 0.3 },
      { description: 'other6', reward: 0.5 },
    ];

    const rv = filter.estimateRewardVariance(taskDesc, history);

    // 期望方差 = 0.02
    expect(rv).toBeCloseTo(0.02, 5);
    expect(rv).not.toBe(0.5); // 不是降级默认值
  });

  // ============================================================
  // 测试 7：降级默认 RV=0.5
  // ============================================================
  it('7. 无历史数据时应降级为默认 RV=0.5', () => {
    // 无历史
    expect(filter.estimateRewardVariance('task1')).toBe(0.5);

    // 空历史数组
    expect(filter.estimateRewardVariance('task1', [])).toBe(0.5);

    // 仅 1 条历史（不足以算方差）
    expect(
      filter.estimateRewardVariance('task1', [{ description: 'task1', reward: 0.5 }]),
    ).toBe(0.5);
  });

  // ============================================================
  // 测试 8：配置关闭时全部保留
  // ============================================================
  it('8. 配置关闭时应全部保留', () => {
    const disabledFilter = new SNRAwareFilter({
      ...DEFAULT_SNR_AWARE_FILTER_CONFIG,
      enabled: false,
    });
    const tasks = makeTasks([0.1, 0.2, 0.3, 0.4, 0.5]);
    const result = disabledFilter.filter(tasks);

    expect(result.batchRejected).toBe(false);
    expect(result.retainedTasks.length).toBe(5);
    expect(result.filteredOutTasks.length).toBe(0);
    expect(result.actualRetainRatio).toBe(1);
    expect(result.retainedTasks.every(t => t.retained === true)).toBe(true);
  });

  // ============================================================
  // 额外测试 9：computeVariance 正确性
  // ============================================================
  it('9. computeVariance 应正确计算总体方差', () => {
    // [1, 2, 3, 4, 5] 均值=3，方差=2
    expect(filter.computeVariance([1, 2, 3, 4, 5])).toBeCloseTo(2.0, 5);

    // [0.5, 0.5, 0.5] 方差=0
    expect(filter.computeVariance([0.5, 0.5, 0.5])).toBe(0);

    // 单元素或空数组方差=0
    expect(filter.computeVariance([1])).toBe(0);
    expect(filter.computeVariance([])).toBe(0);
  });

  // ============================================================
  // 额外测试 10：topP 保留至少 1 个任务
  // ============================================================
  it('10. 即使 topP 很低也应至少保留 1 个任务', () => {
    const strictFilter = new SNRAwareFilter({
      enabled: true,
      topP: 0.1, // 极低
      minRVThreshold: 0.01,
      batchRejectRatio: 0.7,
    });
    const tasks = makeTasks([0.5, 0.6, 0.7]);
    const result = strictFilter.filter(tasks);

    expect(result.batchRejected).toBe(false);
    // 至少保留 1 个
    expect(result.retainedTasks.length).toBeGreaterThanOrEqual(1);
    // 保留的应是 RV 最高的
    expect(result.retainedTasks[0].estimatedRewardVariance).toBe(0.7);
  });
});
