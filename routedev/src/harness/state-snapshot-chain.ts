// src/harness/state-snapshot-chain.ts
// Phase 66 Task 4：状态快照链
//
// 设计目标：
//   1. 跨状态机（compose_pipeline/cross_model_review/call_owner_approval）的状态快照
//   2. SHA-256 哈希链（previousSnapshotHash → hash），按 machineType 维度独立成链
//   3. settled=true 时附加 HMAC-SHA256 仲裁签名
//   4. verifyChain 验证链完整性 + 签名（用 timingSafeEqual 防时序攻击）
//   5. fail-open：异常或关闭时不阻塞主流程
//
// 注意：不修改 audit-logger.ts；本模块独立维护自己的快照链

import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

export type StateMachineType =
  | 'compose_pipeline'
  | 'cross_model_review'
  | 'call_owner_approval';

export interface StateSnapshotRecord {
  machineType: StateMachineType;
  stage: string;
  payload: any;
  /** 上一条快照的 hash（创世为 null） */
  previousSnapshotHash: string | null;
  /** 当前快照的 SHA-256 hash */
  hash: string;
  /** 仲裁签名（仅 settled=true 时存在） */
  arbiterSignature?: string;
  settled: boolean;
  timestamp: number;
}

// ============================================================
// 常量
// ============================================================

const DEFAULT_SECRET = 'routedev-default-secret';

// ============================================================
// StateSnapshotChain
// ============================================================

export class StateSnapshotChain {
  private config: { enabled: boolean; arbiterSecretEnv: string };
  private records: StateSnapshotRecord[] = [];
  /** 每个 machineType 独立维护链指针 */
  private previousHashByMachine: Map<StateMachineType, string> = new Map();

  constructor(config: { enabled: boolean; arbiterSecretEnv: string }) {
    this.config = config;
  }

  /** 获取仲裁密钥：优先 env，缺省用默认 */
  private getSecret(): string {
    return process.env[this.config.arbiterSecretEnv] || DEFAULT_SECRET;
  }

  /** 计算 SHA-256 hash(payload + previousHash) */
  private computeHash(payload: any, previousHash: string | null): string {
    const data = JSON.stringify({ payload, previousHash });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /** 计算 HMAC-SHA256 签名（基于 hash） */
  private sign(hash: string): string {
    return crypto.createHmac('sha256', this.getSecret()).update(hash).digest('hex');
  }

  /**
   * 写入快照
   * - 关闭时仅返回记录（无链信息），不写入 records 数组
   * - settled=true 时附加 HMAC 签名
   * - 每个 machineType 独立链式
   */
  async writeSnapshot(params: {
    machineType: StateMachineType;
    stage: string;
    payload: any;
    settled: boolean;
  }): Promise<StateSnapshotRecord> {
    // fail-open：关闭时仅返回记录，不写快照链
    if (!this.config.enabled) {
      return {
        machineType: params.machineType,
        stage: params.stage,
        payload: params.payload,
        previousSnapshotHash: null,
        hash: '',
        settled: params.settled,
        timestamp: Date.now(),
      };
    }

    const previousHash = this.previousHashByMachine.get(params.machineType) ?? null;
    const hash = this.computeHash(params.payload, previousHash);

    const record: StateSnapshotRecord = {
      machineType: params.machineType,
      stage: params.stage,
      payload: params.payload,
      previousSnapshotHash: previousHash,
      hash,
      settled: params.settled,
      timestamp: Date.now(),
    };

    if (params.settled) {
      record.arbiterSignature = this.sign(hash);
    }

    this.records.push(record);
    this.previousHashByMachine.set(params.machineType, hash);

    return record;
  }

  /**
   * 验证哈希链完整性 + 签名
   * - 检查每条记录的 previousSnapshotHash 链接正确
   * - 检查每条记录的 hash 与 computeHash(payload, previousHash) 一致
   * - 检查 settled 记录的 arbiterSignature 与 HMAC 一致
   * - 用 timingSafeEqual 防时序攻击
   */
  verifyChain(): boolean {
    // 关闭时视为有效（无链可验）
    if (!this.config.enabled) return true;

    try {
      const previousHashByMachine = new Map<StateMachineType, string | null>();
      for (const record of this.records) {
        // 1. 检查 previousSnapshotHash 链接
        const expectedPrev = previousHashByMachine.get(record.machineType) ?? null;
        if (record.previousSnapshotHash !== expectedPrev) {
          return false;
        }

        // 2. 检查 hash 未被篡改
        const computedHash = this.computeHash(record.payload, record.previousSnapshotHash);
        if (!this.safeEqualHex(computedHash, record.hash)) {
          return false;
        }

        // 3. 检查 settled 记录的签名
        if (record.settled) {
          const expectedSig = this.sign(record.hash);
          if (!this.safeEqualHex(expectedSig, record.arbiterSignature ?? '')) {
            return false;
          }
        }

        previousHashByMachine.set(record.machineType, record.hash);
      }
      return true;
    } catch (err) {
      logger.warn('StateSnapshotChain: verifyChain threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** 按机器类型过滤快照 */
  getByMachineType(type: StateMachineType): StateSnapshotRecord[] {
    return this.records.filter((r) => r.machineType === type);
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** timingSafeEqual 比较两个 hex 字符串（长度不等或异常返回 false） */
  private safeEqualHex(a: string, b: string): boolean {
    try {
      const aBuf = Buffer.from(a, 'hex');
      const bBuf = Buffer.from(b, 'hex');
      if (aBuf.length !== bBuf.length) return false;
      return crypto.timingSafeEqual(aBuf, bBuf);
    } catch {
      return false;
    }
  }
}
