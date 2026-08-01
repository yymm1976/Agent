// tests/skills/coach.test.ts
// Phase 97 Part I Task I3：流程沉淀引导（Skills 化）
// 覆盖：重复工作流检测、n-gram 聚类、去冗余、参数边界、trace 序列提取

import { describe, expect, it } from 'vitest';
import {
  detectRepeatedWorkflows,
  extractToolSequence,
  type SkillDraftSuggestion,
} from '../../src/skills/coach.js';

describe('detectRepeatedWorkflows', () => {
  it('无重复模式返回空数组', () => {
    expect(detectRepeatedWorkflows(['file_read', 'file_write'])).toEqual([]);
  });

  it('检测连续重复的 2 步模式', () => {
    const sequence = ['file_read', 'file_write', 'file_read', 'file_write'];
    const suggestions = detectRepeatedWorkflows(sequence, { minRepeat: 2 });
    expect(suggestions.length).toBeGreaterThan(0);
    const top = suggestions[0];
    expect(top.occurrences).toBeGreaterThanOrEqual(2);
    expect(top.suggestedName).toContain('file');
    expect(top.reason).toContain('file');
  });

  it('minRepeat 阈值：低于阈值不报', () => {
    const sequence = ['file_read', 'file_write', 'file_read'];
    // 2 步模式出现 2 次（重叠窗口）→ minRepeat=3 时不报
    expect(detectRepeatedWorkflows(sequence, { minRepeat: 3 })).toEqual([]);
  });

  it('短模式被更长高频模式包含时去冗余', () => {
    // 完整模式 file_read → file_write 重复 3 次
    const sequence = ['file_read', 'file_write', 'file_read', 'file_write', 'file_read', 'file_write'];
    const suggestions = detectRepeatedWorkflows(sequence, { minRepeat: 2 });
    // 应保留最长的 4 步完整模式（出现 2 次），不再单报被包含的 2 步模式
    const names = suggestions.map((s) => s.suggestedName);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].occurrences).toBe(2);
    expect(names).toContain('file_read-file_write');
  });

  it('maxPatterns 限制返回数量', () => {
    const sequence = [
      'a', 'b', 'a', 'b',
      'c', 'd', 'c', 'd',
    ];
    const suggestions = detectRepeatedWorkflows(sequence, { maxPatterns: 1 });
    expect(suggestions.length).toBeLessThanOrEqual(1);
  });

  it('参数边界：空序列 / 过短序列 / minRepeat<2 返回空', () => {
    expect(detectRepeatedWorkflows([])).toEqual([]);
    expect(detectRepeatedWorkflows(['a'])).toEqual([]);
    expect(detectRepeatedWorkflows(['a', 'a', 'a'], { minRepeat: 1 })).toEqual([]);
    expect(detectRepeatedWorkflows(['a', 'a', 'a'], { maxWindow: 1 })).toEqual([]);
  });

  it('返回结构完整（toolPattern/reason/suggestedName/occurrences）', () => {
    const sequence = ['x', 'y', 'x', 'y'];
    const suggestions = detectRepeatedWorkflows(sequence, { minRepeat: 2 });
    expect(suggestions.length).toBeGreaterThan(0);
    const s: SkillDraftSuggestion = suggestions[0];
    expect(Array.isArray(s.toolPattern)).toBe(true);
    expect(typeof s.suggestedName).toBe('string');
    expect(typeof s.reason).toBe('string');
    expect(s.occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe('extractToolSequence', () => {
  it('提取 tool_call span 的 toolName', () => {
    const spans = [
      { type: 'tool_call', payload: { type: 'tool_call', toolName: 'file_read' } },
      { type: 'tool_call', payload: { type: 'tool_call', toolName: 'file_write' } },
    ];
    expect(extractToolSequence(spans)).toEqual(['file_read', 'file_write']);
  });

  it('提取 react_iteration 的 action.toolName', () => {
    const spans = [
      { type: 'react_iteration', payload: { type: 'react_iteration', action: { toolName: 'shell_exec' } } },
    ];
    expect(extractToolSequence(spans)).toEqual(['shell_exec']);
  });

  it('忽略非 tool span 与缺失 toolName', () => {
    const spans = [
      { type: 'llm_call', payload: { type: 'llm_call' } },
      { type: 'tool_call', payload: { type: 'tool_call' } }, // 无 toolName
      { type: 'react_iteration', payload: { type: 'react_iteration' } }, // 无 action
      { type: 'tool_call', payload: { type: 'tool_call', toolName: 'notes' } },
    ];
    expect(extractToolSequence(spans)).toEqual(['notes']);
  });
});
