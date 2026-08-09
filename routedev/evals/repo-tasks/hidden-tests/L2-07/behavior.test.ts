// hidden/behavior.test.ts
import { describe, it, expect } from 'vitest';
import { average } from '../src/score-calc.js';

describe('average（hidden）', () => {
  it('average([1,2,3]) = 2', () => {
    expect(average([1, 2, 3])).toBe(2);
  });

  it('average([4,4,4,4]) = 4', () => {
    expect(average([4, 4, 4, 4])).toBe(4);
  });
});
