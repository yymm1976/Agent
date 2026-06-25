// src/cli/commands/trace.ts

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';
import { parseTimelineEntries, renderTraceTimelineText } from '../components/TracePanel.js';
import { outputStyleToDisclosureLevel } from '../output-style.js';
import { TrajectoryExporter } from '../../observability/trajectory-exporter.js';
import { TrajectoryAggregator } from '../../observability/trajectory-aggregator.js';

export const traceCommand: CommandDefinition = {
  name: 'trace',
  description: '查看 trace 与审计日志',
  usage: '/trace [sessions|view [l1|l2|l3]|audit|export [sessionId]|summary]',
  handler: async (args, ctx) => {
    const { trace, audit, tracker } = ctx;
    const sub = args.trim().toLowerCase().split(/\s+/)[0] || 'sessions';

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
        // 使用 TracePanel 的转换函数生成可视化时间线
        const spans = trace.getSpans();
        const entries = parseTimelineEntries(spans);
        if (entries.length === 0) {
          return { type: 'handled', messages: ['暂无 Trace 记录'] };
        }
        // 解析披露层级：/trace view [l1|l2|l3]，未指定时使用 outputStyle 映射的默认值
        const levelArg = args.split(' ').slice(1).find(s => s.length > 0)?.toLowerCase();
        const levelMap: Record<string, 1 | 2 | 3> = { l1: 1, l2: 2, l3: 3 };
        const level = levelArg
          ? (levelMap[levelArg] ?? 2)
          : outputStyleToDisclosureLevel(ctx.config.ui.outputStyle);
        const text = renderTraceTimelineText(entries, sessionId, level);
        return { type: 'handled', messages: [text] };
      }

      case 'audit': {
        const records = await audit.listToday(30);
        const lines = records.map(r => `[${r.timestamp}] ${r.action} → ${r.result}`);
        return { type: 'handled', messages: [lines.join('\n') || '今日无审计记录'] };
      }

      // Phase 35 Task 4：执行轨迹导出
      case 'export': {
        // /trace export [sessionId]——导出单条轨迹为 JSON
        const sessionIdArg = args.split(/\s+/).slice(1).find(s => s.length > 0);
        const exporter = new TrajectoryExporter(audit, trace, tracker);
        try {
          const json = await exporter.exportAsJson(sessionIdArg);
          return { type: 'handled', messages: [`轨迹导出 (JSON):\n${json}`] };
        } catch (err) {
          return {
            type: 'handled',
            messages: [`导出失败: ${err instanceof Error ? err.message : String(err)}`],
          };
        }
      }

      // Phase 35 Task 4：跨会话聚合分析
      case 'summary': {
        // /trace summary——显示最近 10 个会话的聚合指标
        const sessions = await trace.listSessions(10);
        if (sessions.length === 0) {
          return { type: 'handled', messages: ['无可用会话记录'] };
        }

        const exporter = new TrajectoryExporter(audit, trace, tracker);
        const bundles = await Promise.all(
          sessions.map(s => exporter.exportSession(s.id).catch(() => null)),
        );
        const validBundles = bundles.filter((b): b is NonNullable<typeof b> => b !== null);

        const aggregator = new TrajectoryAggregator();
        const metrics = aggregator.aggregate(validBundles);
        const text = aggregator.formatAsText(metrics);
        return { type: 'handled', messages: [text] };
      }

      default:
        return { type: 'handled', messages: ['用法: /trace [sessions|view|audit|export|summary]'] };
    }
  },
};
