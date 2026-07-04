// tests/skills/progressive-disclosure.test.ts
// Phase 71 Task D6：渐进式披露单元测试
// 覆盖：
//   1. computeDisclosureLevel 四条决策路径
//   2. applyDisclosure 三档（summary/key-details/full）行为
//   3. disclose 便捷函数

import { describe, it, expect } from 'vitest';
import {
  computeDisclosureLevel,
  applyDisclosure,
  disclose,
  type DisclosureContext,
} from '../../src/skills/progressive-disclosure.js';

function makeCtx(overrides: Partial<DisclosureContext> = {}): DisclosureContext {
  return {
    tokenUsageRatio: 0.5,
    expertiseLevel: 'intermediate',
    taskComplexity: 'medium',
    ...overrides,
  };
}

describe('progressive-disclosure', () => {
  describe('computeDisclosureLevel', () => {
    it('上下文占用 >80% → summary', () => {
      expect(computeDisclosureLevel(makeCtx({ tokenUsageRatio: 0.85 }))).toBe('summary');
    });

    it('专家 + 低复杂度 → summary', () => {
      expect(computeDisclosureLevel(makeCtx({
        tokenUsageRatio: 0.3,
        expertiseLevel: 'expert',
        taskComplexity: 'low',
      }))).toBe('summary');
    });

    it('初学者 → full', () => {
      expect(computeDisclosureLevel(makeCtx({
        expertiseLevel: 'beginner',
      }))).toBe('full');
    });

    it('默认（中等用户 + 中等复杂度）→ key-details', () => {
      expect(computeDisclosureLevel(makeCtx())).toBe('key-details');
    });
  });

  describe('applyDisclosure', () => {
    it('summary 压缩到首 5 行 + 标记', () => {
      const content = 'line1\nline2\nline3\nline4\nline5\nline6\nline7';
      const result = applyDisclosure(content, 'summary');
      expect(result).toContain('line1');
      expect(result).toContain('[已压缩...]');
      expect(result).not.toContain('line7');
    });

    it('summary 对短内容（<=5 行）不压缩', () => {
      const content = 'line1\nline2\nline3';
      const result = applyDisclosure(content, 'summary');
      expect(result).toBe(content);
    });

    it('key-details 合并连续空行', () => {
      const content = 'line1\n\n\n\nline2';
      const result = applyDisclosure(content, 'key-details');
      expect(result).toBe('line1\n\nline2');
    });

    it('full 保留原内容', () => {
      const content = 'line1\n\n\n\nline2';
      const result = applyDisclosure(content, 'full');
      expect(result).toBe(content);
    });
  });

  describe('disclose', () => {
    it('便捷函数：计算级别并应用', () => {
      const content = 'line1\nline2\nline3\nline4\nline5\nline6\nline7';
      const result = disclose(content, makeCtx({ tokenUsageRatio: 0.85 }));
      expect(result).toContain('[已压缩...]');
    });
  });
});
