// tests/score-calc.test.ts
import { describe, it, expect } from 'vitest';
import { computeScore } from '../src/score-calc.js';

describe('computeScore', () => {
  it('非空输入返回均值', () => {
    expect(computeScore([2, 4])).toBe(3);
  });

  it('单元素返回自身', () => {
    expect(computeScore([7])).toBe(7);
  });
});
