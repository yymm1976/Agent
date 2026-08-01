// desktop/main/bridges/agent-bridge.ts
// Agent 领域 delegate：子会话可见性（列表/详情/停止）
// Phase 97 Part E：spawn_agent 生成的子 Agent 成为真正可见、可检查、可停止的会话

import { logger } from '../../../src/utils/logger.js';
import type { EngineContext } from './engine-context.js';

/** 子会话可见性记录（IPC 传输用） */
export interface SubagentView {
  childSessionId: string;
  parentSessionId?: string;
  description: string;
  subagentType: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  createdAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

/**
 * Agent 领域桥接器
 * 持 EngineContext 引用，通过 ctx.deps.subagentRegistry 读写子会话状态
 */
export class AgentBridge {
  constructor(private ctx: EngineContext) {}

  /** 列出子会话（可按父会话过滤；按创建时间倒序） */
  listSubagents(parentSessionId?: string): SubagentView[] {
    const registry = this.ctx.deps?.subagentRegistry;
    if (!registry) return [];
    try {
      return registry.list(parentSessionId ?? undefined);
    } catch (err) {
      logger.warn('AgentBridge.listSubagents failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** 获取单个子会话详情 */
  getSubagent(childSessionId: string): SubagentView | null {
    const registry = this.ctx.deps?.subagentRegistry;
    if (!registry) return null;
    try {
      return registry.get(childSessionId) ?? null;
    } catch (err) {
      logger.warn('AgentBridge.getSubagent failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** 停止运行中的子会话；返回是否命中 */
  stopSubagent(childSessionId: string): boolean {
    const registry = this.ctx.deps?.subagentRegistry;
    if (!registry) return false;
    try {
      return registry.stop(childSessionId);
    } catch (err) {
      logger.warn('AgentBridge.stopSubagent failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
