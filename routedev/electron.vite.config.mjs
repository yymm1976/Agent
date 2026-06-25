import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Phase 38 修复：在构建时读取 package.json 版本号，避免运行时 require 相对路径在 asar 中失效
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const ROUTEDEV_VERSION = JSON.stringify(pkg.version ?? '0.0.0');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      target: 'node20',
      rollupOptions: {
        input: path.resolve(__dirname, 'desktop/main/index.ts'),
        output: { format: 'es', entryFileNames: 'index.js' },
      },
    },
    define: {
      __ROUTEDEV_VERSION__: ROUTEDEV_VERSION,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: path.resolve(__dirname, 'desktop/preload/index.ts'),
        // sandbox: true 模式下 preload 不支持 ES module import，必须用 CommonJS
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: path.resolve(__dirname, 'desktop/renderer'),
    plugins: [react()],
    css: {
      postcss: path.resolve(__dirname, 'desktop/renderer/postcss.config.js'),
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: path.resolve(__dirname, 'desktop/renderer/index.html'),
      },
    },
  },
});
