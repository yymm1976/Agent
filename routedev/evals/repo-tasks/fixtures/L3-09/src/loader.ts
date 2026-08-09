// src/loader.ts
// 配置加载器
import { readFileSync } from 'node:fs';
import { parseConfig, type AppConfig } from './config-schema.js';

export function loadConfig(path: string): AppConfig {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  return parseConfig(raw);
}
