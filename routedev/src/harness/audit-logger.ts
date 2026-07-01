// src/harness/audit-logger.ts
// 审计日志器：记录所有敏感/关键操作到 JSONL
// Phase 53 Task 4：扩展为 SHA-256 哈希链，提供防篡改能力（可配置开关）

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  AuditRecord,
  AuditAction,
  AuditLoggerConfig,
  TrajectorySummary,
} from './trace-types.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir, ensureDir } from '../utils/paths.js';

/** Phase 40 Task 3：质量元数据（附加到审计记录） */
export interface QualityMetadata {
  source: 'implicit' | 'explicit';
  signalType: string;
  severity: 'low' | 'medium' | 'high';
  modelId?: string;
  knowledgeNodeId?: string;
}

/** Phase 40 Task 3：扩展的审计动作类型（包含质量信号与用户反馈） */
export type ExtendedAuditAction = AuditAction | 'user_feedback' | 'quality_signal';

/** Phase 40 Task 3：扩展的审计记录（带 qualityMetadata） */
export interface QualityAuditRecord extends AuditRecord {
  qualityMetadata?: QualityMetadata;
}

/**
 * Phase 53 Task 4：哈希链审计记录
 * 每条记录包含 previousHash，形成防篡改链
 * hash = SHA-256(timestamp + agentId + action + target + previousHash + details)
 */
export interface HashChainRecord extends AuditRecord {
  /** 上一条记录的 hash（创世记录为 64 个 '0'） */
  previousHash: string;
  /** 当前记录的 hash */
  hash: string;
}

/**
 * Phase 53 Task 4：哈希链审计配置
 * enabled=true 时启用哈希链（默认 false，向后兼容）
 */
export interface AuditChainConfig {
  /** 是否启用哈希链 */
  enabled: boolean;
  /** 审计日志文件路径（可选，默认沿用 AuditLogger 的 storageDir） */
  logFile?: string;
  /** 溢出时保留的接缝哈希数 */
  overflowSealCount?: number;
}

/** Phase 40 Task 3：质量信号统一接口（兼容 QualitySignal 与 FeedbackSignal） */
export interface LoggableQualitySignal {
  source: 'implicit' | 'explicit';
  signalType: string;
  severity: 'low' | 'medium' | 'high';
  modelId?: string;
  knowledgeNodeId?: string;
  timestamp: number;
  context?: Record<string, unknown>;
}

const DEFAULT_CONFIG: AuditLoggerConfig = {
  enabled: true,
  retentionDays: 30,
};

/** Phase 53 Task 4：创世哈希（64 个 '0'） */
const GENESIS_HASH = '0'.repeat(64);

export class AuditLogger {
  private config: AuditLoggerConfig;
  /**
   * Phase 53 Task 4：哈希链配置
   * enabled=false 时退回普通追加日志（向后兼容）
   */
  private chainConfig: AuditChainConfig = { enabled: false };
  /** 上一条记录的 hash（链式） */
  private previousHash: string = GENESIS_HASH;
  private sessionId: string;

  constructor(sessionId: string, config?: Partial<AuditLoggerConfig>) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Phase 53 Task 4：启用/禁用哈希链
   * 启用后，所有 log() 写入的记录会包含 previousHash + hash 字段
   * 禁用时退回普通追加日志（向后兼容）
   */
  setChainConfig(chainConfig: AuditChainConfig): void {
    this.chainConfig = chainConfig;
    // 启用时重置 previousHash 为创世哈希（新链开始）
    if (chainConfig.enabled) {
      this.previousHash = GENESIS_HASH;
    }
  }

