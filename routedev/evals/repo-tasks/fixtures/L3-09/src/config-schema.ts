// src/config-schema.ts
// 配置 schema 与解析
export interface AppConfig {
  name: string;
}

export function parseConfig(raw: Record<string, unknown>): AppConfig {
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new Error('name is required');
  }
  return { name: raw.name };
}
