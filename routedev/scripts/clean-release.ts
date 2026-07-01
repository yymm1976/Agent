// scripts/clean-release.ts
// Phase 40 Task 0：构建前清理 stale release 目录
// 作为 predist:electron hook 运行，避免 Windows Defender 锁文件导致构建失败
// 运行方式：tsx scripts/clean-release.ts

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 类型定义
// ============================================================

/** 清理选项 */
export interface CleanOptions {
  /** 保留的输出目录名（当前输出目录，如 release-v3） */
  keep: string;
  /** 匹配 stale 目录的正则，如 /^release-v\d+\w*$/ */
  stalePattern: RegExp;
  /** 只打印不删除，默认 false */
  dryRun: boolean;
  /** 删除重试次数，默认 3 */
  maxRetries: number;
  /** 重试间隔（毫秒），默认 1000 */
  retryDelayMs: number;
}

/** 清理结果 */
export interface CleanResult {
  /** 已清理的目录名列表 */
  cleaned: string[];
  /** 清理失败的目录名列表 */
  failed: string[];
}

// ============================================================
// 默认配置
// ============================================================

/** 默认清理选项，keep 需与 electron-builder.yml 中 directories.output 一致 */
export const DEFAULT_CLEAN_OPTIONS: CleanOptions = {
  // Phase 54：v5 → v6，与 electron-builder.yml 同步（临时绕过 release-v4/v5 锁定问题）
  keep: 'release-v6',
  stalePattern: /^release-v\d+\w*$/,
  dryRun: false,
  maxRetries: 1,
  retryDelayMs: 1000,
};

// ============================================================
// 工具函数
// ============================================================

/** 延时 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 终止所有 Electron/RouteDev 相关进程（仅 Windows）。
 * 使用 taskkill /F 强制终止，忽略进程不存在的错误。
 */
export function killElectronProcesses(): void {
  if (process.platform !== 'win32') return;
  const targets = ['electron.exe', 'RouteDev.exe'];
  for (const target of targets) {
    try {
      spawnSync('taskkill', ['/F', '/IM', target, '/T'], {
        stdio: 'ignore',
        shell: true,
      });
    } catch {
      // 忽略：进程不存在
    }
  }
}

/**
 * 带重试的目录删除。
 * @returns true 表示删除成功，false 表示重试耗尽仍失败
 */
async function removeWithRetry(
  dir: string,
  maxRetries: number,
  retryDelayMs: number
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        console.warn(
          `  ! 删除失败 (尝试 ${attempt}/${maxRetries}): ${path.basename(dir)} - ${msg}`
        );
        await sleep(retryDelayMs);
      } else {
        console.error(
          `  X 删除失败 (已重试 ${maxRetries} 次): ${path.basename(dir)} - ${msg}`
        );
      }
    }
  }
  return false;
}

// ============================================================
// 核心实现
// ============================================================

/**
 * 在指定根目录下清理 stale release 目录。
 * 仅执行枚举、跳过 keep、删除（或 dryRun 打印），不含进程终止和等待。
 * 供测试直接调用。
 */
