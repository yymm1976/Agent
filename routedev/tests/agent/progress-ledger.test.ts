// tests/agent/progress-ledger.test.ts
// Phase 75-B2：Durable Progress Ledger 单元测试
//
// 覆盖场景：
//   1. appendProgress + readProgress 往返一致性
//   2. getTaskStatus 返回最新状态（同 task 多条取最后）
//   3. listCompletedTasks 去重 + 顺序
//   4. getNextTaskToRun 跳过已完成
//   5. diagnoseLedger 统计正确
//   6. 文件不存在时 readProgress 返回 []
//   7. append-only 验证（多次 append 不覆盖）
//
// 测试隔离：每个用例通过 ROUTEDEV_LEDGER_PATH 环境变量指向临时目录中的独立 ledger 文件，
// 测试后清理临时目录，不污染工作区。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  appendProgress,
  readProgress,
  getTaskStatus,
  listCompletedTasks,
  getNextTaskToRun,
  diagnoseLedger,
  getLedgerPath,
  type ProgressEntry,
} from '../../src/agent/progress-ledger.js';

// ============================================================
// 辅助
// ============================================================

/** 创建一个临时目录，返回路径 */
function makeTmpDir(prefix = 'routedev-ledger-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 构造一条 ProgressEntry（带默认值） */
function makeEntry(overrides: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    taskId: 'task-1',
    status: 'complete',
    timestamp: new Date('2026-07-07T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

// ============================================================
// 测试套件
// ============================================================

describe('ProgressLedger (Phase 75-B2)', () => {
  let tempDir: string;
  let ledgerPath: string;
  const prevEnv = process.env.ROUTEDEV_LEDGER_PATH;

  beforeEach(() => {
    tempDir = makeTmpDir();
    ledgerPath = join(tempDir, 'progress.jsonl');
    process.env.ROUTEDEV_LEDGER_PATH = ledgerPath;
  });

  afterEach(async () => {
    // 还原环境变量
    if (prevEnv === undefined) {
      delete process.env.ROUTEDEV_LEDGER_PATH;
    } else {
      process.env.ROUTEDEV_LEDGER_PATH = prevEnv;
    }
    // 清理临时目录
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  // ----------------------------------------------------------
  // 1. appendProgress + readProgress 往返一致性
  // ----------------------------------------------------------
  describe('append + read 往返一致性', () => {
    it('单条 append 后 read 应返回同一条目', async () => {
      const entry = makeEntry({
        taskId: 'task-1',
        status: 'complete',
        commitSha: 'abc1234',
        reviewVerdict: 'clean',
      });
      await appendProgress(entry);
      const result = await readProgress();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(entry);
    });

    it('多条不同 task 的 append 后 read 应保持追加顺序', async () => {
      const e1 = makeEntry({ taskId: 'task-1', timestamp: '2026-07-07T00:00:00.000Z' });
      const e2 = makeEntry({ taskId: 'task-2', timestamp: '2026-07-07T01:00:00.000Z' });
      const e3 = makeEntry({ taskId: 'task-3', timestamp: '2026-07-07T02:00:00.000Z' });
      await appendProgress(e1);
      await appendProgress(e2);
      await appendProgress(e3);
      const result = await readProgress();
      expect(result).toHaveLength(3);
      expect(result[0].taskId).toBe('task-1');
      expect(result[1].taskId).toBe('task-2');
      expect(result[2].taskId).toBe('task-3');
    });

    it('完整的 ProgressEntry 字段应被保留', async () => {
      const entry: ProgressEntry = {
        taskId: '75-B2',
        status: 'complete',
        commitSha: 'deadbeef',
        commitRange: { base: 'abc0000', head: 'def1111' },
        reviewVerdict: 'fix-applied',
        timestamp: '2026-07-07T03:04:05.000Z',
        notes: 'review pass after fix',
      };
      await appendProgress(entry);
      const result = await readProgress();
      expect(result[0]).toEqual(entry);
    });
  });

  // ----------------------------------------------------------
  // 2. getTaskStatus 返回最新状态
  // ----------------------------------------------------------
  describe('getTaskStatus', () => {
    it('同 task 多条记录时返回最后一条', async () => {
      await appendProgress(makeEntry({ taskId: 'task-X', status: 'failed', timestamp: '2026-07-07T00:00:00.000Z' }));
      await appendProgress(makeEntry({ taskId: 'task-X', status: 'blocked', timestamp: '2026-07-07T01:00:00.000Z' }));
      await appendProgress(makeEntry({ taskId: 'task-X', status: 'complete', timestamp: '2026-07-07T02:00:00.000Z' }));
      const latest = await getTaskStatus('task-X');
      expect(latest).not.toBeNull();
      expect(latest!.status).toBe('complete');
      expect(latest!.timestamp).toBe('2026-07-07T02:00:00.000Z');
    });

    it('不存在的 task 返回 null', async () => {
      await appendProgress(makeEntry({ taskId: 'task-1' }));
      const result = await getTaskStatus('nonexistent');
      expect(result).toBeNull();
    });

    it('空 ledger 时返回 null', async () => {
      const result = await getTaskStatus('task-1');
      expect(result).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // 3. listCompletedTasks 去重 + 顺序
  // ----------------------------------------------------------
  describe('listCompletedTasks', () => {
    it('仅返回 status=complete 的 task ID', async () => {
      await appendProgress(makeEntry({ taskId: 'task-1', status: 'complete' }));
      await appendProgress(makeEntry({ taskId: 'task-2', status: 'failed' }));
      await appendProgress(makeEntry({ taskId: 'task-3', status: 'blocked' }));
      await appendProgress(makeEntry({ taskId: 'task-4', status: 'complete' }));
      const result = await listCompletedTasks();
      expect(result).toEqual(['task-1', 'task-4']);
    });

    it('同一 task 多次 complete 仅出现一次（去重）', async () => {
      await appendProgress(makeEntry({ taskId: 'task-1', status: 'complete', timestamp: '2026-07-07T00:00:00.000Z' }));
      await appendProgress(makeEntry({ taskId: 'task-1', status: 'failed', timestamp: '2026-07-07T01:00:00.000Z' }));
      await appendProgress(makeEntry({ taskId: 'task-1', status: 'complete', timestamp: '2026-07-07T02:00:00.000Z' }));
      const result = await listCompletedTasks();
      expect(result).toEqual(['task-1']);
    });

    it('保留首次完成的顺序', async () => {
      await appendProgress(makeEntry({ taskId: 'task-C', status: 'complete' }));
      await appendProgress(makeEntry({ taskId: 'task-A', status: 'complete' }));
      await appendProgress(makeEntry({ taskId: 'task-B', status: 'complete' }));
      const result = await listCompletedTasks();
      expect(result).toEqual(['task-C', 'task-A', 'task-B']);
    });

    it('空 ledger 返回空数组', async () => {
      const result = await listCompletedTasks();
      expect(result).toEqual([]);
    });
  });

  // ----------------------------------------------------------
  // 4. getNextTaskToRun 跳过已完成
  // ----------------------------------------------------------
  describe('getNextTaskToRun', () => {
    it('返回第一个未完成的 task', async () => {
      await appendProgress(makeEntry({ taskId: 'task-1', status: 'complete' }));
      await appendProgress(makeEntry({ taskId: 'task-2', status: 'complete' }));
      const plan = ['task-1', 'task-2', 'task-3', 'task-4'];
      const next = await getNextTaskToRun(plan);
      expect(next).toBe('task-3');
    });

    it('中间有 failed 的 task 不算完成，会被选中', async () => {
      await appendProgress(makeEntry({ taskId: 'task-1', status: 'complete' }));
      await appendProgress(makeEntry({ taskId: 'task-2', status: 'failed' }));
      const plan = ['task-1', 'task-2', 'task-3'];
      const next = await getNextTaskToRun(plan);
      // task-2 failed 不在 completed 集合中，应被重新选中
      expect(next).toBe('task-2');
    });

    it('全部完成时返回 null', async () => {
      await appendProgress(makeEntry({ taskId: 'task-1', status: 'complete' }));
      await appendProgress(makeEntry({ taskId: 'task-2', status: 'complete' }));
      const plan = ['task-1', 'task-2'];
      const next = await getNextTaskToRun(plan);
      expect(next).toBeNull();
    });

    it('空计划返回 null', async () => {
      const next = await getNextTaskToRun([]);
      expect(next).toBeNull();
    });

    it('空 ledger 时返回计划的第一个 task', async () => {
      const plan = ['task-1', 'task-2'];
      const next = await getNextTaskToRun(plan);
      expect(next).toBe('task-1');
    });
  });

  // ----------------------------------------------------------
  // 5. diagnoseLedger 统计正确
  // ----------------------------------------------------------
  describe('diagnoseLedger', () => {
    it('统计 complete / failed / blocked 数量正确', async () => {
      await appendProgress(makeEntry({ taskId: 'task-1', status: 'complete' }));
      await appendProgress(makeEntry({ taskId: 'task-2', status: 'complete' }));
      await appendProgress(makeEntry({ taskId: 'task-3', status: 'failed' }));
      await appendProgress(makeEntry({ taskId: 'task-4', status: 'blocked' }));
      const diag = await diagnoseLedger();
      expect(diag.totalEntries).toBe(4);
      expect(diag.completedTasks).toBe(2);
      expect(diag.failedTasks).toBe(1);
      expect(diag.blockedTasks).toBe(1);
    });

    it('lastEntry 应为最后追加的条目', async () => {
      const last = makeEntry({ taskId: 'task-last', status: 'complete', timestamp: '2026-07-07T09:00:00.000Z' });
      await appendProgress(makeEntry({ taskId: 'task-1', status: 'complete', timestamp: '2026-07-07T00:00:00.000Z' }));
      await appendProgress(last);
      const diag = await diagnoseLedger();
      expect(diag.lastEntry).toEqual(last);
    });

    it('空 ledger 时 totalEntries=0 且 lastEntry 未定义', async () => {
      const diag = await diagnoseLedger();
      expect(diag.totalEntries).toBe(0);
      expect(diag.completedTasks).toBe(0);
      expect(diag.failedTasks).toBe(0);
      expect(diag.blockedTasks).toBe(0);
      expect(diag.lastEntry).toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  // 6. 文件不存在时 readProgress 返回 []
  // ----------------------------------------------------------
  describe('文件不存在时的容错', () => {
    it('readProgress 在 ledger 文件不存在时返回空数组（不抛错）', async () => {
      const result = await readProgress();
      expect(result).toEqual([]);
    });

    it('getTaskStatus 在 ledger 不存在时返回 null', async () => {
      const result = await getTaskStatus('task-1');
      expect(result).toBeNull();
    });

    it('listCompletedTasks 在 ledger 不存在时返回空数组', async () => {
      const result = await listCompletedTasks();
      expect(result).toEqual([]);
    });

    it('diagnoseLedger 在 ledger 不存在时返回零值统计', async () => {
      const diag = await diagnoseLedger();
      expect(diag.totalEntries).toBe(0);
      expect(diag.lastEntry).toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  // 7. append-only 验证（多次 append 不覆盖）
  // ----------------------------------------------------------
  describe('append-only 语义', () => {
    it('多次 append 后文件包含所有行，不覆盖', async () => {
      const entries = [
        makeEntry({ taskId: 'task-1', status: 'complete', timestamp: '2026-07-07T00:00:00.000Z' }),
        makeEntry({ taskId: 'task-2', status: 'complete', timestamp: '2026-07-07T01:00:00.000Z' }),
        makeEntry({ taskId: 'task-3', status: 'failed', timestamp: '2026-07-07T02:00:00.000Z' }),
        makeEntry({ taskId: 'task-4', status: 'blocked', timestamp: '2026-07-07T03:00:00.000Z' }),
        makeEntry({ taskId: 'task-5', status: 'complete', timestamp: '2026-07-07T04:00:00.000Z' }),
      ];
      for (const e of entries) {
        await appendProgress(e);
      }
      // 直接读文件验证行数
      const fileContent = readFileSync(ledgerPath, 'utf-8');
      const lines = fileContent.split('\n').filter((l) => l.trim());
      expect(lines.length).toBe(5);
      // 每行都是有效 JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      // 通过 API 读回应一致
      const result = await readProgress();
      expect(result).toHaveLength(5);
      expect(result).toEqual(entries);
    });

    it('append 同一 task 多次不覆盖早期记录', async () => {
      await appendProgress(makeEntry({ taskId: 'task-X', status: 'failed', timestamp: '2026-07-07T00:00:00.000Z', notes: 'first attempt' }));
      await appendProgress(makeEntry({ taskId: 'task-X', status: 'complete', timestamp: '2026-07-07T01:00:00.000Z', notes: 'second attempt' }));
      const result = await readProgress();
      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('failed');
      expect(result[0].notes).toBe('first attempt');
      expect(result[1].status).toBe('complete');
      expect(result[1].notes).toBe('second attempt');
    });

    it('append 后文件确实存在', async () => {
      expect(existsSync(ledgerPath)).toBe(false);
      await appendProgress(makeEntry({ taskId: 'task-1', status: 'complete' }));
      expect(existsSync(ledgerPath)).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 补充：getLedgerPath 路径解析
  // ----------------------------------------------------------
  describe('getLedgerPath', () => {
    it('环境变量优先于默认路径', () => {
      const expected = join(tempDir, 'custom-ledger.jsonl');
      process.env.ROUTEDEV_LEDGER_PATH = expected;
      expect(getLedgerPath()).toBe(expected);
    });

    it('未设置环境变量时使用 cwd 下的默认路径', () => {
      delete process.env.ROUTEDEV_LEDGER_PATH;
      const p = getLedgerPath('/some/cwd');
      expect(p).toBe(resolve('/some/cwd', '.routedev', 'progress.jsonl'));
    });

    it('空白环境变量回退到默认路径', () => {
      process.env.ROUTEDEV_LEDGER_PATH = '   ';
      const p = getLedgerPath('/another/cwd');
      expect(p).toBe(resolve('/another/cwd', '.routedev', 'progress.jsonl'));
    });
  });

  // ----------------------------------------------------------
  // 补充：损坏行容错
  // ----------------------------------------------------------
  describe('损坏行容错', () => {
    it('单行 JSON 损坏时跳过该行，保留其余有效条目', async () => {
      await appendProgress(makeEntry({ taskId: 'task-1', status: 'complete' }));
      // 手动追加一行损坏的 JSON
      const { appendFileSync } = await import('node:fs');
      appendFileSync(ledgerPath, '{invalid json\n', 'utf-8');
      await appendProgress(makeEntry({ taskId: 'task-2', status: 'complete' }));
      const result = await readProgress();
      // 损坏行被跳过，两条有效记录保留
      expect(result).toHaveLength(2);
      expect(result[0].taskId).toBe('task-1');
      expect(result[1].taskId).toBe('task-2');
    });
  });
});
