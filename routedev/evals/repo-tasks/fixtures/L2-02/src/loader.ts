// src/loader.ts
// 配置加载器：raw JSON → AppConfig
import type { AppConfig } from './config-types.js';

export function parseConfig(raw: Record<string, unknown>): AppConfig {
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error('name is required');
  }
  const timeoutSeconds = typeof raw.timeoutSeconds === 'number' ? raw.timeoutSeconds : 30;
  return { name: raw.name, timeoutSeconds };
}
