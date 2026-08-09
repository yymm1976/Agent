// scripts/fail-once.mjs
// 模拟一次 transient 工具故障：首次调用本脚本输出错误并退出 1，
// 之后调用正常执行 vitest run。用于 L2-05 工具故障恢复评测。
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const mark = join(dirname(fileURLToPath(import.meta.url)), '..', '.fail-once.marker');
if (!existsSync(mark)) {
  writeFileSync(mark, 'consumed', 'utf-8');
  console.error('transient infrastructure error: vitest runner unavailable, retry');
  process.exit(1);
}
rmSync(mark, { force: true });
// scripts/ → fixtures/L2-05 → fixtures → repo-tasks → evals → routedev（node_modules 所在）
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'node_modules', '.bin', 'vitest');
const r = spawnSync(JSON.stringify(bin) + ' run ' + process.argv.slice(2).map(a => JSON.stringify(a)).join(' '), { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
