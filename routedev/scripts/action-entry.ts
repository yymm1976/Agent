// scripts/action-entry.ts
// Phase 47 Task 9：GitHub Action 入口脚本
//
// 作用：在 GitHub Actions 运行时中读取 inputs，构造并执行 `routedev exec` 命令，
// 将结果写回 GitHub Actions output。不引入新依赖（不使用 @actions/core），
// 直接读取 `process.env.INPUT_*` 环境变量，符合 GitHub Actions runtime 约定。
//
// inputs 来源（action.yml）：
//   - prompt        任务描述（必填）
//   - work-mode     工作模式（read-only / workspace-write / full-access）
//   - allowed-tools 工具白名单（逗号分隔）
//   - config        config.yaml 内容的 Base64 编码
//
// 输出：
//   - result        执行结果 JSON（写入 $GITHUB_OUTPUT）
//
// 退出码：
//   0 = 成功
//   1 = 失败（已 setFailed）
//
// 注意：
//   1. config 必须用 Base64 传输（陷阱 #141）：避免 YAML 多行字符串转义问题
//   2. API Key 走 Secrets 环境变量，不写入 config
//   3. work-mode 映射到 security.sandbox 配置项

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ============================================================
// 类型与常量
// ============================================================

/** GitHub Action inputs（从 process.env.INPUT_* 读取） */
export interface ActionInputs {
  /** 任务描述（必填） */
  prompt: string;
  /** 工作模式：read-only / workspace-write / full-access */
  workMode: string;
  /** 工具白名单（逗号分隔，留空表示允许全部） */
  allowedTools: string;
  /** config.yaml 内容的 Base64 编码（可为空） */
  config: string;
}

/** 执行结果（写入 output） */
export interface ExecResult {
  /** 状态：success / failure / timeout */
  status: 'success' | 'failure' | 'timeout';
  /** 退出码 */
  exitCode: number;
  /** stdout 内容（截断到 1MB 防止超长） */
  stdout: string;
  /** stderr 内容（截断到 256KB） */
  stderr: string;
  /** 执行耗时（毫秒） */
  durationMs: number;
}

/** 工作模式 → security.sandbox 配置值映射 */
const WORK_MODE_TO_SANDBOX: Record<string, string> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'full-access': 'full-access',
};

/** 允许的工作模式枚举 */
const ALLOWED_WORK_MODES = new Set(['read-only', 'workspace-write', 'full-access']);

/** 默认 routedev 二进制名 */
const ROUTEDEV_BIN = process.env.ROUTEDEV_BIN ?? 'routedev';

// ============================================================
// 工具函数（导出便于测试）
// ============================================================

/**
 * 从 process.env.INPUT_* 读取 GitHub Action inputs
 * GitHub Actions runtime 会把 inputs 以 INPUT_<NAME> 形式注入环境变量
 * （name 转大写，连字符转下划线）
 */
export function readActionInputs(env: NodeJS.ProcessEnv = process.env): ActionInputs {
  const prompt = (env.INPUT_PROMPT ?? '').trim();
  const workMode = (env.INPUT_WORK_MODE ?? 'workspace-write').trim();
  const allowedTools = (env.INPUT_ALLOWED_TOOLS ?? '').trim();
  const config = (env.INPUT_CONFIG ?? '').trim();
  return { prompt, workMode, allowedTools, config };
}

/**
 * 校验 inputs，返回错误信息数组（空数组表示通过）
 */
export function validateInputs(inputs: ActionInputs): string[] {
  const errors: string[] = [];
  if (!inputs.prompt) {
    errors.push('prompt 为必填项，不能为空');
  }
  if (!ALLOWED_WORK_MODES.has(inputs.workMode)) {
    errors.push(`work-mode 必须是 read-only / workspace-write / full-access 之一，实际：${inputs.workMode}`);
  }
  return errors;
}

/**
 * Base64 解码 config 内容并写入临时文件
 * @returns 临时文件路径；config 为空时返回 null
 */
export function decodeConfigToTempFile(configBase64: string): string | null {
  if (!configBase64) return null;

  // 创建临时目录
  const tempDir = mkdtempSync(join(tmpdir(), 'routedev-action-'));
  const configPath = join(tempDir, 'config.yaml');

  // Base64 解码并写入
  const content = Buffer.from(configBase64, 'base64').toString('utf-8');
  writeFileSync(configPath, content, 'utf-8');

  return configPath;
}

/**
 * 清理临时配置文件
 */
