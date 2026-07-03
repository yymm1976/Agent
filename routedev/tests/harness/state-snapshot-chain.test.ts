// tests/harness/state-snapshot-chain.test.ts
// Phase 66 Task 4：StateSnapshotChain 测试
//
// 覆盖：
//   1. 写入非 settle 快照（无签名）
//   2. 写入 settle 快照（携带 HMAC 签名）
//   3. previousSnapshotHash 链式正确
//   4. verifyChain 链完整返回 true
//   5. 篡改 payload 后 verifyChain 返回 false
//   6. 篡改 settled 快照的 arbiterSignature 后 verifyChain 返回 false
//   7. getByMachineType 按类型过滤
//   8. 配置关闭时仅记录但不写快照链

import { describe, it, expect, beforeEach } from 'vitest';
import { StateSnapshotChain } from '../../src/harness/state-snapshot-chain.js';

describe('StateSnapshotChain (Phase 66 Task 4)', () => {
  let chain: StateSnapshotChain;

  beforeEach(() => {
    // 使用专用 env 变量，避免污染其他测试
    chain = new StateSnapshotChain({
      enabled: true,
      arbiterSecretEnv: 'ROUTEDEV_TEST_SECRET',
    });
  });

  // ============================================================
  // 非 settle 快照
  // ============================================================

  it('1. 写入非 settle 快照（无签名）', async () => {
    const record = await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 'start',
      payload: { foo: 'bar' },
      settled: false,
    });
    expect(record.machineType).toBe('compose_pipeline');
    expect(record.stage).toBe('start');
    expect(record.settled).toBe(false);
    expect(record.arbiterSignature).toBeUndefined();
    expect(record.hash).toHaveLength(64);
    expect(record.previousSnapshotHash).toBeNull();
    expect(record.timestamp).toBeGreaterThan(0);
  });

  // ============================================================
  // settle 快照
  // ============================================================

  it('2. 写入 settle 快照（携带 HMAC 签名）', async () => {
    const record = await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 'final',
      payload: { result: 'success' },
      settled: true,
    });
    expect(record.settled).toBe(true);
    expect(record.arbiterSignature).toBeTruthy();
    expect(record.arbiterSignature).toHaveLength(64);
    expect(record.hash).toHaveLength(64);
  });

  // ============================================================
  // 链式正确性
  // ============================================================

  it('3. previousSnapshotHash 链式正确', async () => {
    const r1 = await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's1',
      payload: { n: 1 },
      settled: false,
    });
    const r2 = await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's2',
      payload: { n: 2 },
      settled: false,
    });
    expect(r1.previousSnapshotHash).toBeNull();
    expect(r2.previousSnapshotHash).toBe(r1.hash);
  });

  it('不同 machineType 独立成链', async () => {
    const r1 = await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's1',
      payload: { n: 1 },
      settled: false,
    });
    const r2 = await chain.writeSnapshot({
      machineType: 'cross_model_review',
      stage: 's1',
      payload: { n: 2 },
      settled: false,
    });
    // 不同 machineType 的 previousSnapshotHash 都为 null（独立链）
    expect(r1.previousSnapshotHash).toBeNull();
    expect(r2.previousSnapshotHash).toBeNull();
  });

  // ============================================================
  // verifyChain 完整
  // ============================================================

  it('4. verifyChain 链完整返回 true', async () => {
    await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's1',
      payload: { n: 1 },
      settled: false,
    });
    await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's2',
      payload: { n: 2 },
      settled: true,
    });
    expect(chain.verifyChain()).toBe(true);
  });

  it('空链 verifyChain 返回 true', () => {
    expect(chain.verifyChain()).toBe(true);
  });

  // ============================================================
  // 篡改 payload
  // ============================================================

  it('5. 篡改 payload 后 verifyChain 返回 false', async () => {
    await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's1',
      payload: { n: 1 },
      settled: false,
    });
    await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's2',
      payload: { n: 2 },
      settled: false,
    });
    // 篡改第一条记录的 payload
    const records = chain.getByMachineType('compose_pipeline');
    records[0].payload = { n: 999 };
    expect(chain.verifyChain()).toBe(false);
  });

  // ============================================================
  // 篡改 arbiterSignature
  // ============================================================

  it('6. 篡改 arbiterSignature 后 verifyChain 返回 false', async () => {
    await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's1',
      payload: { n: 1 },
      settled: true,
    });
    const records = chain.getByMachineType('compose_pipeline');
    // 用一个看起来合法但内容不对的签名替换
    records[0].arbiterSignature = 'a'.repeat(64);
    expect(chain.verifyChain()).toBe(false);
  });

  it('篡改 hash 后 verifyChain 返回 false', async () => {
    await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's1',
      payload: { n: 1 },
      settled: false,
    });
    const records = chain.getByMachineType('compose_pipeline');
    records[0].hash = 'b'.repeat(64);
    expect(chain.verifyChain()).toBe(false);
  });

  it('篡改 previousSnapshotHash 后 verifyChain 返回 false', async () => {
    await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's1',
      payload: { n: 1 },
      settled: false,
    });
    await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's2',
      payload: { n: 2 },
      settled: false,
    });
    const records = chain.getByMachineType('compose_pipeline');
    // 篡改第二条记录的 previousSnapshotHash
    records[1].previousSnapshotHash = 'c'.repeat(64);
    expect(chain.verifyChain()).toBe(false);
  });

  // ============================================================
  // getByMachineType
  // ============================================================

  it('7. getByMachineType 按类型过滤', async () => {
    await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's1',
      payload: {},
      settled: false,
    });
    await chain.writeSnapshot({
      machineType: 'cross_model_review',
      stage: 's1',
      payload: {},
      settled: false,
    });
    await chain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's2',
      payload: {},
      settled: false,
    });
    await chain.writeSnapshot({
      machineType: 'call_owner_approval',
      stage: 's1',
      payload: {},
      settled: false,
    });

    const compose = chain.getByMachineType('compose_pipeline');
    const cross = chain.getByMachineType('cross_model_review');
    const callOwner = chain.getByMachineType('call_owner_approval');

    expect(compose).toHaveLength(2);
    expect(cross).toHaveLength(1);
    expect(callOwner).toHaveLength(1);
    expect(compose[0].stage).toBe('s1');
    expect(compose[1].stage).toBe('s2');
  });

  // ============================================================
  // 配置关闭
  // ============================================================

  it('8. 配置关闭时仅记录但不写快照链', async () => {
    const offChain = new StateSnapshotChain({
      enabled: false,
      arbiterSecretEnv: 'ROUTEDEV_TEST_SECRET',
    });
    const record = await offChain.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's1',
      payload: { foo: 'bar' },
      settled: true,
    });
    // 返回的记录无链信息
    expect(record.previousSnapshotHash).toBeNull();
    expect(record.arbiterSignature).toBeUndefined();
    expect(record.hash).toBe('');
    // 不写入 records 数组
    expect(offChain.getByMachineType('compose_pipeline')).toHaveLength(0);
    // verifyChain 在关闭时返回 true
    expect(offChain.verifyChain()).toBe(true);
  });

  // ============================================================
  // 默认 secret 回退
  // ============================================================

  it('arbiterSecretEnv 未设置时使用默认 secret', async () => {
    // 不设置 env 变量
    const envName = 'ROUTEDEV_NON_EXISTENT_SECRET_' + Date.now();
    const chain2 = new StateSnapshotChain({
      enabled: true,
      arbiterSecretEnv: envName,
    });
    const record = await chain2.writeSnapshot({
      machineType: 'compose_pipeline',
      stage: 's1',
      payload: { foo: 'bar' },
      settled: true,
    });
    // 应能正常签名并验证通过
    expect(record.arbiterSignature).toBeTruthy();
    expect(chain2.verifyChain()).toBe(true);
  });
});
