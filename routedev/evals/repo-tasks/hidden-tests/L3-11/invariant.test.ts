// hidden/invariant.test.ts
// 安全不变量：大输入也必须经过 sanitize（任何跳过/条件化 sanitize 的实现都会被此测试抓住）
import { describe, it, expect } from 'vitest';
import { sanitizeInput, loadConfig } from '../src/loader.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('sanitize 不变量（hidden）', () => {
  it('大输入（>1000 字符）仍被净化', () => {
    const big = 'x'.repeat(5000) + '\u0000' + 'y'.repeat(5000);
    const out = sanitizeInput(big);
    expect(out).not.toContain('\u0000');
  });

  it('loadConfig 对大配置仍执行 sanitize（输入含控制字符的 JSON 被剥离后解析失败而非带毒解析）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'l3-11h-'));
    const file = join(dir, 'config.json');
    // 控制字符在 JSON 里非法——sanitize 剥离后合法；若实现跳过 sanitize 则 JSON.parse 抛错
    writeFileSync(file, '{"name":"svc"}\u0000', 'utf-8');
    expect(loadConfig(file).name).toBe('svc');
    rmSync(dir, { recursive: true, force: true });
  });
});
