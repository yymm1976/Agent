// tests/utils/ordered-revision.test.ts
// 第九轮复审：确定性顺序原语
//
// 契约：
// 1. compareRevision 是唯一权威比较（wallTimeMs → sequence → id）
// 2. 同毫秒连续创建仍保持严格顺序（sequence 单调）
// 3. id 字符串序与 compareRevision 一致（可排序 id）
// 4. 任意两个 revision 比较确定（无相等歧义）

import { describe, it, expect } from 'vitest';
import { createOrderedRevision, compareRevision } from '../../src/utils/ordered-revision.js';

describe('第九轮 OrderedRevision 原语', () => {
  it('同毫秒连续创建保持严格顺序（sequence 单调 tie-breaker）', () => {
    const now = 1786123456789;
    const a = createOrderedRevision(now);
    const b = createOrderedRevision(now);
    const c = createOrderedRevision(now);
    expect(compareRevision(a, b)).toBeLessThan(0);
    expect(compareRevision(b, c)).toBeLessThan(0);
    expect(compareRevision(a, c)).toBeLessThan(0);
  });

  it('跨毫秒按 wallTimeMs 排序（sequence 次之）', () => {
    const earlier = createOrderedRevision(1000);
    const later = createOrderedRevision(2000);
    expect(compareRevision(earlier, later)).toBeLessThan(0);
    // 早毫秒的更高 sequence 仍排在晚毫秒之后
    for (let i = 0; i < 10; i += 1) createOrderedRevision(1000);
    const lateAgain = createOrderedRevision(3000);
    expect(compareRevision(earlier, lateAgain)).toBeLessThan(0);
  });

  it('id 字符串序与 compareRevision 一致（可排序 id）', () => {
    const now = 1786123456789;
    const a = createOrderedRevision(now);
    const b = createOrderedRevision(now);
    expect(a.id < b.id).toBe(compareRevision(a, b) < 0);
  });

  it('id 含随机分量（跨进程/重启同毫秒不冲突）', () => {
    const now = 1786123456789;
    const ids = new Set(Array.from({ length: 20 }, () => createOrderedRevision(now).id));
    expect(ids.size).toBe(20);
  });

  it('A4 修复：id 字符串序与数值序一致（fixed-width 进位边界）', () => {
    // 变长 base36 在进位边界错序：'9' vs '10'（字典序 '10' < '9'）、
    // 'z' vs '10'（36 进制 z=35 → 10=36）。fixed-width 后字符串序 = 数值序。
    const base = 1786123456789;
    const revisions = [0, 9, 10, 35, 36, 1295, 1296, base].map((v) => createOrderedRevision(v));
    for (let i = 1; i < revisions.length; i += 1) {
      expect(revisions[i - 1].id < revisions[i].id).toBe(true);
      expect(compareRevision(revisions[i - 1], revisions[i])).toBeLessThan(0);
    }
  });

  it('A4 修复：id 定长前缀（timestamp 10 位 + sequence 6 位 base36）', () => {
    const now = 1786123456789;
    const a = createOrderedRevision(now);
    const b = createOrderedRevision(now);
    const [tsA, seqA] = a.id.split('-');
    expect(tsA.length).toBe(10);
    expect(seqA.length).toBe(6);
    expect(seqA < b.id.split('-')[1]).toBe(true);
  });
});
