import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../../src/agent/context/system-prompt-builder.js';

describe('buildSystemPrompt', () => {
  it('仅 basePrompt 时直接返回', () => {
    expect(buildSystemPrompt({ basePrompt: 'base' })).toBe('base');
  });

  it('basePrompt + skillSuffix 用双换行连接', () => {
    const result = buildSystemPrompt({ basePrompt: 'base', skillSuffix: 'skills' });
    expect(result).toBe('base\n\nskills');
  });

  it('projectRules 加【项目规则】标题', () => {
    const result = buildSystemPrompt({ basePrompt: 'base', projectRules: 'rule1' });
    expect(result).toContain('【项目规则】\nrule1');
  });

  it('projectMemory 加【项目记忆】标题', () => {
    const result = buildSystemPrompt({ basePrompt: 'base', projectMemory: 'mem1' });
    expect(result).toContain('【项目记忆】\nmem1');
  });

  it('userPreferences 加【用户偏好】标题', () => {
    const result = buildSystemPrompt({ basePrompt: 'base', userPreferences: 'pref1' });
    expect(result).toContain('【用户偏好】\npref1');
  });

  it('所有部分按顺序拼装', () => {
    const result = buildSystemPrompt({
      basePrompt: 'base',
      projectRules: 'rule',
      projectMemory: 'mem',
      userPreferences: 'pref',
      contextDiscipline: 'disc',
      skillSuffix: 'skill',
    });
    expect(result).toBe('base\n\n【项目规则】\nrule\n\n【项目记忆】\nmem\n\n【用户偏好】\npref\n\n【上下文工程纪律】\ndisc\n\nskill');
  });

  it('空可选字段跳过', () => {
    const result = buildSystemPrompt({ basePrompt: 'base', projectRules: '', skillSuffix: undefined });
    expect(result).toBe('base');
  });

  it('contextDiscipline 字段被正确拼接到 system prompt（含【上下文工程纪律】标题）', () => {
    const result = buildSystemPrompt({ basePrompt: 'base', contextDiscipline: '- 计划用 plan_set' });
    expect(result).toContain('【上下文工程纪律】\n- 计划用 plan_set');
    expect(result).toBe('base\n\n【上下文工程纪律】\n- 计划用 plan_set');
  });

  it('contextDiscipline 为空时不影响 system prompt', () => {
    const result = buildSystemPrompt({ basePrompt: 'base', contextDiscipline: '' });
    expect(result).toBe('base');
  });

  it('contextDiscipline 拼在 skillSuffix 之前', () => {
    const result = buildSystemPrompt({ basePrompt: 'base', contextDiscipline: 'disc', skillSuffix: 'skill' });
    expect(result).toBe('base\n\n【上下文工程纪律】\ndisc\n\nskill');
  });
});
