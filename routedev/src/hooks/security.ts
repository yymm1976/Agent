// src/hooks/security.ts
// Hook 安全共享模块：路径越界校验 + 命令安全扫描
// F-001 修复：抽取 app-init-agent.ts 与 hook-bridge.ts 的重复安全逻辑

import * as path from 'node:path';
import { checkBashSecurity } from '../tools/security-enhanced.js';

/**
 * 解析 Hook 配置路径，拒绝绝对路径和越界路径
 *
 * 安全：防止 configPath 指向项目外敏感文件（如 ~/.ssh/id_rsa）造成路径穿越
 *
 * @param cwd 项目工作目录
 * @param rawConfigPath 配置文件相对路径
 * @returns 校验通过的绝对路径；校验失败返回 null
 */
export function resolveHookConfigPath(cwd: string, rawConfigPath: string): string | null {
  // 拒绝绝对路径：防止指向任意系统位置
  if (path.isAbsolute(rawConfigPath)) return null;
  const resolved = path.resolve(cwd, rawConfigPath);
  const cwdResolved = path.resolve(cwd);
  // 必须在 cwd 之内（允许恰好等于 cwd，虽然实际不会发生）
  if (!resolved.startsWith(cwdResolved + path.sep) && resolved !== cwdResolved) return null;
  return resolved;
}

/**
 * 校验 Hook 命令安全性
 *
 * @param command 待执行的 shell 命令
 * @returns ok=true 通过；ok=false 时 reason 给出拒绝原因
 */
export function assertHookCommandSafe(command: string): { ok: boolean; reason?: string } {
  const result = checkBashSecurity(command);
  return result.allowed ? { ok: true } : { ok: false, reason: result.reason };
}
