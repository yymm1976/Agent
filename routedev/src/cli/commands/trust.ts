// src/cli/commands/trust.ts
// /trust 命令（Phase 40 Task 1）
// 渐进式信任权限系统管理：查看/调整信任级别、管理偏好
//
// 子命令：
//   /trust status         — 查看当前信任级别
//   /trust level <level>  — 调整级别（default/acceptEdits/acceptAll/auto/bypassPermissions/trusted）
//   /trust prefs          — 查看已记忆的偏好列表
//   /trust reset          — 清除所有偏好

import type { CommandDefinition } from '../command-registry.js';
import type { TrustLevel } from '../../tools/trust-gradient.js';
import { divider } from '../design-system.js';

/** 信任级别标签映射 */
const TRUST_LABELS: Record<TrustLevel, string> = {
  plan: 'Plan（只规划不执行）',
  default: 'Default（每次确认）',
  acceptEdits: 'AcceptEdits（文件操作自动通过）',
  acceptAll: 'AcceptAll（所有操作自动通过）',
  auto: 'Auto（LLM 分类器判断）',
  bypassPermissions: 'BypassPermissions（跳过所有检查，不含 push）',
  trusted: 'Trusted（完全信任，仅测试环境）',
};

/** 信任级别图标映射 */
const TRUST_ICONS: Record<TrustLevel, string> = {
  plan: '🔒',
  default: '🔐',
  acceptEdits: '📝',
  acceptAll: '✅',
  auto: '🤖',
  bypassPermissions: '⚡',
  trusted: '🌟',
};

/** /trust level 允许设置的级别 */
const ALLOWED_LEVELS: TrustLevel[] = [
  'default',
  'acceptEdits',
  'acceptAll',
  'auto',
  'bypassPermissions',
  'trusted',
];

/**
 * 渲染 /trust status 输出
 */
function renderStatus(level: TrustLevel, grantsCount: number): string[] {
  const lines: string[] = [];
  const width = 60;

  lines.push(divider(width));
  lines.push('  渐进式信任权限系统');
  lines.push(divider(width));
  lines.push('');
  lines.push(`  ${TRUST_ICONS[level]} 当前信任级别: ${level}`);
  lines.push(`     ${TRUST_LABELS[level]}`);
  lines.push('');
  lines.push(`  📋 已记忆的临时授权: ${grantsCount} 条`);
  lines.push('');
  lines.push('  可用操作:');
  lines.push('    /trust level <level>  — 调整信任级别');
  lines.push('    /trust prefs          — 查看偏好列表');
  lines.push('    /trust reset          — 清除所有偏好');
  lines.push('');
  lines.push('  可用级别:');
  for (const lv of ALLOWED_LEVELS) {
    lines.push(`    ${TRUST_ICONS[lv]} ${lv.padEnd(20)} ${TRUST_LABELS[lv]}`);
  }
  lines.push(divider(width));

  return lines;
}

/**
 * 渲染 /trust prefs 输出
 */
function renderPrefs(
  prefs: { toolPattern: string; argsPattern?: string; riskLevel: string; grantedAt: number; expiresAt?: number }[],
): string[] {
  const lines: string[] = [];
  const width = 60;

  lines.push(divider(width));
  lines.push('  已记忆的信任偏好');
  lines.push(divider(width));
  lines.push('');

  if (prefs.length === 0) {
    lines.push('  （无偏好记录）');
  } else {
    for (const pref of prefs) {
      const grantedDate = new Date(pref.grantedAt).toLocaleString();
      const expiry = pref.expiresAt
        ? `过期: ${new Date(pref.expiresAt).toLocaleString()}`
        : '永久';
      lines.push(`  ${pref.toolPattern.padEnd(16)} ${pref.riskLevel.padEnd(8)} ${pref.argsPattern ?? '（无路径前缀）'}`);
      lines.push(`    ${grantedDate} | ${expiry}`);
    }
  }

  lines.push('');
  lines.push(`  共 ${prefs.length} 条偏好`);
  lines.push(divider(width));

  return lines;
}

/**
 * /trust 命令定义
 */
export const trustCommand: CommandDefinition = {
  name: 'trust',
  description: '渐进式信任权限系统管理（status/level/prefs/reset）',
  usage: '/trust [status|level <level>|prefs|reset]',
  handler: async (args, ctx) => {
    // 获取 TrustGradientManager（通过 PermissionEngine 注入）
    const engine = ctx.permissionEngine;
    const manager = engine?.getTrustGradientManager();

    if (!manager) {
      return {
        type: 'handled',
        messages: [
          '⚠️ 信任梯度管理器未初始化',
          '  提示: TrustGradientManager 尚未注入到 PermissionEngine',
        ],
      };
    }

    // 解析子命令
    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0] || 'status';

    // /trust status
    if (subcommand === 'status') {
      const level = manager.getLevel();
      const grantsCount = manager.getTemporaryGrantsCount();
      return {
        type: 'handled',
        messages: renderStatus(level, grantsCount),
      };
    }

    // /trust level <level>
    if (subcommand === 'level') {
      const requestedLevel = parts[1] as TrustLevel;
      if (!requestedLevel) {
        return {
          type: 'handled',
          messages: [
            '用法: /trust level <level>',
            `可用级别: ${ALLOWED_LEVELS.join(', ')}`,
          ],
        };
      }
      if (!ALLOWED_LEVELS.includes(requestedLevel)) {
        return {
          type: 'handled',
          messages: [
            `❌ 无效的信任级别: ${requestedLevel}`,
            `可用级别: ${ALLOWED_LEVELS.join(', ')}`,
          ],
        };
      }
      manager.setLevel(requestedLevel);
      return {
        type: 'handled',
        messages: [
          `${TRUST_ICONS[requestedLevel]} 信任级别已调整为: ${requestedLevel}`,
          `   ${TRUST_LABELS[requestedLevel]}`,
        ],
      };
    }

    // /trust prefs
    if (subcommand === 'prefs') {
      const prefs = manager.getPreferences();
      return {
        type: 'handled',
        messages: renderPrefs(prefs),
      };
    }

    // /trust reset
    if (subcommand === 'reset') {
      manager.clearSessionGrants();
      return {
        type: 'handled',
        messages: [
          '🧹 已清除所有信任偏好（临时授权）',
          '  提示: 权限状态在 resume 时不恢复——每次新会话必须重新建立信任',
        ],
      };
    }

    // 未知子命令
    return {
      type: 'handled',
      messages: [
        `❌ 未知子命令: ${subcommand}`,
        '用法:',
        '  /trust status         — 查看当前信任级别',
        '  /trust level <level>  — 调整级别',
        '  /trust prefs          — 查看偏好列表',
        '  /trust reset          — 清除所有偏好',
      ],
    };
  },
};
