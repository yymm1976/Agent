// src/agent/completion-gate.ts
// Phase 31 Task 6.4：独立代码验证门（Completion Gate）
// 不信任 LLM 的"已完成"判断——通过 typecheck/lint/tests 独立验证
// 通过 spawnSync 调用外部进程，必须设 timeout，否则可能永久阻塞

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

// --- 类型 ---

/**
 * 单项检查结果
 */
export interface GateCheck {
  /** 检查名称（typecheck/lint/tests） */
  name: string;
  /** 是否通过 */
  ok: boolean;
  /** 是否因超时被跳过（不阻断任务完成） */
  skipped?: boolean;
  /** 输出内容（失败时截取前 500 字符） */
  output: string;
  /** 耗时（毫秒） */
  duration: number;
}

/**
 * 验证门总结果
 */
export interface GateResult {
  /** 是否全部通过（skipped 不算失败） */
  passed: boolean;
  /** 各项检查结果 */
  checks: GateCheck[];
}

/**
 * CompletionGate 配置
 */
interface CompletionGateConfig {
  /** 总超时（毫秒） */
  gateTimeout: number;
  /** 验证失败后最多重试次数 */
  gateRetry: number;
}

// 默认配置
const DEFAULT_CONFIG: CompletionGateConfig = {
  gateTimeout: 180000,
  gateRetry: 1,
};

// 单项检查超时
const TYPECHECK_TIMEOUT = 60000; // 60 秒
const LINT_TIMEOUT = 60000; // 60 秒
const TEST_TIMEOUT = 120000; // 2 分钟

// 输出截取长度
const OUTPUT_MAX_CHARS = 500;

/**
 * CompletionGate——独立代码验证门
 *
 * 在 GoalVerifier 之后运行，通过实际执行 typecheck/lint/tests 验证代码状态。
 * 不信任 LLM 的"已完成"判断。
 *
 * 超时视为 skipped 而非 failed，不阻断任务完成。
 */
export class CompletionGate {
  constructor(private readonly config: CompletionGateConfig = DEFAULT_CONFIG) {}

  /**
   * 验证项目代码状态
   * @param params.modifiedFiles 修改的文件列表（用于相关测试运行）
   * @param params.projectPath 项目根路径
   * @param params.planDescription 计划描述（仅用于日志）
   */
  async verify(params: {
    modifiedFiles: string[];
    projectPath: string;
    planDescription?: string;
  }): Promise<GateResult> {
    const { modifiedFiles, projectPath } = params;
    const checks: GateCheck[] = [];

    logger.info('CompletionGate: starting verification', {
      projectPath,
      modifiedFilesCount: modifiedFiles.length,
      planDescription: params.planDescription?.slice(0, 100),
    });

    // 1. TypeScript 编译检查（如果有 tsconfig.json）
    if (existsSync(join(projectPath, 'tsconfig.json'))) {
      checks.push(this.runTypecheck(projectPath, modifiedFiles));
    }

    // 2. Lint 检查（如果有 eslint 配置）
    if (
      existsSync(join(projectPath, '.eslintrc')) ||
      existsSync(join(projectPath, '.eslintrc.js')) ||
      existsSync(join(projectPath, '.eslintrc.json')) ||
      existsSync(join(projectPath, 'eslint.config.js')) ||
      existsSync(join(projectPath, 'eslint.config.mjs')) ||
      existsSync(join(projectPath, 'eslint.config.ts'))
    ) {
      checks.push(this.runLint(projectPath, modifiedFiles));
    }

    // 3. 测试运行（如果项目有测试配置）
    if (await this.hasTestConfig(projectPath)) {
      checks.push(this.runTests(projectPath, modifiedFiles));
    }

    const passed = checks.every((c) => c.ok || c.skipped);
    logger.info('CompletionGate: verification done', { passed, checkCount: checks.length });

    return { passed, checks };
  }

