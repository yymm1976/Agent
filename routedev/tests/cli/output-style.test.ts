// tests/cli/output-style.test.ts
// Phase 34 Task 1：Output Style 系统测试

import { describe, it, expect } from 'vitest';
import {
  outputStyleToDisclosureLevel,
  disclosureLevelToOutputStyle,
  shouldShowThinking,
  shouldShowToolDetails,
  shouldShowProgress,
  shouldShowAnimation,
  shouldShowTimer,
  shouldAutoCollapseOnComplete,
  nextOutputStyle,
  parseOutputStyle,
  isHighDensity,
} from '../../src/cli/output-style.js';
import type { OutputStyle } from '../../src/config/schema.js';

describe('Output Style 工具函数', () => {
  it('outputStyleToDisclosureLevel 映射正确', () => {
    expect(outputStyleToDisclosureLevel('minimal')).toBe(1);
    expect(outputStyleToDisclosureLevel('standard')).toBe(2);
    expect(outputStyleToDisclosureLevel('verbose')).toBe(3);
  });

  it('disclosureLevelToOutputStyle 映射正确', () => {
    expect(disclosureLevelToOutputStyle(1)).toBe('minimal');
    expect(disclosureLevelToOutputStyle(2)).toBe('standard');
    expect(disclosureLevelToOutputStyle(3)).toBe('verbose');
  });

  it('minimal 模式下隐藏思考过程与工具详情', () => {
    expect(shouldShowThinking('minimal')).toBe(false);
    expect(shouldShowToolDetails('minimal')).toBe(false);
    expect(shouldShowProgress('minimal')).toBe('current');
    expect(shouldShowAnimation('minimal')).toBe(false);
    expect(shouldShowTimer('minimal')).toBe(false);
    expect(shouldAutoCollapseOnComplete('minimal')).toBe(true);
    expect(isHighDensity('minimal')).toBe(false);
  });

  it('standard 模式下展示摘要与可展开详情', () => {
    expect(shouldShowThinking('standard')).toBe(false);
    expect(shouldShowThinking('standard', true)).toBe(true);
    expect(shouldShowToolDetails('standard')).toBe(false);
    expect(shouldShowToolDetails('standard', true)).toBe(true);
    expect(shouldShowProgress('standard')).toBe('count');
    expect(shouldShowAnimation('standard')).toBe(true);
    expect(shouldShowTimer('standard')).toBe(true);
    expect(shouldAutoCollapseOnComplete('standard')).toBe(true);
    expect(isHighDensity('standard')).toBe(false);
  });

  it('verbose 模式下默认展示全部信息', () => {
    expect(shouldShowThinking('verbose')).toBe(true);
    expect(shouldShowToolDetails('verbose')).toBe(true);
    expect(shouldShowProgress('verbose')).toBe('full');
    expect(shouldShowAnimation('verbose')).toBe(true);
    expect(shouldShowTimer('verbose')).toBe(true);
    expect(shouldAutoCollapseOnComplete('verbose')).toBe(false);
    expect(isHighDensity('verbose')).toBe(true);
  });

  it('nextOutputStyle 按 minimal → standard → verbose 循环', () => {
    expect(nextOutputStyle('minimal')).toBe('standard');
    expect(nextOutputStyle('standard')).toBe('verbose');
    expect(nextOutputStyle('verbose')).toBe('minimal');
  });

  it('parseOutputStyle 支持全称、缩写与数字兼容', () => {
    expect(parseOutputStyle('minimal')).toBe('minimal');
    expect(parseOutputStyle('min')).toBe('minimal');
    expect(parseOutputStyle('standard')).toBe('standard');
    expect(parseOutputStyle('std')).toBe('standard');
    expect(parseOutputStyle('verbose')).toBe('verbose');
    expect(parseOutputStyle('1')).toBe('minimal');
    expect(parseOutputStyle('2')).toBe('standard');
    expect(parseOutputStyle('3')).toBe('verbose');
    expect(parseOutputStyle('invalid')).toBeNull();
  });
});

describe('Output Style Schema 兼容', () => {
  it('AppConfigSchema 默认 outputStyle 为 standard', async () => {
    const { AppConfigSchema } = await import('../../src/config/schema.js');
    const result = AppConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data!.ui.outputStyle).toBe('standard');
  });

  it('AppConfigSchema 兼容旧版数字 disclosureLevel', async () => {
    const { AppConfigSchema } = await import('../../src/config/schema.js');
    expect(AppConfigSchema.safeParse({ ui: { disclosureLevel: 1 } }).data!.ui.outputStyle).toBe('minimal');
    expect(AppConfigSchema.safeParse({ ui: { disclosureLevel: 2 } }).data!.ui.outputStyle).toBe('standard');
    expect(AppConfigSchema.safeParse({ ui: { disclosureLevel: 3 } }).data!.ui.outputStyle).toBe('verbose');
    expect(AppConfigSchema.safeParse({ ui: { disclosureLevel: '1' } }).data!.ui.outputStyle).toBe('minimal');
  });

  it('AppConfigSchema 拒绝非法 outputStyle', async () => {
    const { AppConfigSchema } = await import('../../src/config/schema.js');
    const result = AppConfigSchema.safeParse({ ui: { outputStyle: 'ultra' } });
    expect(result.success).toBe(false);
  });
});
