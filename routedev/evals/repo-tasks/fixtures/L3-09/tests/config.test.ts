// tests/config.test.ts
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config-schema.js';
import { log } from '../src/logger.js';

describe('config 基础', () => {
  it('name 解析', () => {
    expect(parseConfig({ name: 'svc' }).name).toBe('svc');
  });
  it('name 缺失抛错', () => {
    expect(() => parseConfig({})).toThrow('name');
  });
});

describe('logger 基础', () => {
  it('log 输出带级别前缀', () => {
    expect(log('info', 'hi')).toBe('[info] hi');
  });
});
