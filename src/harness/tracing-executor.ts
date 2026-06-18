// src/harness/tracing-executor.ts
// 装饰器：透明地为 ToolExecutorAdapter 注入 Trace + Audit 记录

import type { ToolExecutorAdapter } from '../agent/loop-config.js';
import type { LLMToolDefinition } from '../router/types.js';
import type { TraceCollector } from './trace-collector.js';
import type { AuditLogger } from './audit-logger.js';
import { logger } from '../utils/logger.js';

/** 敏感工具列表 */
const AUDITED_TOOLS = new Set([
  'file_write',
  'file_delete',
  'shell_exec',
  'git_op',
]);

export class TracingToolExecutor implements ToolExecutorAdapter {
  private inner: ToolExecutorAdapter;
  private trace: TraceCollector;
  private audit: AuditLogger;
  private agentId: string;

  constructor(
    inner: ToolExecutorAdapter,
    trace: TraceCollector,
    audit: AuditLogger,
    agentId = 'main',
  ) {
    this.inner = inner;
    this.trace = trace;
    this.audit = audit;
    this.agentId = agentId;
  }

  getToolDefinitions(): LLMToolDefinition[] {
    return this.inner.getToolDefinitions();
  }

  hasTool(toolName: string): boolean {
    return this.inner.hasTool(toolName);
  }

  async executeTool(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    this.trace.recordToolCall(toolName, args, toolCallId, false);
    const startTime = Date.now();

    try {
      const result = await this.inner.executeTool(toolName, toolCallId, args);
      const durationMs = Date.now() - startTime;
      this.trace.recordToolResult(toolName, toolCallId, result, false);

      if (AUDITED_TOOLS.has(toolName)) {
        const target = this.extractTarget(toolName, args);
        if (toolName === 'shell_exec') {
          this.audit.logShellExec(target, this.agentId);
        } else {
          this.audit.logFileWrite(target, this.agentId);
        }
      }

      logger.debug('Tool executed (traced)', {
        toolName,
        durationMs,
        resultLength: result.length,
      });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.trace.recordToolResult(toolName, toolCallId, errorMsg, true);

      if (AUDITED_TOOLS.has(toolName)) {
        const target = this.extractTarget(toolName, args);
        this.audit.log(
          toolName === 'shell_exec' ? 'shell_exec' : 'file_write',
          target,
          { error: errorMsg },
          'failure',
          this.agentId,
        );
      }

      throw error;
    }
  }

  /** 更新内部 executor */
  updateInner(inner: ToolExecutorAdapter): void {
    this.inner = inner;
  }

  /** 从工具参数中提取操作目标 */
  private extractTarget(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'file_write':
      case 'file_read':
      case 'file_delete':
        return String(args['filePath'] ?? args['path'] ?? 'unknown');
      case 'shell_exec':
        return String(args['command'] ?? 'unknown');
      case 'git_op':
        return `git ${args['operation'] ?? 'unknown'}`;
      default:
        return toolName;
    }
  }
}