// tests/modules.test.ts
import { describe, it, expect } from 'vitest';
import { translate as t1 } from '../src/modules/mod-01.js';
import { translate as t3 } from '../src/modules/mod-03.js';
import { translate as t12 } from '../src/modules/mod-12.js';

describe('modules 常规路径', () => {
  it('mod-01 apple', () => {
    expect(t1('apple')).toBe('apple');
  });
  it('mod-03 banana', () => {
    expect(t3('banana')).toBe('banana');
  });
  it('mod-12 dog', () => {
    expect(t12('dog')).toBe('dog');
  });
});
