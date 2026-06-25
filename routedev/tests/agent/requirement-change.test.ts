// tests/agent/requirement-change.test.ts
// 需求变更检测 + 影响分析 单元测试
// 覆盖：isRequirementChange / generateRequirementDiff / analyzeChangeImpact /
//       affectsDoneCriteria / affectsScope / formatChangeSummary

import { describe, it, expect } from 'vitest';
import {
  isRequirementChange,
  generateRequirementDiff,
  analyzeChangeImpact,
  affectsDoneCriteria,
  affectsScope,
  formatChangeSummary,
  type RequirementChange,
} from '../../src/agent/requirement-change.js';

// --- 工厂函数 ---

function makeChange(overrides: Partial<RequirementChange> = {}): RequirementChange {
  return {
    type: 'edit',
    targetNodeId: 'node-1',
    before: '实现一个登录页面',
    after: '实现一个登录页面，支持手机号登录',
    impactedBranches: ['branch-1'],
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================
// isRequirementChange
// ============================================================

describe('isRequirementChange', () => {
  it('用户消息变更返回 true', () => {
    const oldMsg = { role: 'user', content: '实现登录页面' };
    const newMsg = { role: 'user', content: '实现登录页面，支持手机号' };
    expect(isRequirementChange(oldMsg, newMsg)).toBe(true);
  });

  it('助手消息变更返回 false', () => {
    const oldMsg = { role: 'assistant', content: '好的，我来实现' };
    const newMsg = { role: 'assistant', content: '好的，我来实现登录页面' };
    expect(isRequirementChange(oldMsg, newMsg)).toBe(false);
  });

  it('用户消息内容相同返回 false', () => {
    const oldMsg = { role: 'user', content: '实现登录页面' };
    const newMsg = { role: 'user', content: '实现登录页面' };
    expect(isRequirementChange(oldMsg, newMsg)).toBe(false);
  });

  it('system 消息变更返回 false', () => {
    const oldMsg = { role: 'system', content: 'You are a helpful assistant' };
    const newMsg = { role: 'system', content: 'You are a coder' };
    expect(isRequirementChange(oldMsg, newMsg)).toBe(false);
  });
});

// ============================================================
// generateRequirementDiff
// ============================================================

describe('generateRequirementDiff', () => {
  it('正确识别新增行', () => {
    const before = '实现登录页面';
    const after = '实现登录页面\n支持手机号登录';
    const diff = generateRequirementDiff(before, after);
    expect(diff.added).toContain('支持手机号登录');
    expect(diff.unchanged).toContain('实现登录页面');
  });

  it('正确识别删除行', () => {
    const before = '实现登录页面\n支持手机号登录';
    const after = '实现登录页面';
    const diff = generateRequirementDiff(before, after);
    expect(diff.removed).toContain('支持手机号登录');
    expect(diff.unchanged).toContain('实现登录页面');
  });

  it('完全相同的内容无 added/removed', () => {
    const text = '实现登录页面';
    const diff = generateRequirementDiff(text, text);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toContain(text);
  });
});

// ============================================================
// analyzeChangeImpact
// ============================================================

describe('analyzeChangeImpact', () => {
  it('新功能词 → major + needsReplan', () => {
    const change = makeChange({
      before: '实现登录页面',
      after: '实现登录页面，支持手机号登录',
    });
    const result = analyzeChangeImpact(change);
    expect(result.severity).toBe('major');
    expect(result.needsReplan).toBe(true);
    expect(result.reason).toContain('新功能');
  });

  it('范围词 → moderate + needsReplan', () => {
    const change = makeChange({
      before: '实现登录页面和注册页面',
      after: '实现登录页面，不要注册页面',
    });
    const result = analyzeChangeImpact(change);
    expect(result.severity).toBe('moderate');
    expect(result.needsReplan).toBe(true);
    expect(result.reason).toContain('范围');
  });

  it('措辞调整 → minor + !needsReplan', () => {
    const change = makeChange({
      before: '帮我实现一个登录页面',
      after: '请帮我做一个登录页面',
    });
    const result = analyzeChangeImpact(change);
    expect(result.severity).toBe('minor');
    expect(result.needsReplan).toBe(false);
  });

  it('无 GoalPlan 时只返回 severity（affectedSteps 为空）', () => {
    const change = makeChange();
    const result = analyzeChangeImpact(change);
    expect(result.severity).toBeDefined();
    expect(result.affectedSteps).toEqual([]);
  });

  it('有 GoalPlan 时返回 affectedSteps', () => {
    const change = makeChange({
      before: '实现登录页面',
      after: '实现登录页面，支持手机号登录',
    });
    const goalPlan = {
      description: '实现登录功能',
      steps: [
        { id: 1, description: '创建登录页面组件', status: 'completed' },
        { id: 2, description: '实现手机号登录逻辑', status: 'pending' },
        { id: 3, description: '编写单元测试', status: 'pending' },
      ],
    };
    const result = analyzeChangeImpact(change, goalPlan);
    expect(result.affectedSteps.length).toBeGreaterThan(0);
    // 步骤 1（登录页面）和步骤 2（手机号登录）应受影响
    expect(result.affectedSteps).toContain('1');
    expect(result.affectedSteps).toContain('2');
  });

  it('doneWhen 受影响时升级到 moderate', () => {
    const change = makeChange({
      before: '实现登录页面',
      after: '实现登录页面并编写测试',  // "测试" 关键词
    });
    const spec = {
      goal: '实现登录',
      scope: 'src/auth',
      constraints: [],
      doneWhen: ['所有测试通过'],
      stopIf: [],
    };
    const result = analyzeChangeImpact(change, undefined, spec);
    // "测试" 在 doneWhen 中，应升级
    expect(result.severity).not.toBe('minor');
  });
});

// ============================================================
// affectsDoneCriteria
// ============================================================

describe('affectsDoneCriteria', () => {
  it('检测到完成标准受影响', () => {
    const change = makeChange({
      before: '实现登录页面',
      after: '实现登录页面并编写测试',
    });
    const doneWhen = ['所有测试通过', '类型检查无误'];
    expect(affectsDoneCriteria(change, doneWhen)).toBe(true);
  });

  it('无关联时返回 false', () => {
    const change = makeChange({
      before: '实现登录页面',
      after: '实现登录页面，颜色用蓝色',
    });
    const doneWhen = ['所有测试通过', '类型检查无误'];
    expect(affectsDoneCriteria(change, doneWhen)).toBe(false);
  });
});

// ============================================================
// affectsScope
// ============================================================

describe('affectsScope', () => {
  it('检测到范围受影响（范围词）', () => {
    const change = makeChange({
      before: '实现登录和注册',
      after: '实现登录，不要注册',
    });
    expect(affectsScope(change, '登录和注册模块')).toBe(true);
  });

  it('检测到范围受影响（关键词重叠）', () => {
    const change = makeChange({
      before: '实现登录页面',
      after: '实现登录页面和注册页面',
    });
    expect(affectsScope(change, '登录模块')).toBe(true);
  });

  it('无关联时返回 false', () => {
    const change = makeChange({
      before: '实现登录页面',
      after: '实现登录页面，颜色用蓝色',
    });
    expect(affectsScope(change, '数据库迁移脚本')).toBe(false);
  });
});

// ============================================================
// formatChangeSummary
// ============================================================

describe('formatChangeSummary', () => {
  it('包含变更类型和摘要', () => {
    const change = makeChange({
      type: 'edit',
      before: '实现登录页面',
      after: '实现登录页面，支持手机号登录',
    });
    const summary = formatChangeSummary(change);
    expect(summary).toContain('编辑');
    expect(summary).toContain('实现登录页面，支持手机号登录');
    // 包含 diff 统计
    expect(summary).toMatch(/\+\d+\/-\d+/);
  });

  it('insert 类型显示"插入"', () => {
    const change = makeChange({
      type: 'insert',
      before: '',
      after: '新增需求：支持导出 PDF',
    });
    const summary = formatChangeSummary(change);
    expect(summary).toContain('插入');
  });

  it('delete 类型显示"删除"', () => {
    const change = makeChange({
      type: 'delete',
      before: '支持导出 PDF',
      after: '',
    });
    const summary = formatChangeSummary(change);
    expect(summary).toContain('删除');
  });

  it('长内容截断并显示省略号', () => {
    const longText = '这是一个非常长的需求描述'.repeat(10);
    const change = makeChange({
      type: 'edit',
      before: '旧需求',
      after: longText,
    });
    const summary = formatChangeSummary(change);
    expect(summary).toContain('...');
  });
});
