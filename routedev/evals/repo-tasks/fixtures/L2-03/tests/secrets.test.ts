// tests/secrets.test.ts
import { describe, it, expect } from 'vitest';
import { SECRETS_VERSION } from '../src/secrets.js';

describe('secrets 模块', () => {
  it('模块版本号存在', () => {
    expect(SECRETS_VERSION).toBe(1);
  });
});
