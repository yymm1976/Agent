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

  it('userPreferences 加【用户偏好】标题（位于动态尾部）', () => {
    const result = buildSystemPrompt({ basePrompt: 'base', userPreferences: 'pref1' });
    expect(result).toContain('【用户偏好】\npref1');
  });

  it('Phase 72 Task B1：所有部分按新顺序拼装（前缀稳定化）', () => {
    // 静态前缀：base → projectRules → projectMemory → contextDiscipline → skillSuffix
    // 动态尾部：userPreferences
    const result = buildSystemPrompt({
      basePrompt: 'base',
      projectRules: 'rule',
      projectMemory: 'mem',
      userPreferences: 'pref',
      contextDiscipline: 'disc',
      skillSuffix: 'skill',
    });
    expect(result).toBe('base\n\n【项目规则】\nrule\n\n【项目记忆】\nmem\n\n【上下文工程纪律】\ndisc\n\nskill\n\n【用户偏好】\npref');
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

  it('Phase 72 Task B1：dynamicContext 渲染到尾部【动态上下文】段', () => {
    const result = buildSystemPrompt({
      basePrompt: 'base',
      dynamicContext: { date: '2026-07-05', cwd: '/tmp', sessionId: 's1', routeDecision: 'gpt-4' },
    });
    expect(result).toBe('base\n\n【动态上下文】\n- 当前日期：2026-07-05\n- 工作目录：/tmp\n- 会话 ID：s1\n- 路由决策：gpt-4');
  });

  it('Phase 72 Task B1：dynamicContext 仅渲染非空字段', () => {
    const result = buildSystemPrompt({
      basePrompt: 'base',
      dynamicContext: { date: '2026-07-05' },
    });
    expect(result).toBe('base\n\n【动态上下文】\n- 当前日期：2026-07-05');
  });

  it('Phase 72 Task B1：前缀字节稳定——dynamicContext 变化不影响前缀', () => {
    const p1 = buildSystemPrompt({
      basePrompt: 'base',
      projectRules: 'rule',
      skillSuffix: 'skill',
      dynamicContext: { date: '2026-07-05', sessionId: 's1' },
    });
    const p2 = buildSystemPrompt({
      basePrompt: 'base',
      projectRules: 'rule',
      skillSuffix: 'skill',
      dynamicContext: { date: '2026-07-06', sessionId: 's2' },
    });
    // 前缀部分（base + rule + skill）应保持稳定
    const stablePrefix = 'base\n\n【项目规则】\nrule\n\nskill';
    expect(p1.startsWith(stablePrefix)).toBe(true);
    expect(p2.startsWith(stablePrefix)).toBe(true);
    // 尾部不同
    expect(p1).not.toBe(p2);
  });

  it('Phase 72 Task B1：userPreferences 位于 skillSuffix 之后（动态尾部）', () => {
    const result = buildSystemPrompt({
      basePrompt: 'base',
      skillSuffix: 'skill',
      userPreferences: 'pref',
    });
    expect(result).toBe('base\n\nskill\n\n【用户偏好】\npref');
  });
});
