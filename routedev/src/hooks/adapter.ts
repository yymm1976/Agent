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
 */
export function replaceVariables(template: string, ctx: HookContext): string {
  const ext = ctx as ExtendedHookContext;
  return template
    .replace(/\{\{filePath\}\}/g, ext.filePath ?? '')
    .replace(/\{\{toolName\}\}/g, ctx.toolName ?? '')
    .replace(/\{\{stepId\}\}/g, ctx.stepId ?? '');
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
    const child = spawn(command, { shell: true, timeout, cwd });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ action: 'continue', modifiedToolResult: stdout });
      } else {
        resolve({
          action: 'skip',
          message: `Hook 退出码 ${code}`,
        });
      }
    });
    child.on('error', (err) => {
      resolve({ action: 'continue', message: `Hook 执行失败: ${err.message}` });
    });
  });
}
