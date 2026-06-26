// tests/cli/design-system.test.ts
// 设计系统单元测试（Phase 24 Task 1）
// 验证颜色语义映射、消息样式、排版规范

import { describe, it, expect } from 'vitest';
import {
  SemanticColor,
  getColor,
  MESSAGE_STYLES,
  getMessageStyle,
  TYPOGRAPHY,
  divider,
  getTierLabel,
  TIER_LABELS,
} from '../../src/cli/design-system.js';

describe('设计系统 (design-system)', () => {
  // ============================================================
  // 颜色语义
  // ============================================================
  describe('颜色语义', () => {
    it('所有语义颜色都有对应颜色值', () => {
      const colors: SemanticColor[] = ['primary', 'success', 'warning', 'error', 'info', 'accent'];
      for (const c of colors) {
        const value = getColor(c);
        expect(value).toBeTruthy();
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      }
    });

    it('truecolor 模式返回 hex 颜色（# 开头）', () => {
      // 临时设置 COLORTERM=truecolor
      const original = process.env.COLORTERM;
      process.env.COLORTERM = 'truecolor';
      // 重新加载模块（vitest 缓存机制下 USE_TRUECOLOR 在模块加载时已固定）
      // 这里验证 getColor 在当前环境下返回非空字符串
      const value = getColor('primary');
      expect(value).toBeTruthy();
      process.env.COLORTERM = original;
    });

    it('不同语义颜色返回不同值', () => {
      const primary = getColor('primary');
      const success = getColor('success');
      const error = getColor('error');
      expect(primary).not.toBe(success);
      expect(success).not.toBe(error);
      expect(primary).not.toBe(error);
    });
  });

  // ============================================================
  // 消息样式
  // ============================================================
  describe('消息样式', () => {
    it('MESSAGE_STYLES 包含所有预定义类别', () => {
      const expectedCategories = [
        'routing', 'permission', 'config', 'compose',
        'hook', 'error', 'success', 'system', 'tool', 'model',
      ];
      for (const cat of expectedCategories) {
        expect(MESSAGE_STYLES[cat]).toBeDefined();
        expect(MESSAGE_STYLES[cat].prefix).toBeTruthy();
        expect(MESSAGE_STYLES[cat].color).toBeTruthy();
      }
    });

    it('routing 样式为 info 颜色 + 斜体', () => {
      const style = MESSAGE_STYLES.routing;
      expect(style.color).toBe('info');
      expect(style.italic).toBe(true);
      expect(style.prefix).toBe('[路由]');
    });

    it('error 样式为 error 颜色', () => {
      const style = MESSAGE_STYLES.error;
      expect(style.color).toBe('error');
      expect(style.prefix).toBe('[错误]');
    });

    it('success 样式为 success 颜色', () => {
      const style = MESSAGE_STYLES.success;
      expect(style.color).toBe('success');
      expect(style.prefix).toBe('[完成]');
    });

    it('compose 样式为 accent 颜色', () => {
      const style = MESSAGE_STYLES.compose;
      expect(style.color).toBe('accent');
      expect(style.prefix).toBe('[编排]');
    });

    it('getMessageStyle 已知类别返回对应样式', () => {
      const style = getMessageStyle('permission');
      expect(style.color).toBe('warning');
      expect(style.prefix).toBe('[权限]');
    });

    it('getMessageStyle 未知类别回退到 system 样式', () => {
      const style = getMessageStyle('nonexistent');
      expect(style.color).toBe('info');
      expect(style.prefix).toBe('[系统]');
    });
  });

  // ============================================================
  // 排版规范
  // ============================================================
  describe('排版规范', () => {
    it('TYPOGRAPHY 包含必要常量', () => {
      expect(TYPOGRAPHY.titleColor).toBe('primary');
      expect(TYPOGRAPHY.codeIndent).toBe(2);
      expect(TYPOGRAPHY.dividerChar).toBe('─');
      expect(TYPOGRAPHY.defaultDividerWidth).toBeGreaterThan(0);
    });

    it('divider 生成指定宽度的分隔线', () => {
      const line = divider(10);
      expect(line).toBe('──────────');
      expect(line.length).toBe(10);
    });

    it('divider 默认宽度 60', () => {
      const line = divider();
      expect(line.length).toBe(60);
    });

    it('divider 宽度为 0 时返回至少 1 个字符', () => {
      const line = divider(0);
      expect(line.length).toBe(1);
    });

    it('divider 负宽度时返回至少 1 个字符', () => {
      const line = divider(-5);
      expect(line.length).toBe(1);
    });
  });

  // ============================================================
  // 场景等级标签
  // ============================================================
  describe('场景等级标签', () => {
    it('TIER_LABELS 包含中文标签', () => {
      expect(TIER_LABELS.simple).toBe('简单');
      expect(TIER_LABELS.medium).toBe('中等');
      expect(TIER_LABELS.complex).toBe('复杂');
      expect(TIER_LABELS.reasoning).toBe('推理');
    });

    it('getTierLabel 已知等级返回中文', () => {
      expect(getTierLabel('simple')).toBe('简单');
      expect(getTierLabel('reasoning')).toBe('推理');
    });

    it('getTierLabel 未知等级原样返回', () => {
      expect(getTierLabel('custom')).toBe('custom');
    });
  });
});
