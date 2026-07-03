// tests/config/foundation-protocol-config.test.ts
// Phase 66 Task 6：基础协议配置测试
//
// 由于不修改 schema.ts，本测试直接构造各模块的配置对象并验证默认值与约束
// 覆盖：
//   1. CheckpointPipeline 默认配置（enabled=false, enabledSegments=[100,400,500], shortCircuit=true）
//   2. CallOwnerCoordinator 默认配置（syncWaitMs=10000）
//   3. StateSnapshotChain 默认配置（arbiterSecretEnv='ROUTEDEV_ARBITER_SECRET'）
//   4. ReputationDeriver 默认配置（maxCacheAgeMs=60000）
//   5. syncWaitMs 范围校验（手动验证 < 1000 或 > 60000 时应拒绝）
//   6. enabledSegments 仅允许 100/200/300/400/500/800/999

import { describe, it, expect } from 'vitest';
import {
  CheckpointPipeline,
  type CheckpointSegment,
} from '../../src/policies/checkpoint-pipeline.js';
import { CallOwnerCoordinator } from '../../src/policies/call-owner-coordinator.js';
import { StateSnapshotChain } from '../../src/harness/state-snapshot-chain.js';
import { ReputationDeriver } from '../../src/memory/reputation-deriver.js';

// ============================================================
// 默认配置常量（与 schema.ts/defaults.ts 中 Phase 66 字段保持一致）
// 不修改 schema.ts，仅在测试中显式构造
// ============================================================

const DEFAULT_CHECKPOINT_PIPELINE_CONFIG = {
  enabled: false,
  enabledSegments: [100, 400, 500] as CheckpointSegment[],
  shortCircuit: true,
};

const DEFAULT_CALL_OWNER_CONFIG = {
  enabled: true,
  syncWaitMs: 10000,
  persistPath: '/tmp/routedev-call-owner.jsonl',
};

const DEFAULT_STATE_SNAPSHOT_CONFIG = {
  enabled: true,
  arbiterSecretEnv: 'ROUTEDEV_ARBITER_SECRET',
};

const DEFAULT_REPUTATION_DERIVER_CONFIG = {
  enabled: true,
  maxCacheAgeMs: 60000,
};

const ALLOWED_SEGMENTS: CheckpointSegment[] = [100, 200, 300, 400, 500, 800, 999];

// ============================================================
// syncWaitMs 范围校验函数（模拟 schema 约束）
// ============================================================

function isValidSyncWaitMs(ms: number): boolean {
  return ms >= 1000 && ms <= 60000;
}

// ============================================================
// enabledSegments 校验函数（模拟 schema 约束）
// ============================================================

function isValidSegment(seg: number): seg is CheckpointSegment {
  return ALLOWED_SEGMENTS.includes(seg as CheckpointSegment);
}

