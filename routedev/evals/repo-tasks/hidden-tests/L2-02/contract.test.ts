// hidden/contract.test.ts
// 结构化 timeout 字段契约：types/loader/caller 全链一致
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/loader.js';
import { bootstrap } from '../src/main.js';
import type { AppConfig } from '../src/config-types.js';

describe('结构化 timeout 契约（hidden）', () => {
  it('类型层：AppConfig.timeout 为 { seconds: number }', () => {
    // 编译期由 import type 保证；运行时验证 parseConfig 产出结构
    const cfg: AppConfig = parseConfig({ name: 'svc', timeout: { seconds: 42 } });
    expect(cfg.timeout).toEqual({ seconds: 42 });
  });

  it('loader 支持结构化字段', () => {
    const cfg = parseConfig({ name: 'svc', timeout: { seconds: 42 } });
    expect(cfg.timeout.seconds).toBe(42);
  });

  it('legacy 平铺字段仍被兼容', () => {
    const cfg = parseConfig({ name: 'svc', timeoutSeconds: 30 });
    expect(cfg.timeout.seconds).toBe(30);
  });

  it('调用链（bootstrap/server）消费结构化字段', () => {
    // Eval Fix 2：prompt 要求全链迁移（type/loader/bootstrap/server/tests 一致）——
    // server 边界同样消费 timeout: { seconds }，不再要求旧 scalar timeoutSeconds
    const s = bootstrap({ name: 'svc', timeout: { seconds: 9 } });
    expect(s.timeout.seconds).toBe(9);
  });
});
