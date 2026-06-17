// src/harness/audit-logger.ts
// 审计日志器：记录所有敏感/关键操作到 JSONL

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AuditRecord,
  AuditAction,
  AuditLoggerConfig,
} from './trace-types.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir, ensureDir } from '../utils/paths.js';

const DEFAULT_CONFIG: AuditLoggerConfig = {
  enabled: true,
  retentionDays: 30,
};

export class AuditLogger {
  private config: AuditLoggerConfig;
  private sessionId: string;

  constructor(sessionId: string, config?: Partial<AuditLoggerConfig>) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 记录一条审计事件 */
  log(
    action: AuditAction,
    target: string,
    details: Record<string, unknown>,
    result: AuditRecord['result'] = 'success',
    agentId = 'main',
    confirmation?: AuditRecord['confirmation'],
  ): void {
    if (!this.config.enabled) return;

    const record: AuditRecord = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      action,
      agentId,
      target,
      details,
      result,
      confirmation,
    };

    this.writeRecord(record);
  }

  /** 快捷方法 */
  logFileWrite(filePath: string, agentId = 'main'): void {
    this.log('file_write', filePath, { operation: 'write' }, 'success', agentId);
  }

  logShellExec(command: string, agentId = 'main'): void {
    this.log('shell_exec', command, { commandLength: command.length }, 'success', agentId);
  }

  logUserConfirm(toolName: string, approved: boolean, reason?: string): void {
    this.log(
      approved ? 'user_confirm' : 'user_deny',
      toolName,
      { reason },
      approved ? 'success' : 'denied',
      'main',
      { requested: true, approved, reason },
    );
  }

  logRouteDecision(modelId: string, tier: string, fallbackUsed: boolean): void {
    this.log('route_decision', modelId, { tier, fallbackUsed }, 'success');
  }

  logGoalStart(goalId: string, description: string, stepCount: number): void {
    this.log('goal_start', goalId, {
      description: description.slice(0, 100),
      stepCount,
    });
  }

  logGoalComplete(goalId: string, success: boolean): void {
    this.log(
      success ? 'goal_complete' : 'goal_fail',
      goalId,
      {},
      success ? 'success' : 'failure',
    );
  }

  logRollback(checkpointId: string, commitHash: string): void {
    this.log('rollback', checkpointId, { commitHash });
  }

  logBlackboardWrite(key: string, sourceRole: string, stepId: number): void {
    this.log('blackboard_write', key, { sourceRole, stepId });
  }

  logChannelMessage(
    direction: 'in' | 'out',
    channelType: string,
    sender: string,
    textLength: number,
  ): void {
    const action: AuditAction = direction === 'in' ? 'channel_message_in' : 'channel_message_out';
    this.log(action, channelType, { sender, textLength });
  }

  /** 清理过期的审计文件 */
  async cleanup(): Promise<number> {
    const dir = this.getStorageDir();
    let removedCount = 0;

    try {
      const entries = await fs.readdir(dir);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.config.retentionDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      for (const entry of entries) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
        if (entry < cutoffStr) {
          const dayDir = path.join(dir, entry);
          try {
            await fs.rm(dayDir, { recursive: true, force: true });
            removedCount++;
          } catch {
            logger.warn('AuditLogger: failed to remove old directory', { dir: dayDir });
          }
        }
      }
    } catch {
      // 目录不存在
    }

    if (removedCount > 0) {
      logger.info('AuditLogger: cleaned up old records', {
        removedDays: removedCount,
        retentionDays: this.config.retentionDays,
      });
    }

    return removedCount;
  }

  /** 列出今天的审计记录 */
  async listToday(limit = 50): Promise<AuditRecord[]> {
    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = path.join(dir, today);

    try {
      const files = await fs.readdir(dayDir);
      const records: AuditRecord[] = [];

      for (const file of files) {
        if (!file.endsWith('.audit.jsonl')) continue;
        const content = await fs.readFile(path.join(dayDir, file), 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            records.push(JSON.parse(line));
          } catch {
            // 跳过损坏行
          }
        }
      }

      return records
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /** 按 action 类型过滤 */
  async listByAction(action: AuditAction, limit = 50): Promise<AuditRecord[]> {
    const all = await this.listToday(200);
    return all.filter(r => r.action === action).slice(0, limit);
  }

  private writeRecord(record: AuditRecord): void {
    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = path.join(dir, today);
    const filePath = path.join(dayDir, `${this.sessionId}.audit.jsonl`);
    ensureDir(dayDir);
    fs.appendFile(filePath, JSON.stringify(record) + '\n', 'utf-8').catch(err => {
      logger.warn('AuditLogger: write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private getStorageDir(): string {
    return this.config.storageDir
      ?? path.join(getAppDataDir(), 'audit');
  }
}