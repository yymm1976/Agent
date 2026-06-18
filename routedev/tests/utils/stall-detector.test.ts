// tests/utils/stall-detector.test.ts
// StallDetector 单元测试

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StallDetector } from '../../src/utils/stall-detector.js';

describe('StallDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('超时后触发 onStall 回调', () => {
    const onStall = vi.fn();
    const detector = new StallDetector({
      stallTimeoutMs: 1000,
      checkIntervalMs: 200,
      onStall,
    });

    detector.register(1234);
    detector.start();

    // 推进时间超过 stallTimeoutMs，触发定期检测
    vi.advanceTimersByTime(1500);

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith(1234);

    detector.stop();
  });

  it('持续有输出时不触发 onStall', () => {
    const onStall = vi.fn();
    const detector = new StallDetector({
      stallTimeoutMs: 1000,
      checkIntervalMs: 200,
      onStall,
    });

    detector.register(1234);
    detector.start();

    // 每 500ms 报告一次活动，总共推进 2000ms
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(500);
      detector.reportActivity(1234);
    }

    expect(onStall).not.toHaveBeenCalled();
    detector.stop();
  });

  it('unregister 后不再检测', () => {
    const onStall = vi.fn();
    const detector = new StallDetector({
      stallTimeoutMs: 1000,
      checkIntervalMs: 200,
      onStall,
    });

    detector.register(1234);
    detector.start();
    detector.unregister(1234);

    vi.advanceTimersByTime(1500);

    expect(onStall).not.toHaveBeenCalled();
    detector.stop();
  });

  it('start/stop 正确管理定时器', () => {
    const onStall = vi.fn();
    const detector = new StallDetector({
      stallTimeoutMs: 1000,
      checkIntervalMs: 200,
      onStall,
    });

    detector.register(1234);
    detector.start();
    detector.stop();

    // stop 后再推进时间不应触发回调
    vi.advanceTimersByTime(2000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('可以监控多个进程', () => {
    const onStall = vi.fn();
    const detector = new StallDetector({
      stallTimeoutMs: 1000,
      checkIntervalMs: 200,
      onStall,
    });

    detector.register(100);
    detector.register(200);
    detector.start();

    vi.advanceTimersByTime(1500);

    expect(onStall).toHaveBeenCalledTimes(2);
    const pids = onStall.mock.calls.map(c => c[0]).sort();
    expect(pids).toEqual([100, 200]);

    detector.stop();
  });

  it('触发 onStall 后该进程被移除，不再重复触发', () => {
    const onStall = vi.fn();
    const detector = new StallDetector({
      stallTimeoutMs: 1000,
      checkIntervalMs: 200,
      onStall,
    });

    detector.register(1234);
    detector.start();

    vi.advanceTimersByTime(1500);
    expect(onStall).toHaveBeenCalledTimes(1);

    // 再推进一个周期，不应再次触发
    vi.advanceTimersByTime(1500);
    expect(onStall).toHaveBeenCalledTimes(1);

    detector.stop();
  });

  it('reportActivity 重置超时计时', () => {
    const onStall = vi.fn();
    const detector = new StallDetector({
      stallTimeoutMs: 1000,
      checkIntervalMs: 200,
      onStall,
    });

    detector.register(1234);
    detector.start();

    // 推进 800ms（接近但未超时）
    vi.advanceTimersByTime(800);
    expect(onStall).not.toHaveBeenCalled();

    // 报告活动，重置计时
    detector.reportActivity(1234);

    // 再推进 800ms（若未重置则会超时）
    vi.advanceTimersByTime(800);
    expect(onStall).not.toHaveBeenCalled();

    // 推进到超过新的超时点
    vi.advanceTimersByTime(400);
    expect(onStall).toHaveBeenCalledTimes(1);

    detector.stop();
  });
});