export async function cleanStaleDirectoriesIn(
  rootDir: string,
  options: CleanOptions
): Promise<CleanResult> {
  const cleaned: string[] = [];
  const failed: string[] = [];

  // 枚举根目录下匹配 stalePattern 的目录
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => options.stalePattern.test(name));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  X 无法读取目录 ${rootDir}: ${msg}`);
    return { cleaned, failed };
  }

  if (entries.length === 0) {
    console.log('  - 未发现 stale release 目录');
    return { cleaned, failed };
  }

  for (const name of entries) {
    // 跳过 keep 目录（当前输出目录）
    if (name === options.keep) {
      console.log(`  > 跳过当前输出目录: ${name}`);
      continue;
    }

    const fullPath = path.join(rootDir, name);

    if (options.dryRun) {
      console.log(`  [dry-run] 将删除: ${name}`);
      continue;
    }

    console.log(`  * 删除: ${name}`);
    const ok = await removeWithRetry(
      fullPath,
      options.maxRetries,
      options.retryDelayMs
    );
    if (ok) {
      cleaned.push(name);
    } else {
      failed.push(name);
    }
  }

  return { cleaned, failed };
}

/**
 * 清理输出目录内容（win-unpacked 和旧安装包）。
 * electron-builder 的 EnsureEmptyDir 会尝试删除 win-unpacked，
 * 但若 app.asar 被 Defender 锁定则失败。此处提前清理，带重试。
 */
async function cleanOutputContents(
  outputDir: string,
  maxRetries: number,
  retryDelayMs: number
): Promise<void> {
  const winUnpacked = path.join(outputDir, 'win-unpacked');
  if (!fs.existsSync(winUnpacked)) return;

  console.log(`-> 清理输出目录内容: ${path.basename(outputDir)}/win-unpacked`);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.rmSync(winUnpacked, { recursive: true, force: true });
      console.log(`  ✓ win-unpacked 已清理`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxRetries) {
        console.warn(
          `  ! 清理失败 (尝试 ${attempt}/${maxRetries}): ${msg}`
        );
        await sleep(retryDelayMs);
      } else {
        console.error(
          `  X 清理失败 (已重试 ${maxRetries} 次): ${msg}`
        );
        console.error(`  ! electron-builder 可能因锁文件失败，请手动删除或等待 Defender 释放`);
      }
    }
  }
}

/**
 * 清理 stale release 目录（完整流程）。
 * 1. 终止所有 Electron/RouteDev 相关进程
 * 2. 等待 2 秒（让文件句柄释放）
 * 3. 清理输出目录内容（win-unpacked，避免 Defender 锁 app.asar）
 * 4. 枚举项目根目录下匹配 stalePattern 的目录
 * 5. 跳过 keep 目录
 * 6. 用 fs.rmSync 删除，带 maxRetries + retryDelayMs 重试
 * 7. dryRun 模式只打印不删除
 * 8. 返回清理结果
 */
export async function cleanStaleDirectories(
  options: CleanOptions
): Promise<CleanResult> {
  console.log('===================================================');
  console.log('  RouteDev stale release 目录清理');
  console.log('===================================================');

  // Step 1: 终止 Electron/RouteDev 进程
  console.log('-> 终止 Electron/RouteDev 进程...');
  killElectronProcesses();

  // Step 2: 等待 2 秒（让文件句柄释放）
  console.log('-> 等待 2 秒（文件句柄释放）...');
  await sleep(2000);

  // Step 3: 清理输出目录内容（win-unpacked，Defender 锁文件治理）
  const rootDir = process.cwd();
  const outputDir = path.join(rootDir, options.keep);
  await cleanOutputContents(outputDir, options.maxRetries, options.retryDelayMs);

  // Steps 4-8: 清理 stale 目录
  console.log(`-> 扫描根目录: ${rootDir}`);
  const result = await cleanStaleDirectoriesIn(rootDir, options);

  // 汇总
  console.log('');
  console.log(
    `  清理完成: ${result.cleaned.length} 个目录已删除, ${result.failed.length} 个失败`
  );
  if (result.failed.length > 0) {
    console.log(`  失败目录: ${result.failed.join(', ')}`);
  }
  console.log('===================================================');

  return result;
}

// ============================================================
// 主入口
// ============================================================

async function main(): Promise<void> {
  const result = await cleanStaleDirectories(DEFAULT_CLEAN_OPTIONS);
  // predist 钩子：删除失败只警告不阻断构建（Defender 锁文件是常见情况）
  // 构建脚本会自动使用当前 output 目录，stale 目录残留不影响构建
  process.exit(0);
}

// 仅在直接执行时运行 main（被 import 时不执行）
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main();
}
