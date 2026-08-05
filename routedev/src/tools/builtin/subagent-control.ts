// src/tools/builtin/subagent-control.ts
// B-05B：子 Agent 生命周期工具（list_agents / stop_agent）
//
// 复用现有 SubagentRegistry（Phase 97 Part E 的登记/查询/停止），不创建另一管理器。
// send_agent_message / resume_agent 暂不实现：当前子 Agent 为前台同步执行
// （spawnFn await 子 loop 完成），无运行中消息队列与可恢复状态；
// 与 P1 B-11（后台只读 Explore + 生命周期补全）合并落地。
import { buildTool, type ITool } from '../types.js';
import type { SubagentRegistry } from '../../agents/subagent-registry.js';

export function createListAgentsTool(registry: SubagentRegistry): ITool {
  return buildTool({
    name: 'list_agents',
    description:
      '列出当前会话的子 Agent（含已完成的）。返回 childSessionId、类型、状态（running/completed/failed/aborted）与创建时间。停止运行中的子 Agent 用 stop_agent。',
    parameters: {
      type: 'object',
      properties: {
        parentSessionId: {
          type: 'string',
          description: '父会话 ID（可选，默认列出全部）',
        },
      },
      required: [],
    },
    requiresApproval: false,
    category: 'system',
    readOnly: true,
    async execute(args) {
      const parentSessionId = typeof args.parentSessionId === 'string' ? args.parentSessionId : undefined;
      const records = registry.list(parentSessionId);
      if (records.length === 0) {
        return { success: true, output: '当前没有子 Agent 记录。', durationMs: 0 };
      }
      const lines = records.map((r) => {
        const when = new Date(r.createdAt).toISOString().slice(11, 19);
        return `- ${r.childSessionId} [${r.status}] ${r.subagentType} ${r.description}（${when}）`;
      });
      return {
        success: true,
        output: `共 ${records.length} 个子 Agent：\n${lines.join('\n')}`,
        durationMs: 0,
      };
    },
  });
}

export function createStopAgentTool(registry: SubagentRegistry): ITool {
  return buildTool({
    name: 'stop_agent',
    description:
      '停止运行中的子 Agent（通过 childSessionId，来自 list_agents）。已停止/不存在的 id 会明确说明。',
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: '子 Agent 的 childSessionId（list_agents 的输出）',
        },
      },
      required: ['agentId'],
    },
    requiresApproval: true,
    category: 'system',
    async execute(args) {
      const agentId = typeof args.agentId === 'string' ? args.agentId : '';
      if (!agentId) {
        return { success: false, output: '', error: '缺少必需参数: agentId', durationMs: 0 };
      }
      const record = registry.get(agentId);
      if (!record) {
        return { success: true, output: `未找到子 Agent: ${agentId}（可能已被清理或从未登记）`, durationMs: 0 };
      }
      if (record.status !== 'running') {
        return { success: true, output: `子 Agent ${agentId} 已不在运行（当前状态: ${record.status}）`, durationMs: 0 };
      }
      const stopped = registry.stop(agentId);
      return {
        success: true,
        output: stopped
          ? `已请求停止子 Agent ${agentId}（状态 → aborted）`
          : `子 Agent ${agentId} 停止失败（未命中运行记录）`,
        durationMs: 0,
      };
    },
  });
}
