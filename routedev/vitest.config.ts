import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import fs from 'node:fs';

// Phase 38 修复：测试环境中注入构建时版本号常量，与主进程/CLI构建保持一致
const pkg = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  define: {
    __ROUTEDEV_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
  },
});
