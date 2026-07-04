// src/cli/commands/security.ts
// 安全审计面板命令：/security
//
// 子命令：
//   /security         — 显示安全审计摘要 + 最近 20 条事件
//   /security clear   — 清空所有事件
//   /security report  — 导出完整文本报告

import type { CommandDefinition } from '../command-registry.js';
import { auditPanel } from '../../security/audit-panel.js';

export const securityCommand: CommandDefinition = {
  name: 'security',
  description: '安全审计面板：显示事件摘要 / 清空 / 导出报告',
  usage: '/security [clear|report]',
  handler: async (args) => {
    const sub = (args ?? '').trim().toLowerCase();

    // /security clear — 清空事件
    if (sub === 'clear') {
      auditPanel.clear();
      return {
        type: 'handled',
        messages: ['安全审计面板已清空所有事件'],
      };
    }

    // /security report — 导出完整报告
    if (sub === 'report') {
      return {
        type: 'handled',
        messages: [auditPanel.exportReport()],
      };
    }

    // 默认：显示摘要 + 最近 20 条事件
    const summary = auditPanel.getSummary();
    const recent = auditPanel.getEvents().slice(-20);

    const lines: string[] = [];
    lines.push('====== 安全审计摘要 ======');
    lines.push(
      `总事件: ${summary.total} | 拦截: ${summary.blocked} | 放行: ${summary.allowed} | 警告: ${summary.warned}`,
    );

    const sourceEntries = Object.entries(summary.bySource).sort((a, b) => b[1] - a[1]);
    lines.push(
      `按来源: ${sourceEntries.map(([k, v]) => `${k}=${v}`).join(', ') || '(无)'}`,
    );

    const levelEntries = Object.entries(summary.byLevel);
    lines.push(
      `按级别: ${levelEntries.map(([k, v]) => `${k}=${v}`).join(', ') || '(无)'}`,
    );

    lines.push('------ 最近事件（最多 20 条） ------');
    if (recent.length === 0) {
      lines.push('(暂无事件)');
    } else {
      for (const e of recent) {
        const ts = new Date(e.timestamp).toISOString();
        const reason = e.reason ? ` — ${e.reason}` : '';
        lines.push(
          `[${ts}] ${e.level.toUpperCase()} ${e.source}/${e.action}: ${e.target}${reason}`,
        );
      }
    }

    lines.push('');
    lines.push('提示: /security clear 清空事件, /security report 导出完整报告');

    return { type: 'handled', messages: [lines.join('\n')] };
  },
};
