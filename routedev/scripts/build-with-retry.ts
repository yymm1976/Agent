// scripts/build-with-retry.ts
// Phase 40 Task 0：构建重试包装脚本
// 最多重试 3 次，每次重试前等待 5 秒并清理 stale 目录
// 运行方式：tsx scripts/build-with-retry.ts

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanStaleDirectories, DEFAULT_CLEAN_OPTIONS } from './clean-release.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
// 与 dist:electron 脚本保持一致
const BUILD_COMMAND = 'electron-vite build && electron-builder';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('===================================================');
  console.log('  RouteDev 安全构建（带重试）');
  console.log('===================================================');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`\n> 构建尝试 ${attempt}/${MAX_RETRIES}`);

    // 重试前等待 5 秒
    if (attempt > 1) {
      console.log(`-> 等待 ${RETRY_DELAY_MS / 1000} 秒后重试...`);
      await sleep(RETRY_DELAY_MS);
    }

    // 每次尝试前清理 stale 目录
    console.log('-> 清理 stale release 目录...');
    await cleanStaleDirectories(DEFAULT_CLEAN_OPTIONS);

    // 执行构建
    console.log(`-> 执行: ${BUILD_COMMAND}`);
    try {
      execSync(BUILD_COMMAND, {
        stdio: 'inherit',
        cwd: process.cwd(),
        shell: true,
      });
      console.log('\n===================================================');
      console.log('  [OK] 构建成功');
      console.log('===================================================');
      process.exit(0);
    } catch (err) {
      console.error(`\n[X] 构建尝试 ${attempt} 失败`);
      if (attempt < MAX_RETRIES) {
        console.log('-> 将重试...');
      }
    }
  }

  console.error('\n===================================================');
  console.error('  [X] 构建失败（已重试 3 次）');
  console.error('===================================================');
  process.exit(1);
}

main();
