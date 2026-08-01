// tests/memory/hit-stat.test.ts
// Phase 97 Part I Task I2：触发率统计与低效淘汰
// 覆盖：record 计数、报表排序、低触发评估、reset、边界输入

import { describe, expect, it } from 'vitest';
import { HitStat } from '../../src/memory/hit-stat.js';

describe('HitStat.record / getCount', () => {
  it('记录一次命中并累加计数', () => {
    const stat = new HitStat();
    stat.record('memory:node-1', 'memory');
    stat.record('memory:node-1', 'memory');
    expect(stat.getCount('memory:node-1')).toBe(2);
  });

  it('不同 key 独立计数', () => {
    const stat = new HitStat();
    stat.record('memory:a', 'memory');
    stat.record('skill:b', 'skill');
    expect(stat.getCount('memory:a')).toBe(1);
    expect(stat.getCount('skill:b')).toBe(1);
    expect(stat.getCount('未命中')).toBe(0);
  });

  it('空 key 静默忽略（fail-open）', () => {
    const stat = new HitStat();
    stat.record('', 'memory');
    stat.record('', 'memory');
    expect(stat.report()).toEqual([]);
  });
});

describe('HitStat.report', () => {
  it('按类别 + 次数降序返回全部条目', () => {
    const stat = new HitStat();
    stat.record('memory:node-1', 'memory');
    stat.record('memory:node-1', 'memory');
    stat.record('skill:alpha', 'skill');
    stat.record('userProfile', 'userProfile');
    stat.record('userProfile', 'userProfile');
    const entries = stat.report();
    expect(entries).toHaveLength(3);
    // 类别升序：memory < skill < userProfile
    expect(entries[0].key).toBe('memory:node-1');
    expect(entries[0].count).toBe(2);
    expect(entries[1].key).toBe('skill:alpha');
    expect(entries[2].key).toBe('userProfile');
  });

  it('记录最近命中时间', () => {
    const stat = new HitStat();
    const at = 1700000000000;
    stat.record('memory:a', 'memory', at);
    expect(stat.getLastHitAt('memory:a')).toBe(at);
  });
});

describe('HitStat.evaluateLowHits', () => {
  it('窗口内未命中的条目判为低触发（hitsInWindow=0）', () => {
    const stat = new HitStat();
    const since = 1000;
    stat.record('memory:old', 'memory', 500); // 早于窗口起点
    const low = stat.evaluateLowHits(since, 1);
    expect(low).toHaveLength(1);
    expect(low[0].key).toBe('memory:old');
    expect(low[0].hitsInWindow).toBe(0);
  });

  it('窗口内命中达到阈值的条目不判为低触发', () => {
    const stat = new HitStat();
    const since = 1000;
    stat.record('memory:hot', 'memory', 2000);
    expect(stat.evaluateLowHits(since, 1)).toEqual([]);
  });

  it('minHits<=0 时返回空数组（不淘汰）', () => {
    const stat = new HitStat();
    stat.record('memory:a', 'memory', 100);
    expect(stat.evaluateLowHits(0, 0)).toEqual([]);
  });

  it('混合场景：只有低于阈值条目被返回', () => {
    const stat = new HitStat();
    const since = 1000;
    stat.record('memory:hot', 'memory', 2000);   // 窗口内 1 次，>= 1 不淘汰
    stat.record('memory:cold', 'memory', 500);   // 早于窗口，淘汰
    stat.record('skill:dead', 'skill', 900);     // 早于窗口，淘汰
    const low = stat.evaluateLowHits(since, 1);
    expect(low.map((e) => e.key).sort()).toEqual(['memory:cold', 'skill:dead']);
  });
});

describe('HitStat.reset', () => {
  it('清空全部计数', () => {
    const stat = new HitStat();
    stat.record('memory:a', 'memory');
    stat.reset();
    expect(stat.report()).toEqual([]);
    expect(stat.getCount('memory:a')).toBe(0);
  });
});
