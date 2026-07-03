// tests/policies/call-owner-coordinator.test.ts
// Phase 66 Task 2：CallOwnerCoordinator 测试
//
// 覆盖：
//   1. always_pass 直接返回 approved
//   2. always_call 创建 pending
//   3. 同步期内响应→approved/denied
//   4. 同步超时→timeout_pending
//   5. 超时后异步响应→触发 onRecovery
//   6. approvalId 不存在时 respondApproval 返回 false
//   7. 配置关闭时跳过（直接 approved）
//   8. 多条并发审批互不干扰

import { describe, it, expect, beforeEach } from 'vitest';
import { CallOwnerCoordinator } from '../../src/policies/call-owner-coordinator.js';

describe('CallOwnerCoordinator (Phase 66 Task 2)', () => {
  let coordinator: CallOwnerCoordinator;

  beforeEach(() => {
    coordinator = new CallOwnerCoordinator({
      enabled: true,
      syncWaitMs: 100, // 测试用短超时
      persistPath: '/tmp/routedev-test.jsonl',
    });
  });

  // ============================================================
  // always_pass
  // ============================================================

  it('1. always_pass 直接返回 approved', async () => {
    const result = await coordinator.requestApproval({ tool: 'test' }, 'always_pass');
    expect(result.state).toBe('approved');
    expect(result.approvalId).toBeTruthy();
    // 不应创建 pending
    expect(coordinator.loadPendingApprovals()).toHaveLength(0);
  });

  // ============================================================
  // always_call 创建 pending
  // ============================================================

  it('2. always_call 创建 pending（同步等待）', async () => {
    const promise = coordinator.requestApproval({ tool: 'test' }, 'always_call');
    // 立即检查 pending（同步部分已执行）
    const pending = coordinator.loadPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].state).toBe('pending');
    expect(pending[0].strategy).toBe('always_call');

    const result = await promise;
    expect(result.state).toBe('timeout_pending');
  });

  // ============================================================
  // 同步期内响应
  // ============================================================

  it('3. 同步期内响应→approved', async () => {
    const promise = coordinator.requestApproval({ tool: 'test' }, 'always_call');
    const pending = coordinator.loadPendingApprovals();
    const approvalId = pending[0].approvalId;

    const found = coordinator.respondApproval(approvalId, true);
    expect(found).toBe(true);

    const result = await promise;
    expect(result.state).toBe('approved');
  });

  it('同步期内响应→denied', async () => {
    const promise = coordinator.requestApproval({ tool: 'test' }, 'always_call');
    const pending = coordinator.loadPendingApprovals();
    coordinator.respondApproval(pending[0].approvalId, false);

    const result = await promise;
    expect(result.state).toBe('denied');
  });

  // ============================================================
  // 同步超时
  // ============================================================

  it('4. 同步超时→timeout_pending', async () => {
    const result = await coordinator.requestApproval({ tool: 'test' }, 'always_call');
    expect(result.state).toBe('timeout_pending');

    const pending = coordinator.loadPendingApprovals();
    expect(pending[0].state).toBe('timeout_pending');
  });

  // ============================================================
  // 超时后异步响应→触发 onRecovery
  // ============================================================

  it('5. 超时后异步响应→触发 onRecovery', async () => {
    const recoveryCalls: any[] = [];
    coordinator.onRecovery((approval) => {
      recoveryCalls.push({ ...approval });
    });

    // 等待超时
    const result = await coordinator.requestApproval({ tool: 'test' }, 'always_call');
    expect(result.state).toBe('timeout_pending');

    // 超时时的 recovery 回调应已触发
    expect(recoveryCalls.length).toBeGreaterThanOrEqual(1);
    expect(recoveryCalls[0].state).toBe('timeout_pending');

    // 超时后响应
    const pending = coordinator.loadPendingApprovals();
    coordinator.respondApproval(pending[0].approvalId, true);

    // 应再次触发 onRecovery，且最终状态为 approved
    expect(recoveryCalls.length).toBeGreaterThanOrEqual(2);
    const last = recoveryCalls[recoveryCalls.length - 1];
    expect(last.state).toBe('approved');
  });

  // ============================================================
  // approvalId 不存在
  // ============================================================

  it('6. approvalId 不存在时 respondApproval 返回 false', () => {
    const found = coordinator.respondApproval('non-existent-id', true);
    expect(found).toBe(false);
  });

  // ============================================================
  // 配置关闭
  // ============================================================

  it('7. 配置关闭时直接 approved', async () => {
    const offCoord = new CallOwnerCoordinator({
      enabled: false,
      syncWaitMs: 100,
      persistPath: '/tmp/routedev-test.jsonl',
    });
    const result = await offCoord.requestApproval({ tool: 'test' }, 'always_call');
    expect(result.state).toBe('approved');
    expect(offCoord.loadPendingApprovals()).toHaveLength(0);
  });

  // ============================================================
  // 并发审批
  // ============================================================

  it('8. 多条并发审批互不干扰', async () => {
    const p1 = coordinator.requestApproval({ tool: 'test1' }, 'always_call');
    const p2 = coordinator.requestApproval({ tool: 'test2' }, 'always_call');

    const pending = coordinator.loadPendingApprovals();
    expect(pending).toHaveLength(2);
    expect(pending[0].approvalId).not.toBe(pending[1].approvalId);

    // 响应第一个为 approved，第二个为 denied
    coordinator.respondApproval(pending[0].approvalId, true);
    coordinator.respondApproval(pending[1].approvalId, false);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.state).toBe('approved');
    expect(r2.state).toBe('denied');
  });

  // ============================================================
  // conditional 策略也走 pending 流程
  // ============================================================

  it('conditional 策略创建 pending（与 always_call 行为一致）', async () => {
    const promise = coordinator.requestApproval({ tool: 'test' }, 'conditional', 'ctx-1');
    const pending = coordinator.loadPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].strategy).toBe('conditional');
    expect(pending[0].contextRef).toBe('ctx-1');

    coordinator.respondApproval(pending[0].approvalId, true);
    const result = await promise;
    expect(result.state).toBe('approved');
  });

  // ============================================================
  // 幂等响应
  // ============================================================

  it('对已响应的 approval 再次响应返回 true（幂等）', async () => {
    const promise = coordinator.requestApproval({ tool: 'test' }, 'always_call');
    const pending = coordinator.loadPendingApprovals();
    const id = pending[0].approvalId;

    expect(coordinator.respondApproval(id, true)).toBe(true);
    // 再次响应（已 approved）
    expect(coordinator.respondApproval(id, false)).toBe(true);

    const result = await promise;
    // 第一次响应生效
    expect(result.state).toBe('approved');
  });
});
