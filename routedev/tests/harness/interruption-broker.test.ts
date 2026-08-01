// tests/harness/interruption-broker.test.ts
// Phase 97 Part C：InterruptionBroker 全局中断队列测试
//
// 覆盖验收标准：
//   1. submit / resolve 正常流转，解析回调收到批准结果
//   2. reject 显式拒绝并携带原因
//   3. abortSession 批量拒绝该会话所有未处理中断，Promise 不悬挂
//   4. reclaim 只返回 pending 中断（渲染层重载恢复场景）
//   5. 超时未处理自动按拒绝处理

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InterruptionBroker } from '../../src/agent/interruption-broker.js';

describe('interruption-broker（全局中断队列）', () => {
  let broker: InterruptionBroker;

  beforeEach(() => {
    broker = new InterruptionBroker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('submit 后 pending 中断可被 list 查询', () => {
    const id = broker.submit('permission_request', 'sess-1', { toolName: 'file_write', reason: '写入文件' }, () => {});
    const list = broker.list('sess-1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].kind).toBe('permission_request');
    expect(list[0].status).toBe('pending');
  });

  it('resolve 解析中断并通知回调（批准）', () => {
    const resolver = vi.fn();
    const id = broker.submit('ask_user', 'sess-1', { question: '是否继续？' }, resolver);
    const ok = broker.resolve(id, { approved: true });
    expect(ok).toBe(true);
    expect(resolver).toHaveBeenCalledWith({ approved: true });
    expect(broker.size).toBe(0);
  });

  it('reject 显式拒绝并携带原因', () => {
    const resolver = vi.fn();
    const id = broker.submit('permission_request', 'sess-1', { toolName: 'shell_exec' }, resolver);
    const ok = broker.reject(id, '用户拒绝');
    expect(ok).toBe(true);
    expect(resolver).toHaveBeenCalledWith({ approved: false, payload: '用户拒绝' });
  });

  it('abortSession 批量拒绝该会话所有未处理中断', () => {
    const r1 = vi.fn();
    const r2 = vi.fn();
    broker.submit('permission_request', 'sess-1', { toolName: 'a' }, r1);
    broker.submit('permission_request', 'sess-1', { toolName: 'b' }, r2);
    broker.submit('permission_request', 'sess-2', { toolName: 'c' }, () => {});
    const count = broker.abortSession('sess-1');
    expect(count).toBe(2);
    expect(r1).toHaveBeenCalledWith({ approved: false });
    expect(r2).toHaveBeenCalledWith({ approved: false });
    // 其他会话不受影响
    expect(broker.list('sess-2')).toHaveLength(1);
  });

  it('reclaim 只返回 pending 中断（渲染层重载恢复）', () => {
    broker.submit('permission_request', 'sess-1', { toolName: 'a' }, () => {});
    const resolvedId = broker.submit('permission_request', 'sess-1', { toolName: 'b' }, () => {});
    broker.resolve(resolvedId, { approved: true });
    const reclaimed = broker.reclaim('sess-1');
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].status).toBe('pending');
  });

  it('超时未处理自动按拒绝处理', () => {
    const resolver = vi.fn();
    broker.submit('permission_request', 'sess-1', { toolName: 'a' }, resolver);
    vi.advanceTimersByTime(61_000);
    expect(resolver).toHaveBeenCalledWith({ approved: false });
    expect(broker.size).toBe(0);
  });

  it('resolve 不存在的 id 返回 false 且不抛错', () => {
    expect(broker.resolve('not-exist', { approved: true })).toBe(false);
  });
});
