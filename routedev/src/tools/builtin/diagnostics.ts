// src/tools/builtin/diagnostics.ts
// B-03：结构化 diagnostics 工具入口
//
// 职责：让模型显式运行项目的最小诊断（typecheck/lint/test），返回结构化结果。
// 不是第二验证系统——只复用项目既有命令（tsc/lint 脚本/test 脚本），
// 无对应命令时返回明确说明（不猜测、不伪造）。
// B-04 的"修改后自动验证"走 CompletionGate 策略，与此工具互补。
// F-034 约定：异步 spawn（spawnSync 会阻塞事件循环，Electron 主进程会冻结）。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTool } from '../types.js';

const DIAGNOSTICS_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 8000;

interface DiagnosticCommand {
  label: string;
  command: string;
  args: string[];
}

/** 异步执行命令（F-034：spawn + Promise，不阻塞事件循环；lsp-diagnostics 复用） */
export function runCommandAsync(
  cmd: string,
  args: string[],
  options: { timeout: number; cwd: string; shell?: boolean },
): Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, options.timeout);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ status: -1, signal: null, stdout, stderr });
    });
  });
}

/** 按工作区探测可用诊断命令（同步、零网络） */
export function resolveDiagnosticCommands(
  cwd: string,
  scope: 'typecheck' | 'lint' | 'test',
): DiagnosticCommand | null {
  const packageJsonPath = join(cwd, 'package.json');
  let scripts: Record<string, string> = {};
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
      scripts = parsed.scripts ?? {};
    } catch {
      scripts = {};
    }
  }
  switch (scope) {
    case 'typecheck': {
      // 优先本地 tsc（无网络、无全局依赖）；其次 package.json 的 typecheck 脚本
      const localTsc = join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
      if (existsSync(join(cwd, 'tsconfig.json'))) {
        if (existsSync(localTsc)) return { label: 'tsc --noEmit', command: localTsc, args: ['--noEmit'] };
        if (scripts.typecheck) return { label: 'npm run typecheck', command: 'npm', args: ['run', 'typecheck', '--silent'] };
        return null;
      }
      return null;
    }
    case 'lint': {
      if (scripts.lint) return { label: 'npm run lint', command: 'npm', args: ['run', 'lint', '--silent'] };
      return null;
    }
    case 'test': {
      if (scripts.test) return { label: 'npm test', command: 'npm', args: ['test', '--silent'] };
      return null;
    }
    default:
      return null;
  }
}

export function createDiagnosticsTool() {
  return buildTool({
    name: 'diagnostics',
    description:
      '运行项目的最小诊断并返回结构化结果：typecheck（tsc --noEmit，需 tsconfig.json）、lint（package.json 的 lint 脚本）、test（package.json 的 test 脚本）。修改代码后用它做最小验证；项目未配置对应命令时返回明确说明。',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['typecheck', 'lint', 'test'],
          description: '诊断范围：typecheck=类型检查；lint=代码风格；test=测试',
        },
        path: {
          type: 'string',
          description: '项目目录（默认当前工作目录）',
        },
      },
      required: ['scope'],
    },
    requiresApproval: true,
    category: 'code',
    readOnly: true,
    async execute(args, context) {
      const scope = args.scope as 'typecheck' | 'lint' | 'test';
      const cwd = typeof args.path === 'string' && args.path ? args.path : context.workingDirectory;
      const startedAt = Date.now();
      if (!existsSync(cwd)) {
        return { success: false, output: `[diagnostics] 目录不存在: ${cwd}`, durationMs: Date.now() - startedAt };
      }
      const command = resolveDiagnosticCommands(cwd, scope);
      if (!command) {
        return {
          success: true,
          output: `[diagnostics] 项目未配置 ${scope} 诊断：缺少 ${scope === 'typecheck' ? 'tsconfig.json/本地 tsc' : `package.json 的 ${scope} 脚本`}。`,
          durationMs: Date.now() - startedAt,
        };
      }
      const result = await runCommandAsync(command.command, command.args, {
        cwd,
        timeout: DIAGNOSTICS_TIMEOUT_MS,
        shell: process.platform === 'win32',
      });
      const ok = result.status === 0;
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      const truncated = output.length > MAX_OUTPUT_CHARS
        ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n…[输出已截断]`
        : output;
      return {
        success: ok,
        output: ok
          ? `[diagnostics] ${command.label} 通过（${Date.now() - startedAt}ms）${truncated ? `\n${truncated}` : ''}`
          : `[diagnostics] ${command.label} 失败（exit=${result.status}${result.signal ? `, signal=${result.signal}` : ''}, ${Date.now() - startedAt}ms）\n${truncated || '（无输出）'}`,
        durationMs: Date.now() - startedAt,
      };
    },
  });
}
