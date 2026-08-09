// tests/config.test.ts
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/loader.js';
import { bootstrap } from '../src/main.js';

describe('parseConfig', () => {
  it('解析基础字段', () => {
    const cfg = parseConfig({ name: 'svc', timeoutSeconds: 60 });
    expect(cfg.name).toBe('svc');
    expect(cfg.timeoutSeconds).toBe(60);
  });

  it('缺省 timeoutSeconds 用默认 30', () => {
    const cfg = parseConfig({ name: 'svc' });
    expect(cfg.timeoutSeconds).toBe(30);
  });

  it('name 缺失抛错', () => {
    expect(() => parseConfig({})).toThrow('name');
  });
});

describe('bootstrap', () => {
  it('透传配置到服务', () => {
    const s = bootstrap({ name: 'svc', timeoutSeconds: 5 });
    expect(s.timeoutSeconds).toBe(5);
    expect(s.name).toBe('svc');
  });
});