  /**
   * TypeScript 编译检查
   */
  private runTypecheck(projectPath: string, _files: string[]): GateCheck {
    const start = Date.now();
    try {
      const result = spawnSync('npx', ['tsc', '--noEmit'], {
        cwd: projectPath,
        timeout: TYPECHECK_TIMEOUT,
        encoding: 'utf-8',
        shell: process.platform === 'win32', // Windows 需要 shell
      });

      const duration = Date.now() - start;
      // I2 修复：超时检测——与 runTests 一致，超时视为 skipped 而非 failed
      if (result.status === null && result.signal === 'SIGTERM') {
        return {
          name: 'typecheck',
          ok: false,
          skipped: true,
          output: 'typecheck 运行超时，已跳过',
          duration,
        };
      }
      const ok = result.status === 0;
      const output = ok
        ? ''
        : (result.stderr || result.stdout || '').substring(0, OUTPUT_MAX_CHARS);

      return { name: 'typecheck', ok, output, duration };
    } catch (error) {
      const duration = Date.now() - start;
      return {
        name: 'typecheck',
        ok: false,
        output: `typecheck 执行异常: ${error instanceof Error ? error.message : String(error)}`,
        duration,
      };
    }
  }

  /**
   * Lint 检查
   */
  private runLint(projectPath: string, _files: string[]): GateCheck {
    const start = Date.now();
    try {
      const result = spawnSync('npx', ['eslint', '.', '--max-warnings=0'], {
        cwd: projectPath,
        timeout: LINT_TIMEOUT,
        encoding: 'utf-8',
        shell: process.platform === 'win32',
      });

      const duration = Date.now() - start;
      // I2 修复：超时检测——与 runTests 一致，超时视为 skipped 而非 failed
      if (result.status === null && result.signal === 'SIGTERM') {
        return {
          name: 'lint',
          ok: false,
          skipped: true,
          output: 'lint 运行超时，已跳过',
          duration,
        };
      }
      const ok = result.status === 0;
      const output = ok
        ? ''
        : (result.stdout || result.stderr || '').substring(0, OUTPUT_MAX_CHARS);

      return { name: 'lint', ok, output, duration };
    } catch (error) {
      const duration = Date.now() - start;
      return {
        name: 'lint',
        ok: false,
        output: `lint 执行异常: ${error instanceof Error ? error.message : String(error)}`,
        duration,
      };
    }
  }

  /**
   * 测试运行——只运行与修改文件相关的测试
   */
  private runTests(projectPath: string, files: string[]): GateCheck {
    const start = Date.now();
    try {
      // 优先用 vitest --related（只运行相关测试），fallback 到 vitest run
      const args = files.length > 0
        ? ['vitest', 'run', '--related', ...files]
        : ['vitest', 'run'];

      const result = spawnSync('npx', args, {
        cwd: projectPath,
        timeout: TEST_TIMEOUT,
        encoding: 'utf-8',
        shell: process.platform === 'win32',
      });

      const duration = Date.now() - start;
      const ok = result.status === 0;
      const output = ok
        ? (result.stdout || '').substring(0, OUTPUT_MAX_CHARS)
        : (result.stdout || result.stderr || '').substring(0, OUTPUT_MAX_CHARS);

      // 超时检测：spawnSync 超时后 status 为 null
      if (result.status === null && result.signal === 'SIGTERM') {
        return {
          name: 'tests',
          ok: false,
          skipped: true,
          output: '测试运行超时，已跳过',
          duration,
        };
      }

      return { name: 'tests', ok, output, duration };
    } catch (error) {
      const duration = Date.now() - start;
      return {
        name: 'tests',
        ok: false,
        output: `测试执行异常: ${error instanceof Error ? error.message : String(error)}`,
        duration,
      };
    }
  }

  /**
   * 检查项目是否有测试配置
   */
  private async hasTestConfig(projectPath: string): Promise<boolean> {
    // 检查常见的测试配置文件
    const testConfigFiles = ['vitest.config.ts', 'vitest.config.js', 'jest.config.js', 'jest.config.ts'];
    for (const file of testConfigFiles) {
      if (existsSync(join(projectPath, file))) return true;
    }
    // I3 修复：对 package.json 单独检查 test 脚本是否存在且非空
    const pkgPath = join(projectPath, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        return typeof pkg.scripts?.test === 'string' && !/no test specified/i.test(pkg.scripts.test);
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * 创建 CompletionGate 的工厂函数
 */
export function createCompletionGate(config?: Partial<CompletionGateConfig>): CompletionGate {
  return new CompletionGate({ ...DEFAULT_CONFIG, ...config });
}

// 暴露常量
export { DEFAULT_CONFIG as DEFAULT_GATE_CONFIG, TYPECHECK_TIMEOUT, LINT_TIMEOUT, TEST_TIMEOUT };
