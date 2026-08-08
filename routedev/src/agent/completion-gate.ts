// src/agent/completion-gate.ts
// Phase 31 Task 6.4：独立代码验证门（Completion Gate）
// 不信任 LLM 的"已完成"判断——通过 typecheck/lint/tests 独立验证
// 通过 spawn 调用外部进程（异步），必须设 timeout，否则可能永久阻塞

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

// F-034：spawnSync 阻塞事件循环，改用 spawn + Promise 包装异步执行
// GA Hardening 第3项：支持 AbortSignal——取消时杀整个进程树
// （POSIX 用 detached 进程组 kill(-pid)，Windows 用 taskkill /T /F 递归终止）
function runCommandAsync(
  cmd: string,
  args: string[],
  options: { timeout: number; cwd: string; shell?: boolean; signal?: AbortSignal },
): Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string; cancelled: boolean }> {
  return new Promise((resolve) => {
    // P0 修复（复审）：Windows 上直接 spawn .cmd/.bat 会 EINVAL——
    // 必须经 shell 执行（args 由 detectRunTarget 生成：['run', scriptName]，
    // 无用户输入注入面；原有"附加 .cmd 后缀避免 shell:true 注入"注释仅适用
    // fallback 的 npx 直调路径，那里已用 npx.cmd + 无 shell）
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    // windowsHide:true 防止 GUI 应用 spawn 子进程时弹出 cmd/console 窗口
    // POSIX：signal 存在时 detached 创建独立进程组，便于 kill(-pid) 杀整棵进程树
    const treeKillable = options.signal !== undefined && process.platform !== 'win32';
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      shell: needsShell,
      windowsHide: true,
      ...(treeKillable ? { detached: true } : {}),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { status: number | null; signal: string | null; stdout: string; stderr: string; cancelled: boolean }) => {
      if (!settled) { settled = true; resolve(result); }
    };
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('close', (code, signal) => finish({ status: code, signal, stdout, stderr, cancelled: false }));
    child.on('error', () => finish({ status: -1, signal: null, stdout, stderr, cancelled: false }));
      if (options.signal) {
        // 取消：杀整个进程树（pnpm/npm 脚本链会派生孙进程，只杀直接子进程会残留孤儿）
        const onAbort = () => {
          if (child.pid === undefined) return;
          try {
            if (process.platform === 'win32') {
              // Windows 无进程组概念：taskkill /T /F 递归终止
              spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            } else {
              process.kill(-child.pid, 'SIGTERM'); // detached 进程组整体终止
            }
          } catch { /* 进程可能已退出 */ }
          finish({ status: null, signal: 'SIGABRT', stdout, stderr, cancelled: true });
        };
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true });
          // 进程先于 abort 结束时清理监听器（防泄漏）
          child.on('close', () => options.signal?.removeEventListener('abort', onAbort));
        }
      }
  });
}

// ============================================================
// Phase 92：项目脚本适配
// 优先用 package.json scripts + 检测到的包管理器，fallback 到 npx
// ============================================================

type PackageManager = 'pnpm' | 'yarn' | 'npm';

/** 检测项目使用的包管理器（基于 lockfile） */
function detectPackageManager(projectPath: string): PackageManager {
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * 解析运行目标：优先用 package.json scripts 中对应的脚本
 *
 * 返回 null 表示无对应脚本，调用方应 fallback 到 npx 直接调用
 * Windows 上 pm 是 .cmd 批处理，附加 .cmd 后缀避免 shell:true 注入风险
 */
function detectRunTarget(
  projectPath: string,
  scriptName: string,
): { cmd: string; args: string[] } | null {
  const pkgPath = join(projectPath, 'package.json');
  if (!existsSync(pkgPath)) return null;
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    scripts = pkg.scripts ?? {};
  } catch {
    return null;
  }
  const scriptValue = scripts[scriptName];
  if (typeof scriptValue !== 'string' || /no test specified/i.test(scriptValue)) {
    return null;
  }
  const pm = detectPackageManager(projectPath);
  const cmd = process.platform === 'win32' ? `${pm}.cmd` : pm;
  // 统一用 `<pm> run <script>`（pnpm/yarn/npm 都支持）
  return { cmd, args: ['run', scriptName] };
}

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
  /**
   * GA Hardening 第3项：是否因用户取消（AbortSignal）中断。
   * cancelled 的检查不算失败也不算普通跳过——结果无效。
   */
  cancelled?: boolean;
  /** 输出内容（失败时截取前 500 字符） */
  output: string;
  /** 耗时（毫秒） */
  duration: number;
  /** 警告信息（如超时跳过时的提示） */
  warnings?: string[];
}

