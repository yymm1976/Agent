// tests/loader.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeInput } from '../src/loader.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/loader.js';

describe('sanitizeInput', () => {
  it('剥离控制字符', () => {
    expect(sanitizeInput('a\u0000b')).toBe('ab');
  });

  it('剥离尖括号', () => {
    expect(sanitizeInput('<script>')).toBe('script');
  });
});

describe('loadConfig', () => {
  it('正常配置加载', () => {
    const dir = mkdtempSync(join(tmpdir(), 'l3-11-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ name: 'svc' }), 'utf-8');
    expect(loadConfig(file).name).toBe('svc');
    rmSync(dir, { recursive: true, force: true });
  });
});
