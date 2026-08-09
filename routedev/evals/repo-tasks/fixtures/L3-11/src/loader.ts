// src/loader.ts
// 配置加载器：输入必须经过 sanitize（安全不变量——不可跳过，见 SECURITY.md）
import { readFileSync } from 'node:fs';

export interface LoadedConfig {
  name: string;
}

/** 输入净化：剥离控制字符与危险引号（安全不变量） */
export function sanitizeInput(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>]/g, '');
}

export function loadConfig(path: string): LoadedConfig {
  const raw = readFileSync(path, 'utf-8');
  const sanitized = sanitizeInput(raw); // 任何输入都必须经过此步骤
  const parsed = JSON.parse(sanitized) as { name?: unknown };
  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    throw new Error('name is required');
  }
  return { name: parsed.name };
}
