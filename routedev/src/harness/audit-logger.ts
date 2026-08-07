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
import { createOrderedRevision } from '../utils/ordered-revision.js';
import { getAppDataDir, ensureDir } from '../utils/paths.js';

/** Phase 40 Task 3：质量元数据（附加到审计记录） */
export interface QualityMetadata {
  source: 'implicit' | 'explicit';
  signalType: string;
  severity: 'low' | 'medium' | 'high';
  modelId?: string;
  knowledgeNodeId?: string;
}

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
    // A5：per-day 链语义——启用时先尝试恢复当日文件尾部 hash 作为 chain head；
    // 当日无文件（或首条）用创世哈希。进程重启/logger 重建后同一天追加仍链连续。
    if (chainConfig.enabled) {
      this.previousHash = this.restoreChainHead() ?? GENESIS_HASH;
    }
  }

  /**
   * Phase 53 Task 4：计算记录的 SHA-256 哈希
   * 第九轮复审（AuditEnvelope V2）：canonical serialization——覆盖全部
   * 安全相关字段（eventId/sequence/sessionId/result/confirmation/
   * qualityMetadata 此前缺失：攻击者改 result 或 sequence 后链仍验证通过）。
   * JSON.stringify 的对象键序 = 字面量声明序（确定性），无需额外排序。
   */
  private computeHash(record: AuditRecord, previousHash: string): string {
    const data = JSON.stringify({
      timestamp: record.timestamp,
      eventId: record.eventId,
      sequence: record.sequence,
      sessionId: record.sessionId,
      agentId: record.agentId,
      action: record.action,
      target: record.target,
      result: record.result,
      confirmation: record.confirmation,
      qualityMetadata: (record as QualityAuditRecord).qualityMetadata,
      details: record.details,
      previousHash,
    });
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
      } catch (e) {
        // hash 格式无效（hex 解码失败或长度不匹配），视为篡改
        logger.warn('[audit-logger] 哈希链验证：hash 格式无效', {
          error: e instanceof Error ? e.message : String(e),
        });
        return false;
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

    // 第九轮复审：确定性顺序原语——eventId 可排序、sequence 单调
    const rev = createOrderedRevision();
    const record: AuditRecord = {
      timestamp: new Date(rev.wallTimeMs).toISOString(),
      eventId: rev.id,
      sequence: rev.sequence,
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

    const action: AuditAction =
      signal.source === 'explicit' ? 'user_feedback' : 'quality_signal';
    const qualityMetadata: QualityMetadata = {
      source: signal.source,
      signalType: signal.signalType,
      severity: signal.severity,
      ...(signal.modelId !== undefined ? { modelId: signal.modelId } : {}),
      ...(signal.knowledgeNodeId !== undefined ? { knowledgeNodeId: signal.knowledgeNodeId } : {}),
    };

    this.log(
      action,
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
    } catch (e) {
      // 目录不存在或读取失败（ENOENT 是正常情况，首次启动尚未创建审计目录）
      logger.debug('[audit-logger] cleanup: 读取审计目录失败', {
        dir,
        error: e instanceof Error ? e.message : String(e),
      });
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
      // 解析时记录文件内行序（跨进程/重启时 sequence 会重置，行序兜底）
      const records: Array<AuditRecord & { _ordinal: number }> = [];

      for (const file of files) {
        if (!file.endsWith('.audit.jsonl')) continue;
        const content = await fs.readFile(path.join(dayDir, file), 'utf-8');
        let ordinal = 0;
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          ordinal += 1;
          try {
            records.push({ ...JSON.parse(line), _ordinal: ordinal });
          } catch (e) {
            // 损坏行（JSON 解析失败），跳过继续解析下一行
            logger.warn('[audit-logger] listToday: 跳过损坏的审计行', {
              file,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      // P0 复审：排序确定——timestamp DESC，同毫秒用 sequence DESC（进程内单调），
      // 跨进程/重启同毫秒用文件行序（追加顺序）兜底
      return records
        .sort((a, b) =>
          b.timestamp.localeCompare(a.timestamp)
          || (b.sequence ?? 0) - (a.sequence ?? 0)
          || b._ordinal - a._ordinal)
        .slice(0, limit);
    } catch (e) {
      // 读取今日审计目录失败（ENOENT 是正常情况），返回空数组
      logger.debug('[audit-logger] listToday: 读取审计目录失败', {
        dayDir,
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  }

  /** 按 action 类型过滤 */
  async listByAction(action: AuditAction, limit = 50): Promise<AuditRecord[]> {
    const all = await this.listToday(200);
    return all.filter(r => r.action === action).slice(0, limit);
  }

  /**
   * A5：从当日文件尾部恢复 chain head（per-day 链：文件即链边界）。
   * 返回 null = 当日无记录（新链从 genesis 开始）。
   * 文件尾部损坏/截断：返回 null 并告警——新链从 genesis 开始（旧记录
   * verifyChain 会失败，属 tamper-evident 语义而非静默修复）。
   */
  private restoreChainHead(): string | null {
    if (!this.chainConfig.enabled) return null;
    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(dir, today, `${this.sessionId}.audit.jsonl`);
    if (!fsSync.existsSync(filePath)) return null;
    try {
      const content = fsSync.readFileSync(filePath, 'utf-8');
      const lines = content.split(String.fromCharCode(10)).filter((l) => l.trim());
      if (lines.length === 0) return null;
      const last = JSON.parse(lines[lines.length - 1]) as HashChainRecord;
      if (typeof last.hash === 'string' && last.hash.length === 64) return last.hash;
      logger.warn('[audit-logger] chain head restore: 尾记录无有效 hash（截断？），从 genesis 开始新链', {
        file: filePath,
      });
      return null;
    } catch (e) {
      logger.warn('[audit-logger] chain head restore failed, starting from genesis', {
        file: filePath,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  private writeRecord(record: AuditRecord): void {
    const dir = this.getStorageDir();
    const today = new Date().toISOString().slice(0, 10);
    const dayDir = path.join(dir, today);
    const filePath = path.join(dayDir, `${this.sessionId}.audit.jsonl`);
    ensureDir(dayDir);

    // Phase 53 Task 4：哈希链启用时，附加 previousHash + hash 字段
    // 第九轮复审（AuditEnvelope V2 事务性）：先持久化、成功后才推进内存 chain head。
    // 此前先推进 previousHash 再 append——append 失败时内存链指向不存在的 B，
    // 下一条 C 写 previousHash=B 但磁盘无 B，链永久断裂（A → [B missing] → C）。
    if (this.chainConfig.enabled) {
      const hash = this.computeHash(record, this.previousHash);
      const chainRecord: HashChainRecord = {
        ...record,
        previousHash: this.previousHash,
        hash,
      };
      try {
        fsSync.appendFileSync(filePath, JSON.stringify(chainRecord) + '\n', 'utf-8');
        this.previousHash = hash; // 持久化成功才 commit chain head
      } catch (err) {
        logger.warn('AuditLogger: write failed (chain head not advanced)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // 同步写入保证测试可读性；生产环境可换 appendFile
    try {
      fsSync.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
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