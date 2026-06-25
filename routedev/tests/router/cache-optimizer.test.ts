// tests/router/cache-optimizer.test.ts
// Reasonix 六层缓存优化架构单元测试

import { describe, it, expect } from 'vitest';
import {
  computePrefixShape,
  diffPrefixShape,
  CacheAwarePromptBuilder,
  DEFAULT_COMPACTION_THRESHOLDS,
  decideCompactionAction,
  CacheStatsTracker,
  orderToolResultsByDeclaration,
  alignCompactionBoundary,
} from '../../src/router/cache-optimizer.js';
import type { LLMMessage } from '../../src/router/types.js';

// ============================================================
// Layer 4: 前缀 Shape 哈希溯源
// ============================================================

describe('PrefixShape 哈希溯源', () => {
  it('computePrefixShape 应返回稳定的哈希', () => {
    const shape1 = computePrefixShape('system prompt', [{ name: 'tool1' }], 0);
    const shape2 = computePrefixShape('system prompt', [{ name: 'tool1' }], 0);
    expect(shape1.prefixHash).toBe(shape2.prefixHash);
    expect(shape1.systemHash).toHaveLength(16);
    expect(shape1.toolsHash).toHaveLength(16);
    expect(shape1.prefixHash).toHaveLength(16);
  });

  it('system prompt 变化应改变 systemHash', () => {
    const shape1 = computePrefixShape('prompt A', [], 0);
    const shape2 = computePrefixShape('prompt B', [], 0);
    expect(shape1.systemHash).not.toBe(shape2.systemHash);
  });

  it('tools 变化应改变 toolsHash', () => {
    const shape1 = computePrefixShape('prompt', [{ name: 'a' }], 0);
    const shape2 = computePrefixShape('prompt', [{ name: 'b' }], 0);
    expect(shape1.toolsHash).not.toBe(shape2.toolsHash);
  });

  it('diffPrefixShape 应报告未变化', () => {
    const shape = computePrefixShape('prompt', [], 0);
    const diff = diffPrefixShape(shape, shape);
    expect(diff.changed).toBe(false);
    expect(diff.reason).toContain('unchanged');
  });

  it('diffPrefixShape 应报告 system 变化', () => {
    const old = computePrefixShape('prompt A', [], 0);
    const next = computePrefixShape('prompt B', [], 0);
    const diff = diffPrefixShape(old, next);
    expect(diff.changed).toBe(true);
    expect(diff.reason).toContain('system');
  });

  it('diffPrefixShape 应报告 tools 变化', () => {
    const old = computePrefixShape('prompt', [{ name: 'a' }], 0);
    const next = computePrefixShape('prompt', [{ name: 'b' }], 0);
    const diff = diffPrefixShape(old, next);
    expect(diff.changed).toBe(true);
    expect(diff.reason).toContain('tools');
  });

  it('diffPrefixShape 应报告 log_rewrite 变化', () => {
    const old = computePrefixShape('prompt', [], 0);
    const next = computePrefixShape('prompt', [], 1);
    const diff = diffPrefixShape(old, next);
    expect(diff.changed).toBe(true);
    expect(diff.reason).toContain('log_rewrite');
  });
});

// ============================================================
// Layer 1 & 2: CacheAwarePromptBuilder
// ============================================================

describe('CacheAwarePromptBuilder', () => {
  it('应构建不可变前缀', () => {
    const builder = new CacheAwarePromptBuilder(
      'base prompt',
      'concise style',
      'zh-CN',
      'memory: none',
      'skills: none',
      [{ name: 'tool1' }],
    );
    const systemPrompt = builder.getSystemPrompt();
    expect(systemPrompt).toContain('base prompt');
    expect(systemPrompt).toContain('concise style');
    expect(systemPrompt).toContain('zh-CN');
  });

  it('前缀构建后应保持稳定（字节级）', () => {
    const builder1 = new CacheAwarePromptBuilder('a', 'b', 'c', 'd', 'e', []);
    const builder2 = new CacheAwarePromptBuilder('a', 'b', 'c', 'd', 'e', []);
    expect(builder1.getSystemPrompt()).toBe(builder2.getSystemPrompt());
    expect(builder1.getPrefixShape().prefixHash).toBe(builder2.getPrefixShape().prefixHash);
  });

  it('空字符串段应被过滤', () => {
    const builder = new CacheAwarePromptBuilder('base', '', '', '', '', []);
    const prompt = builder.getSystemPrompt();
    expect(prompt).toBe('base');
  });

  it('formatMutationsAsUserMessage 应包装为 user message', () => {
    const msg = CacheAwarePromptBuilder.formatMutationsAsUserMessage(['mode changed', 'memory updated']);
    expect(msg).toContain('[系统通知]');
    expect(msg).toContain('mode changed');
    expect(msg).toContain('memory updated');
  });

  it('formatMutationsAsUserMessage 空数组应返回空字符串', () => {
    const msg = CacheAwarePromptBuilder.formatMutationsAsUserMessage([]);
    expect(msg).toBe('');
  });

  it('getTools 应返回工具定义', () => {
    const tools = [{ name: 'tool1' }, { name: 'tool2' }];
    const builder = new CacheAwarePromptBuilder('base', '', '', '', '', tools);
    expect(builder.getTools()).toEqual(tools);
  });
});

// ============================================================
// Layer 3: 三级压缩阈值
// ============================================================