/**
 * 验证门总结果
 */
export interface GateResult {
  /** 是否全部通过（skipped 不算失败；cancelled 另由 cancelled 字段表达） */
  passed: boolean;
  /** 各项检查结果 */
  checks: GateCheck[];
  /**
   * GA Hardening 第3项：验证期间被用户取消（AbortSignal.aborted）。
   * 为 true 时 passed 无意义——调用方应映射为 CompletionStatus 'cancelled'，
   * 不得把取消误报为 verification_failed / completed_unverified。
   */
  cancelled?: boolean;
  /** Phase 52 Task 7：饱和监测告警（saturationMonitor 注入且非 healthy 时填充） */
  warnings?: string[];
}

export type CompletionStatus =
  | 'completed_verified'
  | 'completed_with_warnings'
  | 'completed_unverified'
  | 'verification_failed'
  | 'execution_failed'
  | 'cancelled'
  | 'blocked'
  | 'recovery_available';

export function toCompletionStatus(gateResult?: GateResult, executionSucceeded = true): CompletionStatus {
  if (!executionSucceeded) return 'execution_failed';
  if (!gateResult) return 'completed_unverified';
  // GA Hardening 第3项：用户取消优先于一切通过/失败判定——
  // 取消状态必须是 'cancelled'，不得误报为 verification_failed
  if (gateResult.cancelled) return 'cancelled';
  if (!gateResult.passed) return 'verification_failed';
  // P1 语义修正：任何检查因超时被跳过 = 验证未完整执行。
  // 不得宣称"已验证通过"（completed_verified/with_warnings），
  // 只能算"未验证完成"——Producer 与最终模型不得把超时描述成验证通过。
  if (gateResult.checks.some((check) => check.skipped)) return 'completed_unverified';
  // P1 修复（复审）：没有任何检查执行过（含基础设施异常时构造的空 checks）=
  // 验证未执行，必须优先于 warnings 判定——否则异常被误标为"带警告通过"
  if (gateResult.checks.length === 0) return 'completed_unverified';
  if (gateResult.warnings?.length || gateResult.checks.some((check) => check.warnings?.length)) {
    return 'completed_with_warnings';
  }
  return 'completed_verified';
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

// GA Hardening 第3项：构造用户取消的检查结果——
// cancelled=true 且 skipped=true（不参与 passed 判定），结果无效由 GateResult.cancelled 表达
function cancelledCheck(name: string, duration: number): GateCheck {
  return {
    name,
    ok: false,
    skipped: true,
    cancelled: true,
    output: '已取消（用户中断）',
    duration,
    warnings: ['验证已取消，结果无效'],
  };
}

/**
 * B-04：文档/配置类变更扩展名（仅这类变更时跳过代码验证并说明）
 */
/**
 * P1 语义修正：文档/配置类变更扩展名（仅这类变更时跳过代码验证并说明）。
 * .json/.yaml/.yml/.toml/.lock 从名单移除——这些经常承载构建配置、依赖、
 * CI、Agent Profile 与权限策略，改动必须经过验证，不能按"文档"跳过。
 */
const DOC_ONLY_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.gitignore', '.editorconfig',
]);

/**
 * B-04：判断是否全部为文档/配置类变更。
 * 空列表不算（保守）；全部命中才算。
 */
export function isDocOnlyChange(files: readonly string[]): boolean {
  if (files.length === 0) return false;
  return files.every((file) => {
    const dot = file.lastIndexOf('.');
    if (dot < 0) return false;
    const ext = file.slice(dot).toLowerCase();
    return DOC_ONLY_EXTENSIONS.has(ext);
  });
}

