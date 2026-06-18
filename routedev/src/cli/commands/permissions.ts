// src/cli/commands/permissions.ts
// /permissions 命令（Phase 24 Task 5）
// 显示当前权限引擎的所有规则，按 deny/confirm/auto 三层分组
// 使用设计系统颜色语义：DENY=error、CONFIRM=warning、AUTO=success

import type { CommandDefinition } from '../command-registry.js';
import type { PermissionRule, PermissionEngine } from '../../tools/permission-engine.js';
import {
  DEFAULT_DENY_RULES,
  DEFAULT_CONFIRM_RULES,
  DEFAULT_AUTO_RULES,
} from '../../tools/permission-engine.js';
import { getColor, divider } from '../design-system.js';

/**
 * 渲染单条规则为字符串
 * @param rule 权限规则
 */
function renderRule(rule: PermissionRule): string {
  const toolPattern = rule.toolPattern === '*' ? '*（通配）' : rule.toolPattern;
  const argsNote = rule.argsPredicate ? ' [参数条件]' : '';
  return `    ${rule.id.padEnd(24)} ${toolPattern.padEnd(16)}${argsNote} ${rule.description}`;
}

/**
 * 生成 /permissions 命令的输出文本
 * @param engine 权限引擎实例（可选，未传时只显示默认规则）
 * @param autonomyMode 当前自主度模式
 */
export function renderPermissionsOutput(
  engine?: PermissionEngine,
  autonomyMode?: string,
): string[] {
  // 获取规则：优先使用引擎运行时规则，否则使用默认规则集
  const allRules = engine ? engine.getRules() : [
    ...DEFAULT_DENY_RULES,
    ...DEFAULT_CONFIRM_RULES,
    ...DEFAULT_AUTO_RULES,
  ];

  const denyRules = allRules.filter(r => r.layer === 'deny');
  const confirmRules = allRules.filter(r => r.layer === 'confirm');
  const autoRules = allRules.filter(r => r.layer === 'auto');

  const lines: string[] = [];
  const width = 60;

  lines.push(divider(width));
  lines.push('  权限规则一览');
  lines.push(divider(width));
  lines.push('');

  // DENY 规则
  lines.push(`  🔴 DENY 规则（不可绕过，共 ${denyRules.length} 条）:`);
  if (denyRules.length === 0) {
    lines.push('    （无）');
  } else {
    for (const rule of denyRules) {
      lines.push(renderRule(rule));
    }
  }
  lines.push('');

  // CONFIRM 规则
  lines.push(`  🟡 CONFIRM 规则（需确认，共 ${confirmRules.length} 条）:`);
  if (confirmRules.length === 0) {
    lines.push('    （无）');
  } else {
    for (const rule of confirmRules) {
      lines.push(renderRule(rule));
    }
  }
  lines.push('');

  // AUTO 规则
  lines.push(`  🟢 AUTO 规则（自动放行，共 ${autoRules.length} 条）:`);
  if (autoRules.length === 0) {
    lines.push('    （无）');
  } else {
    for (const rule of autoRules) {
      lines.push(renderRule(rule));
    }
  }
  lines.push('');

  // 当前自主度模式
  if (autonomyMode) {
    lines.push(`  当前自主模式: ${autonomyMode}`);
    lines.push('  提示: 使用 /auto /semi /manual 切换自主模式');
  }
  lines.push(divider(width));

  return lines;
}

/**
 * /permissions 命令定义
 *
 * 注意：此命令通过 ServiceContext 访问 PermissionEngine
 * PermissionEngine 通过 plugin-init.ts 的 registerPermissionMiddleware() 注册到中间件
 * 此处通过 ctx.pluginRegistry 间接获取（或直接使用默认引擎）
 */
export const permissionsCommand: CommandDefinition = {
  name: 'permissions',
  aliases: ['perms'],
  description: '查看当前权限规则（deny/confirm/auto 三层）',
  usage: '/permissions',
  handler: async (_args, ctx) => {
    // Phase 26 Task 4：优先从 ServiceContext 读取运行时 PermissionEngine 实例
    // 这样运行时添加的自定义规则也会显示
    let engine: PermissionEngine | undefined;
    if (ctx.permissionEngine) {
      engine = ctx.permissionEngine;
    } else {
      // 降级：创建默认引擎（仅展示默认规则）
      try {
        const { createDefaultEngine } = await import('../../tools/permission-engine.js');
        engine = createDefaultEngine();
      } catch {
        // 降级：使用默认规则集
      }
    }

    const autonomyMode = ctx.commandBridge.getState().autonomyMode;
    const messages = renderPermissionsOutput(engine, autonomyMode);

    return {
      type: 'handled',
      messages,
    };
  },
};
