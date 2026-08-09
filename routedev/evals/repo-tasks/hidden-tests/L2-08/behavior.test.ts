// hidden/behavior.test.ts
import { describe, it, expect } from 'vitest';
import { translate } from '../src/modules/mod-07.js';

describe('mod-07（hidden）', () => {
  it("translate('apple') 返回 'apple'", () => {
    expect(translate('apple')).toBe('apple');
  });

  it('其余词正常', () => {
    expect(translate('banana')).toBe('banana');
    expect(translate('elephant')).toBe('elephant');
  });
});