/**
 * CompletionGate——独立代码验证门
 *
 * 在 GoalVerifier 之后运行，通过实际执行 typecheck/lint/tests 验证代码状态。
 * 不信任 LLM 的"已完成"判断。
 *
 * 超时视为 skipped 而非 failed，不阻断任务完成。
 * B-04：仅文档/配置变更时跳过验证并说明；includeTests=false 时全量测试不运行（需显式要求）。
 */
export class CompletionGate {
  constructor(private readonly config: CompletionGateConfig = DEFAULT_CONFIG) {}

  /**
   * 验证项目代码状态
   * @param params.modifiedFiles 修改的文件列表（用于相关测试运行）
   * @param params.projectPath 项目根路径
   * @param params.planDescription 计划描述（仅用于日志）
   * @param params.includeTests 是否运行测试（B-04：高成本全量测试需显式用户要求或策略允许；缺省 true 兼容旧调用方）
   */
  async verify(params: {
    modifiedFiles: string[];
    projectPath: string;
    planDescription?: string;
    includeTests?: boolean;
    /** GA Hardening 第3项：取消信号——中止时杀进程树并标记 cancelled（用户中断） */
    signal?: AbortSignal;
  }): Promise<GateResult> {
    const { modifiedFiles, projectPath } = params;
    const includeTests = params.includeTests ?? true;
    const signal = params.signal;
    const checks: GateCheck[] = [];

    logger.info('CompletionGate: starting verification', {
      projectPath,
      modifiedFilesCount: modifiedFiles.length,
      includeTests,
      planDescription: params.planDescription?.slice(0, 100),
    });

    // B-04：仅文档/配置变更——跳过代码验证并明确说明（不跑全量）
    if (isDocOnlyChange(modifiedFiles)) {
      const result: GateResult = {
        passed: true,
        checks: [],
        warnings: [`仅文档/配置变更（${modifiedFiles.length} 个文件），跳过 typecheck/lint/tests 验证。`],
      };
      logger.info('CompletionGate: doc-only change, verification skipped', {
        files: modifiedFiles,
      });
      return result;
    }

    // 1. TypeScript 编译检查（如果有 tsconfig.json）
    if (existsSync(join(projectPath, 'tsconfig.json'))) {
      checks.push(await this.runTypecheck(projectPath, modifiedFiles, signal));
    }

    // GA Hardening 第3项：取消后不再启动剩余检查（跳过 lint/tests 的启动开销）
    if (signal?.aborted) return { passed: false, checks, cancelled: true };

    // 2. Lint 检查（如果有 eslint 配置）
    if (
      existsSync(join(projectPath, '.eslintrc')) ||
      existsSync(join(projectPath, '.eslintrc.js')) ||
      existsSync(join(projectPath, '.eslintrc.json')) ||
      existsSync(join(projectPath, 'eslint.config.js')) ||
      existsSync(join(projectPath, 'eslint.config.mjs')) ||
      existsSync(join(projectPath, 'eslint.config.ts'))
    ) {
      checks.push(await this.runLint(projectPath, modifiedFiles, signal));
    }

    if (signal?.aborted) return { passed: false, checks, cancelled: true };

    // 3. 测试运行（B-04：includeTests=false 时只做小而相关的 typecheck/lint）
    if (includeTests && (await this.hasTestConfig(projectPath))) {
      checks.push(await this.runTests(projectPath, modifiedFiles, signal));
    } else if (!includeTests && (await this.hasTestConfig(projectPath))) {
      checks.push({
        name: 'tests',
        ok: false,
        skipped: true,
        output: '全量测试未运行（需显式要求或策略允许）',
        duration: 0,
      });
    }

    const passed = checks.every((c) => c.ok || c.skipped);
    const cancelled = signal?.aborted ?? false;
    logger.info('CompletionGate: verification done', { passed, checkCount: checks.length, cancelled });

    const result: GateResult = { passed, checks, ...(cancelled ? { cancelled: true } : {}) };

    return result;
  }

