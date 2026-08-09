// scripts/fail-once.mjs
// 模拟一次 transient 工具故障：首次调用本脚本输出错误并退出 1，
// 之后调用正常执行 vitest run。
// Integrity Closure（P1-EVAL-06）：marker **成功后保留**（不删除）——
// "整个任务只失败一次"由 marker 存在性保证；marker 随 workdir 一起销毁。
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const mark = join(dirname(fileURLToPath(import.meta.url)), '..', '.fail-once.marker');
if (!existsSync(mark)) {
  writeFileSync(mark, 'consumed', 'utf-8'); // 首次：写 marker 后失败；marker 保留
  console.error('transient infrastructure error: vitest runner unavailable, retry');
  process.exit(1);
}
// 后续调用：marker 存在 → 正常执行（不再删除——保证只失败一次）
// scripts/ → fixtures/L2-05 → fixtures → repo-tasks → evals → routedev（node_modules 所在）
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'node_modules', '.bin', 'vitest');
const r = spawnSync(JSON.stringify(bin) + ' run ' + process.argv.slice(2).map((a) => JSON.stringify(a)).join(' '), { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
