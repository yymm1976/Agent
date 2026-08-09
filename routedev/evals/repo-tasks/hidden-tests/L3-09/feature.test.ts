// hidden/feature.test.ts
// logLevel 功能全链一致：schema → loader → logger
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config-schema.js';
import { loadConfig } from '../src/loader.js';
import { log } from '../src/logger.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('logLevel 功能（hidden）', () => {
  it('parseConfig 接受合法 logLevel 并校验非法值', () => {
    expect(parseConfig({ name: 'svc', logLevel: 'warn' }).logLevel).toBe('warn');
    expect(() => parseConfig({ name: 'svc', logLevel: 'verbose' })).toThrow();
  });

  it('缺省 logLevel 为 info', () => {
    expect(parseConfig({ name: 'svc' }).logLevel).toBe('info');
  });

  it('loadConfig 透传 logLevel（文件加载）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'l3-09-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ name: 'svc', logLevel: 'debug' }), 'utf-8');
    const cfg = loadConfig(file);
    expect(cfg.logLevel).toBe('debug');
    rmSync(dir, { recursive: true, force: true });
  });

  it('logger 按级别过滤（低于配置级别不输出）', () => {
    const cfg = parseConfig({ name: 'svc', logLevel: 'warn' });
    expect(log('info', 'x', cfg.logLevel)).toBe('');
    expect(log('warn', 'x', cfg.logLevel)).toBe('[warn] x');
  });
});
