// tests/phase37/schedule-engine.test.ts
// Phase 37 Task 2：调度引擎模块测试
// 覆盖：cron 解析、ScheduleStore 持久化、ScheduleEngine 调度、getNextRun

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseCron, getNextRun, validateCron } from '../../src/scheduler/cron-parser.js';
import { ScheduleStore } from '../../src/scheduler/store.js';
import { ScheduleEngine } from '../../src/scheduler/engine.js';
import type { ScheduledTask } from '../../src/scheduler/types.js';

describe('Phase 37 Task 2：调度引擎模块', () => {
  // ============================================================
  // cron 解析器
  // ============================================================
  describe('cron 解析器', () => {
    it('1. * * * * * 每分钟执行', () => {
      const parsed = parseCron('* * * * *');
      // 从 10:30:00 UTC 开始，下一次应为 10:31:00 UTC
      const from = new Date(Date.UTC(2026, 5, 20, 10, 30, 0));
      const next = getNextRun(parsed, from, 0); // offset=0 表示 UTC
      expect(next.toISOString()).toBe('2026-06-20T10:31:00.000Z');
    });

    it('2. */15 * * * * 每 15 分钟', () => {
      const parsed = parseCron('*/15 * * * *');
      // 10:30 是匹配时间，但 from 是 exclusive，所以下一个是 10:45
      const from = new Date(Date.UTC(2026, 5, 20, 10, 30, 0));
      const next = getNextRun(parsed, from, 0);
      expect(next.toISOString()).toBe('2026-06-20T10:45:00.000Z');
    });

    it('3. 0 8 * * * 每天 8 点', () => {
      const parsed = parseCron('0 8 * * *');
      // 今天 8 点已过（当前 10:30），下一个是明天 8 点
      const from = new Date(Date.UTC(2026, 5, 20, 10, 30, 0));
      const next = getNextRun(parsed, from, 0);
      expect(next.toISOString()).toBe('2026-06-21T08:00:00.000Z');
    });

    it('4. 0 0 1 * * 每月 1 号', () => {
      const parsed = parseCron('0 0 1 * *');
      // 6 月 1 号已过，下一个是 7 月 1 号 0 点
      const from = new Date(Date.UTC(2026, 5, 20, 10, 30, 0));
      const next = getNextRun(parsed, from, 0);
      expect(next.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    });

    it('5. 非法表达式应返回 valid=false', () => {
      // 字段数不足（4 个字段）
      expect(validateCron('* * * *').valid).toBe(false);
      // 分钟超出范围（60 > 59）
      expect(validateCron('60 * * * *').valid).toBe(false);
      // 星期超出范围（8 > 7）
      expect(validateCron('* * * * 8').valid).toBe(false);
      // 空字符串
      expect(validateCron('').valid).toBe(false);
      // 字段数过多（6 个字段）
      expect(validateCron('* * * * * *').valid).toBe(false);
    });

    it('组合表达式 1-5,10 解析为 [1,2,3,4,5,10]', () => {
      const parsed = parseCron('1-5,10 * * * *');
      expect(parsed.minute.has(1)).toBe(true);
      expect(parsed.minute.has(3)).toBe(true);
      expect(parsed.minute.has(5)).toBe(true);
      expect(parsed.minute.has(10)).toBe(true);
      expect(parsed.minute.has(6)).toBe(false);
      expect(parsed.minute.has(0)).toBe(false);
    });

    it('步进 */15 解析为 [0, 15, 30, 45]', () => {
      const parsed = parseCron('*/15 * * * *');
      expect(parsed.minute.has(0)).toBe(true);
      expect(parsed.minute.has(15)).toBe(true);
      expect(parsed.minute.has(30)).toBe(true);
      expect(parsed.minute.has(45)).toBe(true);
      expect(parsed.minute.has(5)).toBe(false);
    });

    it('dayOfWeek 7 归一化为 0（周日）', () => {
      const parsed = parseCron('* * * * 7');
      expect(parsed.dayOfWeek.has(0)).toBe(true);
      expect(parsed.dayOfWeek.has(7)).toBe(false);
    });
  });

  // ============================================================
  // ScheduleStore 持久化
  // ============================================================
  describe('ScheduleStore 持久化', () => {
    let tmpDir: string;
    let storePath: string;
    let store: ScheduleStore;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-sched-store-'));
      storePath = path.join(tmpDir, 'tasks.json');
      store = new ScheduleStore(storePath);
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('6. add/load/remove 任务', () => {
      const task: ScheduledTask = {
        id: 'test-1',
        name: '测试任务',
        goal: '测试目标',
        cron: '* * * * *',
        timezone: 'Asia/Shanghai',
        enabled: true,
        runCount: 0,
        notifyOnComplete: false,
        createdAt: Date.now(),
      };

      // add
      store.add(task);

      // load
      const loaded = store.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('test-1');
      expect(loaded[0].name).toBe('测试任务');

      // get
      const got = store.get('test-1');
      expect(got).not.toBeNull();
      expect(got!.name).toBe('测试任务');

      // remove
      const removed = store.remove('test-1');
      expect(removed).toBe(true);
      expect(store.list()).toHaveLength(0);

      // remove 不存在的任务返回 false
      expect(store.remove('nonexistent')).toBe(false);
    });

    it('文件不存在时返回空数组', () => {
      const empty = store.load();
      expect(empty).toEqual([]);
    });

    it('update 任务字段并持久化', () => {
      const task: ScheduledTask = {
        id: 'test-update',
        name: '原名称',
        goal: '目标',
        cron: '* * * * *',
        timezone: 'Asia/Shanghai',
        enabled: true,
        runCount: 0,
        notifyOnComplete: false,
        createdAt: Date.now(),
      };
      store.add(task);

      const updated = store.update('test-update', { name: '新名称', runCount: 5 });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('新名称');
      expect(updated!.runCount).toBe(5);

      // 重新加载验证持久化
      const reloaded = store.get('test-update');
      expect(reloaded!.name).toBe('新名称');
      expect(reloaded!.runCount).toBe(5);
    });
  });

  // ============================================================
  // ScheduleEngine 调度
  // ============================================================
  describe('ScheduleEngine 调度', () => {
    let tmpDir: string;
    let storePath: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-sched-engine-'));
      storePath = path.join(tmpDir, 'tasks.json');
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('7. 到达触发时间时调用 onTaskTrigger', async () => {
      const store = new ScheduleStore(storePath);
      const onTaskTrigger = vi.fn(async (_task: ScheduledTask) => {});

      const engine = new ScheduleEngine({
        store,
        onTaskTrigger,
        checkIntervalMs: 50,
      });

      const task: ScheduledTask = {
        id: 'trigger-test',
        name: '触发测试',
        goal: '测试目标',
        cron: '* * * * *',
        timezone: 'Asia/Shanghai',
        enabled: true,
        nextRun: Date.now() - 1000, // 过去时间，应立即触发
        runCount: 0,
        notifyOnComplete: false,
        createdAt: Date.now(),
      };
      store.add(task);

      engine.start();
      // 等待引擎检查并触发
      await new Promise((resolve) => setTimeout(resolve, 200));
      engine.stop();

      expect(onTaskTrigger).toHaveBeenCalledTimes(1);
      expect(onTaskTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'trigger-test' }),
      );

      // 验证任务已更新
      const updated = store.get('trigger-test');
      expect(updated!.runCount).toBe(1);
      expect(updated!.lastRun).toBeDefined();
      expect(updated!.nextRun).toBeGreaterThan(Date.now() - 60000);
    });

    it('8. maxRuns 达到后自动禁用', async () => {
      const store = new ScheduleStore(storePath);
      const onTaskTrigger = vi.fn(async () => {});

      const engine = new ScheduleEngine({
        store,
        onTaskTrigger,
        checkIntervalMs: 50,
      });

      const task: ScheduledTask = {
        id: 'maxruns-test',
        name: '最大次数测试',
        goal: '测试',
        cron: '* * * * *',
        timezone: 'Asia/Shanghai',
        enabled: true,
        nextRun: Date.now() - 1000,
        runCount: 0,
        maxRuns: 1, // 只执行 1 次后自动禁用
        notifyOnComplete: false,
        createdAt: Date.now(),
      };
      store.add(task);

      engine.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      engine.stop();

      expect(onTaskTrigger).toHaveBeenCalledTimes(1);
      const updated = store.get('maxruns-test');
      expect(updated!.enabled).toBe(false);
      expect(updated!.runCount).toBe(1);
      expect(updated!.nextRun).toBeUndefined();
    });

    it('未启用的任务不会被触发', async () => {
      const store = new ScheduleStore(storePath);
      const onTaskTrigger = vi.fn(async () => {});

      const engine = new ScheduleEngine({
        store,
        onTaskTrigger,
        checkIntervalMs: 50,
      });

      const task: ScheduledTask = {
        id: 'disabled-test',
        name: '禁用测试',
        goal: '测试',
        cron: '* * * * *',
        timezone: 'Asia/Shanghai',
        enabled: false,
        nextRun: Date.now() - 1000,
        runCount: 0,
        notifyOnComplete: false,
        createdAt: Date.now(),
      };
      store.add(task);

      engine.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      engine.stop();

      expect(onTaskTrigger).not.toHaveBeenCalled();
    });

    it('isRunning 反映引擎状态', () => {
      const store = new ScheduleStore(storePath);
      const onTaskTrigger = vi.fn(async () => {});
      const engine = new ScheduleEngine({
        store,
        onTaskTrigger,
        checkIntervalMs: 1000,
      });

      expect(engine.isRunning()).toBe(false);
      engine.start();
      expect(engine.isRunning()).toBe(true);
      engine.stop();
      expect(engine.isRunning()).toBe(false);
    });
  });

  // ============================================================
  // getNextRun 计算下次执行时间
  // ============================================================
  describe('getNextRun 计算下次执行时间', () => {
    it('9. 从 10:30:00 计算下次 */15 执行时间为 10:45', () => {
      const parsed = parseCron('*/15 * * * *');
      const from = new Date(Date.UTC(2026, 5, 20, 10, 30, 0));
      const next = getNextRun(parsed, from, 0);
      expect(next.toISOString()).toBe('2026-06-20T10:45:00.000Z');
    });

    it('从 10:14:59 计算下次 */15 执行时间为 10:15', () => {
      const parsed = parseCron('*/15 * * * *');
      const from = new Date(Date.UTC(2026, 5, 20, 10, 14, 59));
      const next = getNextRun(parsed, from, 0);
      expect(next.toISOString()).toBe('2026-06-20T10:15:00.000Z');
    });

    it('DOM 和 DOW 同时限制时为 OR 关系', () => {
      // 每月 1 号 或 每周日 0 点
      const parsed = parseCron('0 0 1 * 0');
      const from = new Date(Date.UTC(2026, 5, 20, 10, 30, 0)); // 2026-06-20 是周六
      const next = getNextRun(parsed, from, 0);
      // 2026-06-21 是周日，0 点应匹配 DOW
      expect(next.toISOString()).toBe('2026-06-21T00:00:00.000Z');
    });
  });
});
