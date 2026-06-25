// src/cli/commands/memory.ts

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';
import type { NodeType } from '../../agent/memory/graph.js';

export const memoryCommand: CommandDefinition = {
  name: 'memory',
  description: '管理项目记忆',
  usage: '/memory [show|notes|write|clear|list|forget|feedback]',
  handler: async (args, ctx) => {
    const { checkpointWriter, projectMemory, prompts, audit, contextManager } = ctx;
    const trimmed = args.trim();

    // 处理带参数的子命令：先取第一个 token
    const parts = trimmed.split(/\s+/);
    const head = parts[0]?.toLowerCase() ?? '';

    switch (head) {
      case 'show': {
        const status = await projectMemory.getStatus();
        const lines = [
          '## 项目记忆状态',
          `rules.md: ${status.files.rules.exists ? '存在' : '缺失'}`,
          `MEMORY.md: ${status.files.memory.exists ? '存在' : '缺失'}`,
          `decisions.log: ${status.files.decisions.exists ? status.files.decisions.count + ' 条' : '缺失'}`,
          `context.md: ${status.files.context.exists ? '存在' : '缺失'}`,
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      case 'notes': {
        const notes = await checkpointWriter.readNotes();
        return { type: 'handled', messages: [notes || '（notes.md 为空）'] };
      }

      case 'write': {
        // 触发 checkpoint 写入（异步，不阻塞）
        checkpointWriter
          .write({
            recentMessages: [],
            notes: '',
            previousCheckpoint: null,
            usagePercent: 0,
            level: 'incremental',
          })
          .catch(() => {});
        audit.log('checkpoint_create', 'manual', { reason: '/memory write' });
        return { type: 'handled', messages: ['已触发检查点写入。'] };
      }

      case 'clear': {
        await projectMemory.clearMemory();
        return { type: 'handled', messages: ['已清空 MEMORY.md。'] };
      }

      // Phase 38 Task 3.4：/memory list — 列出知识图谱节点
      case 'list': {
        const graph = contextManager.getKnowledgeGraph();
        const nodes = graph.listNodes({ deprecated: false });
        if (nodes.length === 0) {
          return { type: 'handled', messages: ['知识图谱为空。'] };
        }
        // 按类型分组，每组按 validatedCount 降序，最多 20 个
        const byType = new Map<NodeType, typeof nodes>();
        for (const n of nodes) {
          const list = byType.get(n.type) ?? [];
          list.push(n);
          byType.set(n.type, list);
        }
        const lines: string[] = ['## 知识图谱节点（按类型分组，按 validatedCount 排序）'];
        let totalShown = 0;
        for (const [type, list] of byType) {
          list.sort((a, b) => b.validatedCount - a.validatedCount);
          lines.push(`\n### ${type}（${list.length}）`);
          for (const n of list) {
            if (totalShown >= 20) break;
            const preview = n.content.slice(0, 60).replace(/\n/g, ' ');
            lines.push(`- [${n.id}] (v=${n.validatedCount}) ${preview}`);
            totalShown++;
          }
          if (totalShown >= 20) {
            lines.push('...（已达到 20 条上限）');
            break;
          }
        }
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      // Phase 38 Task 3.4：/memory forget --stale <days> [--yes]
      case 'forget': {
        // 解析参数：--stale <days> [--yes]
        const staleMatch = trimmed.match(/--stale\s+(\d+)/);
        const hasYes = /--yes\b/.test(trimmed);
        const typeMatch = trimmed.match(/--type\s+(\w+)/);
        const staleDays = staleMatch ? parseInt(staleMatch[1], 10) : 90;
        const typeFilter = typeMatch ? (typeMatch[1] as NodeType) : undefined;

        const graph = contextManager.getKnowledgeGraph();
        const result = graph.forget({
          criteria: { staleFor: staleDays, type: typeFilter },
          dryRun: !hasYes,
        });

        if (result.forgotten === 0) {
          return { type: 'handled', messages: ['没有符合条件的节点可遗忘。'] };
        }

        const header = hasYes
          ? `已遗忘 ${result.forgotten} 个节点：`
          : `预览：将遗忘 ${result.forgotten} 个节点（加 --yes 确认执行）：`;
        const lines = [header];
        for (const n of result.nodes) {
          const preview = n.content.slice(0, 60).replace(/\n/g, ' ');
          lines.push(`- [${n.id}] (${n.type}) ${preview}`);
        }
        // 实际执行后触发持久化
        if (hasYes) {
          contextManager.saveGraphToDisk();
        }
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      // Phase 38 Task 3.4：/memory feedback <nodeId> useful|wrong
      case 'feedback': {
        // 参数格式：feedback <nodeId> useful|wrong
        const fbArgs = parts.slice(1);
        const nodeId = fbArgs[0];
        const outcome = fbArgs[1]?.toLowerCase();

        if (!nodeId || !outcome) {
          return {
            type: 'handled',
            messages: ['用法：/memory feedback <nodeId> useful|wrong'],
          };
        }

        // 映射 useful|wrong 到 improve 的 outcome
        const improveOutcome =
          outcome === 'useful' ? 'useful' :
          outcome === 'wrong' ? 'incorrect' :
          null;

        if (!improveOutcome) {
          return {
            type: 'handled',
            messages: ['反馈类型必须是 useful 或 wrong'],
          };
        }

        const graph = contextManager.getKnowledgeGraph();
        const result = graph.improve({
          query: '',
          nodeIds: [nodeId],
          outcome: improveOutcome,
        });

        // 触发持久化
        contextManager.saveGraphToDisk();

        return {
          type: 'handled',
          messages: [
            `反馈完成：更新 ${result.updatedNodes} 个节点，替代 ${result.supersededNodes} 个节点。${result.details}`,
          ],
        };
      }

      default: {
        const lines = [
          '用法：/memory <subcommand>',
          '  show                          — 显示检查点和项目记忆状态',
          '  notes                         — 查看 notes.md',
          '  write                         — 手动触发检查点写入',
          '  clear                         — 清空 MEMORY.md',
          '  list                          — 列出知识图谱节点',
          '  forget --stale <days> [--yes] — 遗忘指定天数未更新的节点',
          '  feedback <nodeId> useful|wrong — 对节点标记反馈',
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }
    }
  },
};