  /** Phase 53 Task 4：计算记录的 SHA-256 哈希 */
  private computeHash(record: AuditRecord, previousHash: string): string {
    const data = `${record.timestamp}${record.agentId}${record.action}${record.target}${previousHash}${JSON.stringify(record.details)}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Phase 53 Task 4：验证哈希链完整性
   * 用 timingSafeEqual 防止时序攻击
   * @param records 按时间顺序排列的哈希链记录
   * @returns true=链完整，false=被篡改或链断裂
   */
  verifyChain(records: HashChainRecord[]): boolean {
    let prevHash = GENESIS_HASH;
    for (const record of records) {
      // 1. 验证 previousHash 链接正确
      if (record.previousHash !== prevHash) {
        return false; // 链断裂
      }
      // 2. 验证当前记录的 hash 未被篡改
      const computed = this.computeHash(record, record.previousHash);
      try {
        // timingSafeEqual 要求两个 Buffer 长度相等
        const computedBuf = Buffer.from(computed, 'hex');
        const recordBuf = Buffer.from(record.hash, 'hex');
        if (computedBuf.length !== recordBuf.length || !crypto.timingSafeEqual(computedBuf, recordBuf)) {
          return false; // 哈希不匹配，记录被篡改
        }
      } catch {
        return false; // hash 格式无效
      }
      prevHash = record.hash;
    }
    return true;
  }

  /** 记录一条审计事件 */
  log(
    action: AuditAction,
    target: string,
    details: Record<string, unknown>,
    result: AuditRecord['result'] = 'success',
    agentId = 'main',
    confirmation?: AuditRecord['confirmation'],
    qualityMetadata?: QualityMetadata,
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

    // Phase 40 Task 3：附加质量元数据（如果提供）
    if (qualityMetadata) {
      (record as QualityAuditRecord).qualityMetadata = qualityMetadata;
    }

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

  /**
   * Phase 34：记录 trajectory 级过程评测汇总
   * 触发点：任务完成、失败、取消、达到最大迭代次数时
   */
  logTrajectorySummary(summary: TrajectorySummary): void {
    this.log(
      'trajectory_summary',
      summary.taskId,
      { summary },
      summary.success ? 'success' : 'failure',
      'main',
    );
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

  /**
   * Phase 40 Task 3：记录质量信号或用户反馈信号
   * 自动判定 action 类型：
   *   - source === 'explicit' → 'user_feedback'
   *   - source === 'implicit' → 'quality_signal'
   */
  logQualitySignal(signal: LoggableQualitySignal): void {
    if (!this.config.enabled) return;

    const action: ExtendedAuditAction =
      signal.source === 'explicit' ? 'user_feedback' : 'quality_signal';
    const qualityMetadata: QualityMetadata = {
      source: signal.source,
      signalType: signal.signalType,
      severity: signal.severity,
      ...(signal.modelId !== undefined ? { modelId: signal.modelId } : {}),
      ...(signal.knowledgeNodeId !== undefined ? { knowledgeNodeId: signal.knowledgeNodeId } : {}),
    };

    // 使用类型断言绕过 AuditAction 限制（trace-types.ts 不在本任务修改范围）
    this.log(
      action as unknown as AuditAction,
      signal.signalType,
      {
        timestamp: signal.timestamp,
        ...(signal.context ?? {}),
      },
      signal.severity === 'high' ? 'failure' : 'success',
      'main',
      undefined,
      qualityMetadata,
    );
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

    // Phase 53 Task 4：哈希链启用时，附加 previousHash + hash 字段
    let recordToWrite: AuditRecord | HashChainRecord = record;
    if (this.chainConfig.enabled) {
      const hash = this.computeHash(record, this.previousHash);
      const chainRecord: HashChainRecord = {
        ...record,
        previousHash: this.previousHash,
        hash,
      };
      this.previousHash = hash; // 更新链指针
      recordToWrite = chainRecord;
    }

    // 同步写入保证测试可读性；生产环境可换 appendFile
    try {
      fsSync.appendFileSync(filePath, JSON.stringify(recordToWrite) + '\n', 'utf-8');
    } catch (err) {
      logger.warn('AuditLogger: write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private getStorageDir(): string {
    return this.config.storageDir
      ?? path.join(getAppDataDir(), 'audit');
  }
}