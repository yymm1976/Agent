// tests/score-calc.test.ts
import { describe, it, expect } from 'vitest';
import { min, max } from '../src/score-calc.js';

describe('min/max', () => {
  it('min 与 max', () => {
    expect(min([3, 1, 2])).toBe(1);
    expect(max([3, 1, 2])).toBe(3);
  });
});
