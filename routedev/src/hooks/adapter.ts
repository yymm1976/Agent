// src/hooks/adapter.ts
// Phase 39 Task 2：HookConfig → HookDefinition 转换器
//
// 职责：把 HookConfigRegistry 中的持久化配置（HookConfig）转换为
//       HookRunner 可执行的 HookDefinition。
//
// 转换规则：
//   - id → name（HookDefinition 用 name 标识，用于日志和注销）
//   - event → event（类型转换：registry 的 HookEvent 含 on-model-call，agent 的不含）
//   - priority → priority（可选，默认 50）
//   - command → handler（spawn 子进程执行，支持 {{filePath}}/{{toolName}}/{{stepId}} 变量替换）
//
// fail-open 策略：
//   - 命令执行失败（非零退出码）返回 { action: 'skip' }
//   - spawn 错误返回 { action: 'continue' }（不阻断主流程）
//   - 超时由 child_process timeout 选项控制，超时后子进程被 kill

import type { HookDefinition, HookEvent, HookContext, HookResult } from '../agent/hooks.js';
import type { HookConfig } from './registry.js';
import { spawn } from 'node:child_process';

/** HookConfig 扩展字段（可选，部分配置可能包含这些字段） */
type ExtendedHookConfig = HookConfig & {
  priority?: number;
  timeout?: number;
  cwd?: string;
};

/** HookContext 扩展字段（filePath 在工具级钩子中通过上下文传递） */
type ExtendedHookContext = HookContext & {
  filePath?: string;
};

/**
 * 将 HookConfig 转换为 HookDefinition
 *
 * @param config Hook 配置（来自 HookConfigRegistry）
 * @returns HookDefinition（可注册到 HookRunner）
 */
export function configToDefinition(config: HookConfig): HookDefinition {
  const ext = config as ExtendedHookConfig;
  return {
    name: config.id,
    event: config.event as HookEvent,
    priority: ext.priority ?? 50,
    async handler(ctx: HookContext): Promise<HookResult> {
      const command = replaceVariables(config.command, ctx);
      return executeShellCommand(command, ext.timeout ?? 5000, ext.cwd);
    },
  };
}

/**
 * 替换命令模板中的变量占位符
 *
 * 支持的变量：
 *   - {{filePath}}：当前文件路径（来自工具上下文）
 *   - {{toolName}}：当前工具名
 *   - {{stepId}}：当前步骤 ID
 *
 * SECURITY：变量值来自工具上下文（可能源自用户/LLM 输入），在替换时
 *           必须经过 shellEscape 转义，防止 `;`、`|`、`&`、`$()` 等
 *           shell 元字符导致命令注入。命令模板本身来自可信的开发者配置
 *           （HookConfigRegistry），不需要转义。
 */
export function replaceVariables(template: string, ctx: HookContext): string {
  const ext = ctx as ExtendedHookContext;
  return template
    .replace(/\{\{filePath\}\}/g, shellEscape(ext.filePath ?? ''))
    .replace(/\{\{toolName\}\}/g, shellEscape(ctx.toolName ?? ''))
    .replace(/\{\{stepId\}\}/g, shellEscape(ctx.stepId ?? ''));
}

/**
 * Shell 转义：将字符串安全地插入 shell 命令，防止命令注入
 *
 * - Unix（sh/bash）：用单引号包裹整个值，内部单引号用 `'\''` 转义。
 *   单引号内的内容 100% 字面化——无展开、无元字符解释。
 * - Windows（cmd.exe）：用双引号包裹，内部双引号用 `""` 转义。
 *   双引号内 `& | < >` 等 shell 分隔符变为字面字符，阻断常见注入路径。
 *   （`%var%` 展开仍可能发生，但仅能泄露环境变量，无法执行任意命令。）
 */
export function shellEscape(value: string): string {
  if (value === '') return process.platform === 'win32' ? '""' : "''";
  if (process.platform === 'win32') {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * 执行 shell 命令并返回 HookResult
 *
 * @param command 要执行的 shell 命令
 * @param timeout 超时毫秒（默认 5000）
 * @param cwd 工作目录（可选）
 *
 * 返回策略：
 *   - 退出码 0：{ action: 'continue', modifiedToolResult: stdout }
 *   - 非零退出码：{ action: 'skip', message: 'Hook 退出码 N' }
 *   - spawn 错误：{ action: 'continue', message: 'Hook 执行失败: ...' }
 *   - 超时：子进程被 kill，触发 close 事件返回 skip
 */
export function executeShellCommand(
  command: string,
  timeout: number,
  cwd?: string,
): Promise<HookResult> {
  return new Promise((resolve) => {
    // SECURITY：shell:true 保留——hook 命令模板合法使用 shell 特性
    // （管道 |、重定向 >>、逻辑链 &&、命令替换 $() 等，见 templates.ts）。
    // 命令注入风险由 replaceVariables() 中的 shellEscape 消除：所有
    // {{filePath}}/{{toolName}}/{{stepId}} 替换值在插入命令前已转义。
    // 命令模板本身来自可信开发者配置（HookConfigRegistry），非用户输入。
    //
    // P0 修复（复审）：进程树终止——Node 的 timeout 选项只杀 shell 本身，
    // POSIX 下 shell 启动的孙进程（sleep 等）仍存活并持有 stdout FD，
    // close 事件要等 FD 关闭 → 父进程可能无限挂起。
    // 方案：POSIX detached 进程组 + kill(-pid)；Windows taskkill /T。
    const child = spawn(command, {
      shell: true,
      // detached 在 POSIX 上创建独立进程组（Windows 上忽略该语义，用 taskkill）
      detached: process.platform !== 'win32',
      cwd,
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    const finish = (result: HookResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // 超时：终止整个进程树后返回超时结果（不等待孙进程退出）
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        // Windows：taskkill /T 递归终止进程树
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* 进程组已退出 */
        }
        // 宽限期后 SIGKILL 兜底（unref 不阻塞进程退出）
        setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            /* 已退出 */
          }
        }, 1000).unref();
      }
      finish({ action: 'continue', message: `Hook 超时（${timeout}ms），已终止进程树` });
    }, timeout);
    timer.unref?.();
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.on('close', (code) => {
      if (code === 0) {
        finish({ action: 'continue', modifiedToolResult: stdout });
      } else {
        finish({
          action: 'skip',
          message: `Hook 退出码 ${code}`,
        });
      }
    });
    child.on('error', (err) => {
      finish({ action: 'continue', message: `Hook 执行失败: ${err.message}` });
    });
  });
}
