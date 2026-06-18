// scripts/perf-gate.ts
// Phase 28 Task 2：性能基线强制门脚本
// 独立运行性能测试，返回 0（通过）/ 1（失败）退出码
// 用于 CI/CD 流水线，任何性能退化都阻止发布

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const PERF_TEST_FILE = 'tests/integration/performance-benchmark.test.ts';
const TEST_TIMEOUT = 60000; // 60 秒超时

function main(): void {
  console.log('═══════════════════════════════════════════════════');
  console.log('  RouteDev 性能基线强制门 (perf-gate)');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  const testFile = resolve(process.cwd(), PERF_TEST_FILE);

  try {
    // 运行性能测试，使用较长超时
    const cmd = `pnpm vitest run "${testFile}" --testTimeout=${TEST_TIMEOUT}`;
    console.log(`执行: ${cmd}\n`);

    execSync(cmd, {
      stdio: 'inherit',
      cwd: process.cwd(),
      timeout: TEST_TIMEOUT + 10000, // 总超时比单测试多 10 秒
    });

    console.log('\n═══════════════════════════════════════════════════');
    console.log('  ✅ 性能基线强制门通过');
    console.log('═══════════════════════════════════════════════════\n');
    process.exit(0);
  } catch (err) {
    console.error('\n═══════════════════════════════════════════════════');
    console.error('  ❌ 性能基线强制门失败');
    console.error('  性能退化已阻止发布，请检查上述失败测试');
    console.error('═══════════════════════════════════════════════════\n');
    process.exit(1);
  }
}

main();
