// tests/evals/fs-utils.ts
// 递归目录复制助手（避免依赖 fs.cpSync：部分受限环境对递归复制返回 EIO）
// fixture 均为小文件，同步实现足够。
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) {
      copyDirSync(from, to);
    } else {
      writeFileSync(to, readFileSync(from));
    }
  }
}