export function cleanupTempConfig(configPath: string | null): void {
  if (!configPath) return;
  try {
    const dir = resolve(configPath, '..');
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 将 work-mode 映射为 security.sandbox 配置值
 */
export function mapWorkModeToSandbox(workMode: string): string {
  return WORK_MODE_TO_SANDBOX[workMode] ?? 'workspace-write';
}

/**
 * 构造 routedev exec 命令参数
 * @param inputs   action inputs
 * @param configPath  临时配置文件路径（可为 null）
 * @returns 命令参数数组
 */
export function buildExecArgs(inputs: ActionInputs, configPath: string | null): string[] {
  const args: string[] = ['exec', inputs.prompt, '--json'];

  // 配置文件路径
  if (configPath) {
    args.push('--config', configPath);
  }

  // 工作模式通过环境变量 ROUTEDEV_SANDBOX 传入（exec 子命令会读取）
  // allowed-tools 通过环境变量 ROUTEDEV_ALLOWED_TOOLS 传入
  // 这里只构造命令行参数，环境变量在 spawn 时注入

  return args;
}

/**
 * 构造执行 routedev 时需要注入的环境变量
 * （work-mode / allowed-tools / API Key 等）
 */
export function buildExecEnv(inputs: ActionInputs, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  // 工作模式映射到 sandbox
  env.ROUTEDEV_SANDBOX = mapWorkModeToSandbox(inputs.workMode);
  // 工具白名单
  if (inputs.allowedTools) {
    env.ROUTEDEV_ALLOWED_TOOLS = inputs.allowedTools;
  }
  return env;
}

/**
 * 将执行结果写入 GitHub Actions output 文件
 * 通过 $GITHUB_OUTPUT 文件以 `name=value` 格式追加
 */
export function writeGitHubOutput(result: ExecResult, outputPath?: string): void {
  const filePath = outputPath ?? process.env.GITHUB_OUTPUT;
  if (!filePath) {
    // 非 GitHub Actions 环境，跳过
    return;
  }
  const json = JSON.stringify(result);
  // 多行值使用 heredoc 语法
  const content = `result<<EOF\n${json}\nEOF\n`;
  writeFileSync(filePath, content, { flag: 'a' });
}

/**
 * 设置 GitHub Actions 失败状态（写 error 日志 + 非零退出）
 */
export function setFailed(message: string): void {
  // GitHub Actions 通过 ::error:: workflow command 记录错误
  process.stdout.write(`::error::${message}\n`);
}

// ============================================================
// 主执行逻辑
// ============================================================

/**
 * 执行 routedev exec 子命令
 * @returns 执行结果
 */
export function runRouteDevExec(
  inputs: ActionInputs,
  configPath: string | null,
  options?: { timeoutMs?: number; bin?: string },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const bin = options?.bin ?? ROUTEDEV_BIN;
    const args = buildExecArgs(inputs, configPath);
    const env = buildExecEnv(inputs);
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? 600_000; // 默认 10 分钟

    // 截断阈值
    const MAX_STDOUT = 1024 * 1024; // 1MB
    const MAX_STDERR = 256 * 1024; // 256KB

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;

    try {
      child = spawn(bin, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        status: 'failure',
        exitCode: 1,
        stdout: '',
        stderr: `spawn 失败: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
        // 5 秒后强制 kill
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // 忽略
          }
        }, 5000);
      } catch {
        // 忽略
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT) {
        stdout += chunk.toString('utf-8');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) {
        stderr += chunk.toString('utf-8');
      }
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const exitCode = code ?? 1;
      const durationMs = Date.now() - startTime;

      let status: ExecResult['status'];
      if (timedOut) {
        status = 'timeout';
      } else if (exitCode === 0) {
        status = 'success';
      } else {
        status = 'failure';
      }

      // 截断到阈值
      if (stdout.length > MAX_STDOUT) stdout = stdout.slice(0, MAX_STDOUT) + '\n[truncated]';
      if (stderr.length > MAX_STDERR) stderr = stderr.slice(0, MAX_STDERR) + '\n[truncated]';

      resolve({ status, exitCode, stdout, stderr, durationMs });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({
        status: 'failure',
        exitCode: 1,
        stdout,
        stderr: stderr + `\n执行异常: ${err.message}`,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

/**
 * 主入口
 */
export async function main(): Promise<number> {
  // 1. 读取并校验 inputs
  const inputs = readActionInputs();
  const errors = validateInputs(inputs);
  if (errors.length > 0) {
    for (const err of errors) {
      setFailed(err);
    }
    return 1;
  }

  // 2. 解码 config 到临时文件
  let configPath: string | null = null;
  try {
    configPath = decodeConfigToTempFile(inputs.config);
  } catch (err) {
    setFailed(`config Base64 解码失败: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // 3. 执行 routedev exec
  try {
    const result = await runRouteDevExec(inputs, configPath);

    // 4. 写入 GitHub Actions output
    writeGitHubOutput(result);

    // 5. 根据状态输出日志
    if (result.status === 'success') {
      process.stdout.write(`✅ RouteDev 执行成功（${result.durationMs}ms）\n`);
    } else if (result.status === 'timeout') {
      setFailed(`RouteDev 执行超时（${result.durationMs}ms）`);
    } else {
      setFailed(`RouteDev 执行失败（exitCode=${result.exitCode}）`);
      if (result.stderr) {
        process.stderr.write(result.stderr + '\n');
      }
    }

    return result.status === 'success' ? 0 : 1;
  } finally {
    // 6. 清理临时配置文件
    cleanupTempConfig(configPath);
  }
}

// ============================================================
// 直接执行入口
// ============================================================

const isDirectRun = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().then((code) => {
    process.exit(code);
  });
}
