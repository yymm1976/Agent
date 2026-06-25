// src/cli/commands/trace.ts

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';
import { parseTimelineEntries, renderTraceTimelineText } from '../components/TracePanel.js';
import { outputStyleToDisclosureLevel } from '../output-style.js';
import { TrajectoryExporter } from '../../observability/trajectory-exporter.js';
// Phase 48 Task 6：TrajectoryAggregator 不再自行 new，改由 TraceCollector.getTrajectoryAggregator() 共享

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

      // Phase 35 Task 4 / Phase 48 Task 6：跨会话聚合分析
      case 'summary': {
        // /trace summary——显示最近 10 个会话的聚合指标
        // Phase 48 Task 6：使用 TraceCollector 持有的共享 aggregator 实例，
        // 这样 harness 在 endSession 时累积的当前会话数据也能被聚合到结果中
        const aggregator = trace.getTrajectoryAggregator();

        // 先取磁盘上最近 10 个会话（已结束的）
        const sessions = await trace.listSessions(10);
        const exporter = new TrajectoryExporter(audit, trace, tracker);
        const diskBundles = await Promise.all(
          sessions.map(s => exporter.exportSession(s.id).catch(() => null)),
        );
        const validDiskBundles = diskBundles.filter(
          (b): b is NonNullable<typeof b> => b !== null,
        );

        // 合并：harness 累积的 bundles（当前进程内的会话）+ 磁盘读取的历史会话
        // 去重策略：accumulated 优先——它的 traceRecords.event 是 span.type（如 'tool_call'），
        // 能被 aggregator 正确识别为工具调用；而磁盘 trace.jsonl 中是 'tool_call_start'/'tool_call_end'，
        // 不被 aggregator 识别。同 sessionId 时优先 accumulated，避免工具统计丢失。
        const accumulated = aggregator.getAccumulatedBundles();
        const accumulatedSessionIds = new Set(accumulated.map(b => b.sessionId));
        const mergedBundles = [
          ...accumulated,
          ...validDiskBundles.filter(b => !accumulatedSessionIds.has(b.sessionId)),
        ];

        if (mergedBundles.length === 0) {
          return { type: 'handled', messages: ['无可用会话记录'] };
        }

        // 显式传入合并后的 bundles，避免与累积 bundles 重复计数
        const metrics = aggregator.aggregate(mergedBundles);
        const text = aggregator.formatAsText(metrics);
        return { type: 'handled', messages: [text] };
      }

      default:
        return { type: 'handled', messages: ['用法: /trace [sessions|view|audit|export|summary]'] };
    }
  },
};
