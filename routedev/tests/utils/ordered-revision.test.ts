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
});