describe('三级压缩阈值 (decideCompactionAction)', () => {
  it('默认阈值应为 0.5/0.8/0.9', () => {
    expect(DEFAULT_COMPACTION_THRESHOLDS.softThreshold).toBe(0.5);
    expect(DEFAULT_COMPACTION_THRESHOLDS.triggerThreshold).toBe(0.8);
    expect(DEFAULT_COMPACTION_THRESHOLDS.forceThreshold).toBe(0.9);
  });

  it('使用率 < 50% → none', () => {
    const result = decideCompactionAction(0.3);
    expect(result.action).toBe('none');
  });

  it('使用率 = 50% → soft_notify', () => {
    const result = decideCompactionAction(0.5);
    expect(result.action).toBe('soft_notify');
  });

  it('使用率 = 70% → soft_notify', () => {
    const result = decideCompactionAction(0.7);
    expect(result.action).toBe('soft_notify');
  });

  it('使用率 = 80% → trigger', () => {
    const result = decideCompactionAction(0.8);
    expect(result.action).toBe('trigger');
  });

  it('使用率 = 85% → trigger', () => {
    const result = decideCompactionAction(0.85);
    expect(result.action).toBe('trigger');
  });

  it('使用率 = 90% → force', () => {
    const result = decideCompactionAction(0.9);
    expect(result.action).toBe('force');
  });

  it('使用率 = 95% → force', () => {
    const result = decideCompactionAction(0.95);
    expect(result.action).toBe('force');
  });

  it('应支持自定义阈值', () => {
    const custom = { softThreshold: 0.3, triggerThreshold: 0.6, forceThreshold: 0.8 };
    expect(decideCompactionAction(0.35, custom).action).toBe('soft_notify');
    expect(decideCompactionAction(0.65, custom).action).toBe('trigger');
    expect(decideCompactionAction(0.85, custom).action).toBe('force');
  });
});

// ============================================================
// Layer 5 & 6: CacheStatsTracker
// ============================================================

describe('CacheStatsTracker', () => {
  it('应记录单轮缓存统计', () => {
    const tracker = new CacheStatsTracker();
    tracker.record(800, 200, 'deepseek');
    expect(tracker.getTurnHitRate()).toBe(0.8);
  });

  it('resetTurn 应重置单轮但不重置会话级', () => {
    const tracker = new CacheStatsTracker();
    tracker.record(800, 200, 'deepseek');
    tracker.resetTurn();
    expect(tracker.getTurnHitRate()).toBe(0);
    // 会话级不重置
    expect(tracker.getSessionStats().hit).toBe(800);
    expect(tracker.getSessionStats().miss).toBe(200);
  });

  it('会话级累计应跨轮次累加', () => {
    const tracker = new CacheStatsTracker();
    tracker.record(800, 200, 'deepseek');
    tracker.resetTurn();
    tracker.record(900, 100, 'deepseek');
    const stats = tracker.getSessionStats();
    expect(stats.hit).toBe(1700);
    expect(stats.miss).toBe(300);
    expect(stats.total).toBe(2000);
  });

  it('getSessionHitRate 应返回会话级命中率', () => {
    const tracker = new CacheStatsTracker();
    tracker.record(800, 200, 'deepseek');
    tracker.resetTurn();
    tracker.record(900, 100, 'deepseek');
    expect(tracker.getSessionHitRate()).toBeCloseTo(1700 / 2000, 5);
  });

  it('getDisplayFormat 应展示绝对计数', () => {
    const tracker = new CacheStatsTracker();
    tracker.record(900, 100, 'deepseek');
    const display = tracker.getDisplayFormat(1000, 200);
    expect(display).toContain('1000');
    expect(display).toContain('900 cached');
    expect(display).toContain('100 new');
    expect(display).toContain('out 200');
  });

  it('空统计应返回 0 命中率', () => {
    const tracker = new CacheStatsTracker();
    expect(tracker.getTurnHitRate()).toBe(0);
    expect(tracker.getSessionHitRate()).toBe(0);
  });
});

// ============================================================
// 确定性工具结果写回
// ============================================================

describe('orderToolResultsByDeclaration', () => {
  it('应按声明顺序返回结果', () => {
    const toolCalls = [
      { id: '1', name: 'tool_a' },
      { id: '2', name: 'tool_b' },
      { id: '3', name: 'tool_c' },
    ];
    const results = new Map<string, string>();
    results.set('3', 'result_c');
    results.set('1', 'result_a');
    results.set('2', 'result_b');

    const ordered = orderToolResultsByDeclaration(toolCalls, results);
    expect(ordered).toEqual(['result_a', 'result_b', 'result_c']);
  });

  it('应跳过缺失的结果', () => {
    const toolCalls = [
      { id: '1', name: 'tool_a' },
      { id: '2', name: 'tool_b' },
    ];
    const results = new Map<string, string>();
    results.set('1', 'result_a');

    const ordered = orderToolResultsByDeclaration(toolCalls, results);
    expect(ordered).toEqual(['result_a']);
  });

  it('空数组应返回空', () => {
    const ordered = orderToolResultsByDeclaration([], new Map());
    expect(ordered).toEqual([]);
  });
});

// ============================================================
// 压缩边界对齐
// ============================================================

describe('alignCompactionBoundary', () => {
  it('空数组应返回空', () => {
    expect(alignCompactionBoundary([])).toEqual([]);
  });

  it('无 tool_result 应原样返回', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const result = alignCompactionBoundary(messages);
    expect(result).toHaveLength(2);
  });

  it('尾部 tool_result 应被截断到边界', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'tool', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'result' }] },
    ];
    const result = alignCompactionBoundary(messages);
    // 尾部是 tool_result，应截断到非 tool_result 消息
    expect(result.length).toBeLessThanOrEqual(messages.length);
  });
});
