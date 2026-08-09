// src/main.ts
// 应用入口：装配配置并启动服务
import { parseConfig } from './loader.js';
import { startServer } from './server.js';

export function bootstrap(raw: Record<string, unknown>) {
  const config = parseConfig(raw);
  return startServer({ name: config.name, timeoutSeconds: config.timeoutSeconds });
}
