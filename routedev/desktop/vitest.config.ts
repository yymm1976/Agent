// desktop/vitest.config.ts
// TD-14：desktop/ 专用 vitest 配置
// 独立于根目录 vitest.config.ts（后者服务于 src/ 测试，environment 为 node）
// 渲染层组件测试需要 DOM 环境，因此用 happy-dom + @testing-library

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';

// 读取版本号，与根配置保持一致（注入构建时常量）
const pkg = JSON.parse(fs.readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // 渲染层组件测试需要 DOM 环境
    environment: 'happy-dom',
    // 仅包含 desktop/ 下的测试，避免与根目录 tests/ 冲突
    include: ['desktop/**/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['desktop/test-setup.ts'],
    // desktop 测试互相独立，可用 forks 池
    pool: 'forks',
  },
  resolve: {
    // 与 desktop/tsconfig.desktop.json 的 paths 对齐
    alias: {
      '@': resolve(__dirname, 'renderer/src'),
      '@shared': resolve(__dirname, 'shared'),
    },
  },
  define: {
    __ROUTEDEV_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
  },
});
