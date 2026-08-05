import { describe, expect, it } from 'vitest';
import { AgentRunScheduler } from '../../src/agent/run-scheduler.js';

describe('AgentRunScheduler', () => {
  it('runs complete agent lifecycles in FIFO order', async () => {
    const scheduler = new AgentRunScheduler(4, 5_000);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = scheduler.enqueue('first', async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = scheduler.enqueue('second', async () => {
      order.push('second:start');
    });

    await Promise.resolve();
    expect(scheduler.getState('first')?.state).toBe('running');
    expect(scheduler.getState('second')?.state).toBe('queued');
    expect(order).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    expect(scheduler.getState('second')?.state).toBe('completed');
  });

  it('cancels queued work without invoking it', async () => {
    const scheduler = new AgentRunScheduler(4, 5_000);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondRan = false;

    const first = scheduler.enqueue('first', async () => firstGate);
    const second = scheduler.enqueue('second', async () => { secondRan = true; });
    expect(scheduler.cancel('second')).toBe(true);
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduler.getState('second')?.state).toBe('cancelled');

    releaseFirst();
    await first;
    expect(secondRan).toBe(false);
  });
});