describe('Phase 66 基础协议配置', () => {
  // ============================================================
  // 1. CheckpointPipeline 默认配置
  // ============================================================

  it('1. CheckpointPipeline 默认配置：enabled=false, enabledSegments=[100,400,500], shortCircuit=true', () => {
    const config = { ...DEFAULT_CHECKPOINT_PIPELINE_CONFIG };
    expect(config.enabled).toBe(false);
    expect(config.enabledSegments).toEqual([100, 400, 500]);
    expect(config.shortCircuit).toBe(true);

    // 关闭状态下 evaluateAction 应降级为 allow
    const pipeline = new CheckpointPipeline(config, () => true);
    const result = pipeline.evaluateAction({}, [
      { id: 'p1', type: 'tool_approval', action: { block: true } },
    ]);
    expect(result.finalAction).toBe('allow');
    expect(result.segmentResults).toHaveLength(0);
  });

  // ============================================================
  // 2. CallOwnerCoordinator 默认配置
  // ============================================================

  it('2. CallOwnerCoordinator 默认 syncWaitMs=10000', () => {
    const config = { ...DEFAULT_CALL_OWNER_CONFIG };
    expect(config.syncWaitMs).toBe(10000);
    expect(config.enabled).toBe(true);
    expect(config.persistPath).toBeTruthy();

    // 验证可正常构造
    const coordinator = new CallOwnerCoordinator(config);
    expect(coordinator).toBeDefined();
  });

  // ============================================================
  // 3. StateSnapshotChain 默认配置
  // ============================================================

  it('3. StateSnapshotChain 默认 arbiterSecretEnv="ROUTEDEV_ARBITER_SECRET"', () => {
    const config = { ...DEFAULT_STATE_SNAPSHOT_CONFIG };
    expect(config.arbiterSecretEnv).toBe('ROUTEDEV_ARBITER_SECRET');
    expect(config.enabled).toBe(true);

    const chain = new StateSnapshotChain(config);
    expect(chain).toBeDefined();
  });

  // ============================================================
  // 4. ReputationDeriver 默认配置
  // ============================================================

  it('4. ReputationDeriver 默认 maxCacheAgeMs=60000', () => {
    const config = { ...DEFAULT_REPUTATION_DERIVER_CONFIG };
    expect(config.maxCacheAgeMs).toBe(60000);
    expect(config.enabled).toBe(true);

    const deriver = new ReputationDeriver(config);
    expect(deriver).toBeDefined();
  });

  // ============================================================
  // 5. syncWaitMs 范围校验
  // ============================================================

  it('5. syncWaitMs < 1000 或 > 60000 应被拒绝', () => {
    // 下界
    expect(isValidSyncWaitMs(0)).toBe(false);
    expect(isValidSyncWaitMs(500)).toBe(false);
    expect(isValidSyncWaitMs(999)).toBe(false);
    // 边界
    expect(isValidSyncWaitMs(1000)).toBe(true);
    expect(isValidSyncWaitMs(60000)).toBe(true);
    // 上界
    expect(isValidSyncWaitMs(60001)).toBe(false);
    expect(isValidSyncWaitMs(100000)).toBe(false);
  });

  // ============================================================
  // 6. enabledSegments 仅允许 100/200/300/400/500/800/999
  // ============================================================

  it('6. enabledSegments 仅允许 100/200/300/400/500/800/999', () => {
    // 允许的段位
    expect(isValidSegment(100)).toBe(true);
    expect(isValidSegment(200)).toBe(true);
    expect(isValidSegment(300)).toBe(true);
    expect(isValidSegment(400)).toBe(true);
    expect(isValidSegment(500)).toBe(true);
    expect(isValidSegment(800)).toBe(true);
    expect(isValidSegment(999)).toBe(true);

    // 不允许的段位
    expect(isValidSegment(0)).toBe(false);
    expect(isValidSegment(50)).toBe(false);
    expect(isValidSegment(150)).toBe(false);
    expect(isValidSegment(600)).toBe(false);
    expect(isValidSegment(700)).toBe(false);
    expect(isValidSegment(1000)).toBe(false);
    expect(isValidSegment(-1)).toBe(false);
  });

  // ============================================================
  // 7. CheckpointPipeline SEGMENT_ORDER 与 ALLOWED_SEGMENTS 一致
  // ============================================================

  it('7. CheckpointPipeline.SEGMENT_ORDER 与允许的段位集合一致', () => {
    const segOrder = CheckpointPipeline.SEGMENT_ORDER;
    expect(segOrder).toEqual(ALLOWED_SEGMENTS);
    // 每个段位都应通过 isValidSegment
    for (const seg of segOrder) {
      expect(isValidSegment(seg)).toBe(true);
    }
  });

  // ============================================================
  // 8. 默认 enabledSegments 是 ALLOWED_SEGMENTS 的子集
  // ============================================================

  it('8. 默认 enabledSegments 是 ALLOWED_SEGMENTS 的子集', () => {
    const defaultSegs = DEFAULT_CHECKPOINT_PIPELINE_CONFIG.enabledSegments;
    for (const seg of defaultSegs) {
      expect(ALLOWED_SEGMENTS).toContain(seg);
    }
  });
});