  /**
   * TypeScript 编译检查
   */
  private async runTypecheck(projectPath: string, _files: string[], signal?: AbortSignal): Promise<GateCheck> {
    const start = Date.now();
    if (signal?.aborted) return cancelledCheck('typecheck', 0);
    try {
      // Phase 92：优先用 package.json scripts.typecheck，fallback 到 npx tsc
      const target = detectRunTarget(projectPath, 'typecheck') ?? {
        cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['tsc', '--noEmit'],
      };
      const result = await runCommandAsync(target.cmd, target.args, {
        cwd: projectPath,
        timeout: TYPECHECK_TIMEOUT,
        signal,
      });

      const duration = Date.now() - start;
      // GA Hardening 第3项：用户取消 → cancelled 检查（结果无效，非失败非跳过）
      if (result.cancelled) return cancelledCheck('typecheck', duration);
      // I2 修复：超时检测——与 runTests 一致，超时视为 skipped 而非 failed
      if (result.status === null && result.signal === 'SIGTERM') {
        return {
          name: 'typecheck',
          ok: false,
          skipped: true,
          output: 'typecheck 运行超时，已跳过',
          duration,
          warnings: ['typecheck 运行超时，结果未验证'],
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
  private async runLint(projectPath: string, _files: string[], signal?: AbortSignal): Promise<GateCheck> {
    const start = Date.now();
    if (signal?.aborted) return cancelledCheck('lint', 0);
    try {
      // Phase 92：优先用 package.json scripts.lint，fallback 到 npx eslint
      const target = detectRunTarget(projectPath, 'lint') ?? {
        cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['eslint', '.', '--max-warnings=0'],
      };
      const result = await runCommandAsync(target.cmd, target.args, {
        cwd: projectPath,
        timeout: LINT_TIMEOUT,
        signal,
      });

      const duration = Date.now() - start;
      if (result.cancelled) return cancelledCheck('lint', duration);
      // I2 修复：超时检测——与 runTests 一致，超时视为 skipped 而非 failed
      if (result.status === null && result.signal === 'SIGTERM') {
        return {
          name: 'lint',
          ok: false,
          skipped: true,
          output: 'lint 运行超时，已跳过',
          duration,
          warnings: ['lint 运行超时，结果未验证'],
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
  private async runTests(projectPath: string, files: string[], signal?: AbortSignal): Promise<GateCheck> {
    const start = Date.now();
    if (signal?.aborted) return cancelledCheck('tests', 0);
    try {
      // Phase 92：优先用 package.json scripts.test（避免 vitest --related 在某些项目下缺失相关测试）
      // fallback 到 npx vitest run [--related files]
      const target = detectRunTarget(projectPath, 'test');
      let cmd: string;
      let args: string[];
      if (target) {
        cmd = target.cmd;
        args = target.args;
      } else {
        // C2 修复：Windows 上不使用 shell:true，避免 files 路径命令注入
        // 直接调用 npx.cmd（Windows 上 npx 是 .cmd 批处理，必须带 .cmd 后缀才能不用 shell）
        cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        args = files.length > 0
          ? ['vitest', 'run', '--related', ...files]
          : ['vitest', 'run'];
      }
      const result = await runCommandAsync(cmd, args, {
        cwd: projectPath,
        timeout: TEST_TIMEOUT,
        signal,
      });

      const duration = Date.now() - start;
      const ok = result.status === 0;
      const output = ok
        ? (result.stdout || '').substring(0, OUTPUT_MAX_CHARS)
        : (result.stdout || result.stderr || '').substring(0, OUTPUT_MAX_CHARS);

      // GA Hardening 第3项：用户取消 → cancelled 检查（结果无效，非失败非跳过）
      if (result.cancelled) return cancelledCheck('tests', duration);

      // 超时检测：spawn 超时后 status 为 null
      if (result.status === null && result.signal === 'SIGTERM') {
        return {
          name: 'tests',
          ok: false,
          skipped: true,
          output: '测试运行超时，已跳过',
          duration,
          warnings: ['测试运行超时，结果未验证'],
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
      } catch (e) {
        // package.json 解析失败（JSON 格式错误或读取异常），视为无测试
        logger.debug('[completion-gate] package.json 解析失败', {
          pkgPath,
          error: e instanceof Error ? e.message : String(e),
        });
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
// Phase 92：导出供单元测试
export { detectPackageManager, detectRunTarget };
