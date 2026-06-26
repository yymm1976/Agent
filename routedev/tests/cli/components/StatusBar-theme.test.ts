// tests/cli/components/StatusBar-theme.test.ts
// Phase 27 Task 3：StatusBar ThemePlugin 接入测试
// 验证 ThemePlugin 提供颜色时优先使用，未提供时 fallback 到设计系统默认

import { describe, it, expect } from 'vitest';
import {
  getColorWithTheme,
  getTierColorWithTheme,
} from '../../../src/cli/components/StatusBar.js';
import { getColor } from '../../../src/cli/design-system.js';
import type { ThemeColors } from '../../../src/plugins/types.js';

describe('Phase 27 Task 3: StatusBar ThemePlugin 接入', () => {
  // 测试 1：ThemePlugin 提供颜色时，getColorWithTheme 返回插件颜色
  it('ThemePlugin 提供颜色时，getColorWithTheme 返回插件颜色', () => {
    const themeColors: Partial<ThemeColors> = {
      primary: '#FF0000', // 红色
      error: '#00FF00',   // 绿色
      accent: '#0000FF',  // 蓝色
      success: '#FFFF00', // 黄色
    };

    // 插件提供的颜色应被使用
    expect(getColorWithTheme('primary', themeColors)).toBe('#FF0000');
    expect(getColorWithTheme('error', themeColors)).toBe('#00FF00');
    expect(getColorWithTheme('accent', themeColors)).toBe('#0000FF');
    expect(getColorWithTheme('success', themeColors)).toBe('#FFFF00');
  });

  // 测试 2：ThemePlugin 未提供某颜色时，fallback 到设计系统默认
  it('ThemePlugin 未提供某颜色时，fallback 到设计系统默认', () => {
    const themeColors: Partial<ThemeColors> = {
      primary: '#FF0000',
      // 不提供 error, accent, success
    };

    // primary 用插件颜色
    expect(getColorWithTheme('primary', themeColors)).toBe('#FF0000');
    // 其他颜色 fallback 到设计系统默认
    expect(getColorWithTheme('error', themeColors)).toBe(getColor('error'));
    expect(getColorWithTheme('accent', themeColors)).toBe(getColor('accent'));
    expect(getColorWithTheme('success', themeColors)).toBe(getColor('success'));
    // warning / info 在 ThemeColors 中无对应字段，始终用默认
    expect(getColorWithTheme('warning', themeColors)).toBe(getColor('warning'));
    expect(getColorWithTheme('info', themeColors)).toBe(getColor('info'));
  });

  // 测试 3：未传入 themeColors（插件未安装）时，完全使用设计系统默认（向后兼容）
  it('未传入 themeColors 时完全使用设计系统默认', () => {
    expect(getColorWithTheme('primary')).toBe(getColor('primary'));
    expect(getColorWithTheme('error')).toBe(getColor('error'));
    expect(getColorWithTheme('info')).toBe(getColor('info'));
  });

  // 测试 4：tier 颜色也支持 ThemePlugin 覆盖
  it('getTierColorWithTheme 支持插件覆盖 tier 颜色', () => {
    const themeColors: Partial<ThemeColors> = {
      success: '#AAA111', // simple tier 用 success
      accent: '#BBB222',  // complex tier 用 accent
      primary: '#CCC333', // reasoning tier 用 primary
      // warning 无对应字段，medium tier 不覆盖
    };

    // simple → success → 覆盖
    expect(getTierColorWithTheme('simple', themeColors)).toBe('#AAA111');
    // complex → accent → 覆盖
    expect(getTierColorWithTheme('complex', themeColors)).toBe('#BBB222');
    // reasoning → primary → 覆盖
    expect(getTierColorWithTheme('reasoning', themeColors)).toBe('#CCC333');
    // medium → warning → 无对应 ThemeColors 字段，用默认
    expect(getTierColorWithTheme('medium', themeColors)).toBe(getColor('warning'));
  });

  // 测试 5：未传入 themeColors 时，tier 颜色用设计系统默认
  it('未传入 themeColors 时 tier 颜色用设计系统默认', () => {
    expect(getTierColorWithTheme('simple')).toBe(getColor('success'));
    expect(getTierColorWithTheme('medium')).toBe(getColor('warning'));
    expect(getTierColorWithTheme('complex')).toBe(getColor('accent'));
    expect(getTierColorWithTheme('reasoning')).toBe(getColor('primary'));
  });
});
