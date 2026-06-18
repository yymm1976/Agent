// src/cli/commands/trace.ts

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';

export const traceCommand: CommandDefinition = {
  name: 'trace',
  description: '查看 trace 与审计日志',
  usage: '/trace [sessions|view|audit]',
  handler: async (args, ctx) => {
    const { trace, audit } = ctx;
    const sub = args.trim().toLowerCase() || 'sessions';

    switch (sub) {
      case 'sessions': {
        const sessions = await trace.listSessions(10);
        const lines = ['最近会话:'];
        for (const s of sessions) {
          lines.push(
            `  ${s.id} | ${s.userInput.slice(0, 30)} | spans=${s.spanCount} | ${s.completed ? '完成' : '运行中'}`,
          );
        }
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      case 'view': {
        const sessionId = trace.getSessionId();
        if (!sessionId) return { type: 'handled', messages: ['当前无活跃会话'] };
        const records = await trace.readSessionRecords(sessionId);
        const lines = records.slice(-30).map(r => `[${r.timestamp}] ${r.event}`);
        return { type: 'handled', messages: [lines.join('\n') || '暂无记录'] };
      }

      case 'audit': {
        const records = await audit.listToday(30);
        const lines = records.map(r => `[${r.timestamp}] ${r.action} → ${r.result}`);
        return { type: 'handled', messages: [lines.join('\n') || '今日无审计记录'] };
      }

      default:
        return { type: 'handled', messages: ['用法: /trace [sessions|view|audit]'] };
    }
  },
};
