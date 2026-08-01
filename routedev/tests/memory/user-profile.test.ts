// tests/memory/user-profile.test.ts
// Phase 97 Part I：UserProfile 渲染与校验
// 覆盖：空档案降级、字段渲染、截断保护、非法输入校验

import { describe, expect, it } from 'vitest';
import { renderUserProfile, validateUserProfile } from '../../src/memory/user-profile.js';

describe('renderUserProfile', () => {
  it('null / undefined 安全降级为空字符串', () => {
    expect(renderUserProfile(null)).toBe('');
    expect(renderUserProfile(undefined)).toBe('');
  });

  it('空对象 / 全空字段降级为空字符串', () => {
    expect(renderUserProfile({})).toBe('');
    expect(renderUserProfile({ occupation: '', mustRemember: [] })).toBe('');
  });

  it('完整档案按行渲染', () => {
    const rendered = renderUserProfile({
      occupation: '前端工程师',
      currentWork: '重构订单模块',
      skillLevel: '熟悉 TypeScript',
      interactionPrefs: '代码注释用中文',
      mustRemember: ['验证用 pnpm test', '不用 emoji'],
    });
    expect(rendered).toContain('【用户档案】');
    expect(rendered).toContain('职业：前端工程师');
    expect(rendered).toContain('最近在做：重构订单模块');
    expect(rendered).toContain('水平：熟悉 TypeScript');
    expect(rendered).toContain('交互偏好：代码注释用中文');
    expect(rendered).toContain('必记信息：验证用 pnpm test；不用 emoji');
  });

  it('部分字段只渲染非空项', () => {
    const rendered = renderUserProfile({ occupation: '工程师' });
    expect(rendered).toBe('【用户档案】\n职业：工程师');
    expect(rendered).not.toContain('最近在做');
  });

  it('超长档案截断到 600 字符并保留省略号', () => {
    const longText = '长'.repeat(700);
    const rendered = renderUserProfile({ occupation: longText });
    expect(rendered.length).toBeLessThanOrEqual(601);
    expect(rendered.endsWith('…')).toBe(true);
  });
});

describe('validateUserProfile', () => {
  it('null / undefined 视为合法', () => {
    expect(validateUserProfile(null)).toEqual([]);
    expect(validateUserProfile(undefined)).toEqual([]);
  });

  it('合法档案返回空错误数组', () => {
    expect(validateUserProfile({ occupation: '工程师', mustRemember: ['a'] })).toEqual([]);
  });

  it('非对象输入报错', () => {
    expect(validateUserProfile('oops')).toEqual(['userProfile 必须是对象']);
  });

  it('字段类型错误逐一报告', () => {
    const errors = validateUserProfile({ occupation: 123, interactionPrefs: [], mustRemember: 'x' });
    expect(errors).toContain('userProfile.occupation 必须是字符串');
    expect(errors).toContain('userProfile.interactionPrefs 必须是字符串');
    expect(errors).toContain('userProfile.mustRemember 必须是字符串数组');
  });
});
