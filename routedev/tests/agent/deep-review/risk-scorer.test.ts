// tests/agent/deep-review/risk-scorer.test.ts
// Phase 72：风险评分器测试

import { describe, it, expect } from 'vitest';
import { scoreRisk } from '../../../src/agent/deep-review/risk-scorer.js';

/** 构造一个简单的 diff 文本（含 N 行新增） */
function makeDiff(addedLines: number, removedLines = 0, newFiles = 0): string {
  const lines: string[] = [];
  // diff 头
  lines.push('diff --git a/foo.ts b/foo.ts');
  if (newFiles > 0) lines.push('new file mode 100644');
  lines.push('index 1234567..89abcde 100644');
  lines.push('--- a/foo.ts');
  lines.push('+++ b/foo.ts');
  lines.push('@@ -1,1 +1,1 @@');
  for (let i = 0; i < addedLines; i++) lines.push(`+added line ${i}`);
  for (let i = 0; i < removedLines; i++) lines.push(`-removed line ${i}`);
  return lines.join('\n');
}

describe('risk-scorer', () => {
  describe('scoreRisk', () => {
    it('空变更返回 0 分', () => {
      expect(scoreRisk('', [])).toBe(0);
    });

    it('少量变更返回低分', () => {
      // 10 行新增，1 文件 → 行数 0 分 + 文件 3 分 = 3 分
      const diff = makeDiff(10);
      const score = scoreRisk(diff, ['foo.ts']);
      expect(score).toBeLessThanOrEqual(10);
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('大量变更返回高分', () => {
      // 500 行新增，5 文件 → 行数 30 分（上限）+ 文件 15 分 = 45 分
      const diff = makeDiff(500);
      const score = scoreRisk(diff, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
      expect(score).toBeGreaterThanOrEqual(40);
    });

    it('关键路径文件加分', () => {
      // security/ 路径文件每个 +8 分
      const diff = makeDiff(10);
      const normalScore = scoreRisk(diff, ['foo.ts']);
      const criticalScore = scoreRisk(diff, ['security/auth.ts']);
      expect(criticalScore).toBeGreaterThan(normalScore);
      expect(criticalScore - normalScore).toBeGreaterThanOrEqual(8);
    });

    it('多个关键路径文件加分有上限', () => {
      // 5 个关键路径文件 → 5*8=40，但上限 30
      const diff = makeDiff(10);
      const score = scoreRisk(diff, [
        'security/a.ts', 'config/b.ts', 'auth/c.ts',
        'permission/d.ts', 'crypto/e.ts',
      ]);
      // 行数 0 + 文件 15 (5*3) + 关键路径 30 (上限) = 45
      expect(score).toBe(45);
    });

    it('删除占比高加分', () => {
      // 30 行删除 + 10 行新增 → 删除占比 75% > 30% → +10 分
      const diff = makeDiff(10, 30);
      const highRemoveScore = scoreRisk(diff, ['foo.ts']);
      // 10 行新增 + 30 行删除 = 40 行变更 → 行数 0 分（不足 50）
      // 文件 3 分 + 删除占比 10 分 = 13 分
      expect(highRemoveScore).toBeGreaterThanOrEqual(13);
    });

    it('删除占比低不加分', () => {
      // 10 行删除 + 90 行新增 → 删除占比 10% < 30% → 不加分
      const diff = makeDiff(90, 10);
      const lowRemoveScore = scoreRisk(diff, ['foo.ts']);
      // 行数 100/50=2 → 10 分 + 文件 3 分 = 13 分（无删除加分）
      expect(lowRemoveScore).toBe(13);
    });

    it('新增文件加分', () => {
      const diff = makeDiff(10, 0, 1);
      const score = scoreRisk(diff, ['foo.ts']);
      // 行数 0 + 文件 3 + 新增 2 = 5 分
      expect(score).toBeGreaterThanOrEqual(5);
    });

    it('评分不超过 100', () => {
      // 极端场景：大量变更 + 多关键路径 + 多新增文件
      const diff = makeDiff(10000, 5000, 50);
      const score = scoreRisk(diff, [
        'security/a.ts', 'config/b.ts', 'auth/c.ts',
        'permission/d.ts', 'crypto/e.ts', 'f.ts', 'g.ts', 'h.ts',
      ]);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('评分非负', () => {
      // 极端场景：空 diff 但有文件
      const score = scoreRisk('', ['foo.ts']);
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('Windows 反斜杠路径也能识别关键路径', () => {
      const diff = makeDiff(10);
      const score = scoreRisk(diff, ['src\\security\\auth.ts']);
      const normalScore = scoreRisk(diff, ['src\\utils\\helper.ts']);
      expect(score).toBeGreaterThan(normalScore);
    });
  });
});
