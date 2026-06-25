import { defineConfig } from 'tsup';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Phase 38 修复：CLI 构建时注入版本号，避免运行时 require 相对路径在某些环境下失效
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const ROUTEDEV_VERSION = JSON.stringify(pkg.version ?? '0.0.0');

export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  // 支持 JSX/TSX
  jsx: 'automatic',
  external: ['react', 'ink'],
  esbuildOptions(options) {
    options.define = {
      ...options.define,
      __ROUTEDEV_VERSION__: ROUTEDEV_VERSION,
    };
  },
});
