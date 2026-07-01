// tests/agents/activity-store.test.ts
// Phase 51 Task 5/11：Agent 活动面板 + splitModelLabel 单元测试
//
// 覆盖关键能力：
//   1. AgentActivityStore 三态机（start → update → finish）
//   2. slice 防膨胀（active / recent 列表上限）
//   3. subscribe 事件推送（非轮询）
//   4. splitModelLabel 模型标签分离
//
// 全部为纯单元测试，不依赖 LLM 或文件系统。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AgentActivityStore,
  splitModelLabel,
  truncatePreview,
  buildLineage,
  type AgentActivityRecord,
} from '../../src/agents/activity-store.js';

// 测试用的活动记录工厂
function makeRecord(overrides: Partial<Omit<AgentActivityRecord, 'status' | 'toolCallCount' | 'startedAt'>> = {}): Omit<AgentActivityRecord, 'status' | 'toolCallCount' | 'startedAt'> {
  return {
    id: `act-${Math.random().toString(36).slice(2, 8)}`,
    lineage: 'executor',
    depth: 1,
    role: 'executor',
    taskPreview: 'test task',
    ...overrides,
  };
}

describe('Phase 51 Task 5: activity-store 单元测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // 1. AgentActivityStore 三态机
  // ============================================================

  it('1.1 startActivity: 新活动进入 active[] 且 unshift 到首位', () => {
    const store = new AgentActivityStore(4, 3);
    const id1 = store.startActivity(makeRecord({ id: 'r1', taskPreview: '任务一' }));
    const id2 = store.startActivity(makeRecord({ id: 'r2', taskPreview: '任务二' }));

    const active = store.getActive();
    expect(active).toHaveLength(2);
    // 后启动的应在前
    expect(active[0].id).toBe(id2);
    expect(active[1].id).toBe(id1);
    // 启动后状态应为 running
    expect(active[0].status).toBe('running');
    expect(active[0].toolCallCount).toBe(0);
    expect(active[0].startedAt).toBeGreaterThan(0);
  });

  it('1.2 startActivity: 超过 maxActive 时 slice 截断防膨胀', () => {
    const store = new AgentActivityStore(2, 3); // maxActive=2
    store.startActivity(makeRecord({ id: 'r1' }));
    store.startActivity(makeRecord({ id: 'r2' }));
    store.startActivity(makeRecord({ id: 'r3' })); // 应触发截断

    const active = store.getActive();
    expect(active).toHaveLength(2);
    // 最旧的 r1 被截断
    expect(active.find((a) => a.id === 'r1')).toBeUndefined();
    // 最新的 r3 在首位
    expect(active[0].id).toBe('r3');
  });

  it('1.3 updateActivity: 原地更新（按 id 查找）', () => {
    const store = new AgentActivityStore(4, 3);
    const id = store.startActivity(makeRecord({ id: 'r1', taskPreview: '原始任务' }));

    store.updateActivity(id, {
      taskPreview: '更新后任务',
      toolCallCount: 5,
      lastToolName: 'file_edit',
      lastToolDescription: '编辑文件',
    });

    const active = store.getActive();
    expect(active).toHaveLength(1);
    expect(active[0].taskPreview).toBe('更新后任务');
    expect(active[0].toolCallCount).toBe(5);
    expect(active[0].lastToolName).toBe('file_edit');
  });

  it('1.4 updateActivity: id 不存在时不抛错（仅 warn）', () => {
    const store = new AgentActivityStore(4, 3);
    expect(() => store.updateActivity('non-existent-id', { taskPreview: 'x' })).not.toThrow();
    expect(store.getActive()).toHaveLength(0);
  });

  it('1.5 finishActivity: 从 active[] 移到 recent[] 且 slice 防膨胀', () => {
    const store = new AgentActivityStore(4, 2); // maxRecent=2
    const id1 = store.startActivity(makeRecord({ id: 'r1' }));
    const id2 = store.startActivity(makeRecord({ id: 'r2' }));
    const id3 = store.startActivity(makeRecord({ id: 'r3' }));

    store.finishActivity(id1, 'success');
    store.finishActivity(id2, 'success');
    store.finishActivity(id3, 'success');

    // active 应空
    expect(store.getActive()).toHaveLength(0);
    // recent 应被截断到 maxRecent=2，且最新完成的在前
    const recent = store.getRecent();
    expect(recent).toHaveLength(2);
    // 最旧的 id1 被截断
    expect(recent.find((r) => r.id === id1)).toBeUndefined();
    // 最新完成的 id3 在首位
    expect(recent[0].id).toBe(id3);
    // status 应是 success，finishedAt 应已写入
    expect(recent[0].status).toBe('success');
    expect(recent[0].finishedAt).toBeGreaterThan(0);
  });

  it('1.6 finishActivity: status=error 时记录 error 信息', () => {
    const store = new AgentActivityStore(4, 3);
    const id = store.startActivity(makeRecord({ id: 'r1' }));

    store.finishActivity(id, 'error', '工具调用超时');

    const recent = store.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].status).toBe('error');
    expect(recent[0].error).toBe('工具调用超时');
  });

  // ============================================================
  // 2. subscribe 事件推送
  // ============================================================

  it('2.1 subscribe: 事件推送（非轮询）——startActivity 触发 listener', () => {
    const store = new AgentActivityStore(4, 3);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.startActivity(makeRecord({ id: 'r1' }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toHaveLength(1);

    unsubscribe();
    store.startActivity(makeRecord({ id: 'r2' }));
    // 取消订阅后不再被通知
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('2.2 subscribe: 多个 listener 均被通知，且 listener 抛错不影响其他 listener', () => {
    const store = new AgentActivityStore(4, 3);
    const listener1 = vi.fn(() => { throw new Error('listener error'); });
    const listener2 = vi.fn();
    store.subscribe(listener1);
    store.subscribe(listener2);

    // 即使 listener1 抛错，listener2 也应被通知，且不抛错到外层
    expect(() => store.startActivity(makeRecord({ id: 'r1' }))).not.toThrow();
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 3. clear 清空记录
  // ============================================================

  it('3.1 clear: 清空所有记录（active + recent）', () => {
    const store = new AgentActivityStore(4, 3);
    const id1 = store.startActivity(makeRecord({ id: 'r1' }));
    store.finishActivity(id1, 'success');
    store.startActivity(makeRecord({ id: 'r2' }));

    expect(store.getActive()).toHaveLength(1);
    expect(store.getRecent()).toHaveLength(1);

    store.clear();
    expect(store.getActive()).toHaveLength(0);
    expect(store.getRecent()).toHaveLength(0);
  });

  // ============================================================
  // 4. splitModelLabel 模型标签分离
  // ============================================================

  it('4.1 splitModelLabel: 正确分离 "openai-codex/gpt-5.4:high" → { model: "gpt-5.4", thinking: "high" }', () => {
    const result = splitModelLabel('openai-codex/gpt-5.4:high');
    expect(result.model).toBe('gpt-5.4');
    expect(result.thinking).toBe('high');
  });

  it('4.2 splitModelLabel: "gpt-5.4:high" 无 provider 前缀时仍正确分离', () => {
    const result = splitModelLabel('gpt-5.4:high');
    expect(result.model).toBe('gpt-5.4');
    expect(result.thinking).toBe('high');
  });

  it('4.3 splitModelLabel: 无 thinking 等级时返回纯模型名', () => {
    expect(splitModelLabel('gpt-5.4')).toEqual({ model: 'gpt-5.4' });
    expect(splitModelLabel('openai-codex/gpt-5.4')).toEqual({ model: 'gpt-5.4' });
  });

  it('4.4 splitModelLabel: thinking 等级支持 low/medium/high/auto', () => {
    for (const level of ['low', 'medium', 'high', 'auto']) {
      const result = splitModelLabel(`gpt-5.4:${level}`);
      expect(result.model).toBe('gpt-5.4');
      expect(result.thinking).toBe(level);
    }
  });

  it('4.5 splitModelLabel: 冒号后非合法 thinking 等级时整体当模型名处理', () => {
    // "high-x" 不是合法 thinking 等级，整体作为模型名
    const result = splitModelLabel('gpt-5.4:high-x');
    expect(result.model).toBe('gpt-5.4:high-x');
    expect(result.thinking).toBeUndefined();
  });

  it('4.6 splitModelLabel: 空字符串返回 { model: "" }', () => {
    expect(splitModelLabel('')).toEqual({ model: '' });
  });

  // ============================================================
  // 5. 辅助函数
  // ============================================================

  it('5.1 truncatePreview: 超长文本截断并加省略号', () => {
    const long = 'a'.repeat(100);
    const truncated = truncatePreview(long, 72);
    expect(truncated).toHaveLength(73); // 72 + 省略号
    expect(truncated.endsWith('…')).toBe(true);
  });

  it('5.2 truncatePreview: 短文本不截断', () => {
    expect(truncatePreview('short', 72)).toBe('short');
    expect(truncatePreview('', 72)).toBe('');
  });

  it('5.3 buildLineage: 拼接父 lineage 与当前 role', () => {
    expect(buildLineage(undefined, 'executor')).toBe('executor');
    expect(buildLineage('executor', 'researcher')).toBe('executor > researcher');
    expect(buildLineage('executor > researcher', 'reviewer')).toBe('executor > researcher > reviewer');
  });
});
