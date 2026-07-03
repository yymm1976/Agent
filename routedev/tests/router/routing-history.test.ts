// tests/router/routing-history.test.ts
// RoutingHistory 路由历史记录与持久化测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RoutingHistory } from '../../src/router/routing-history.js';
import type { RoutingRecord } from '../../src/router/routing-history.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function makeRecord(overrides: Partial<RoutingRecord> = {}): RoutingRecord {
  return {
    taskSignature: 'default-task',
    modelId: 'gpt-4o',
    qualityScore: 0.8,
    tokenCost: 1200,
    latencyMs: 350,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('RoutingHistory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-history-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  describe('append + FIFO淘汰', () => {
    it('should append records and return correct count', () => {
      const history = new RoutingHistory({ maxRecords: 10 });
      history.append(makeRecord({ modelId: 'm1' }));
      history.append(makeRecord({ modelId: 'm2' }));
      history.append(makeRecord({ modelId: 'm3' }));

      expect(history.getRecordCount()).toBe(3);
    });

    it('should evict oldest records when maxRecords is exceeded (FIFO)', () => {
      const history = new RoutingHistory({ maxRecords: 3 });

      history.append(makeRecord({ modelId: 'old-1', timestamp: 1000 }));
      history.append(makeRecord({ modelId: 'old-2', timestamp: 2000 }));
      history.append(makeRecord({ modelId: 'old-3', timestamp: 3000 }));
      history.append(makeRecord({ modelId: 'new-1', timestamp: 4000 }));

      expect(history.getRecordCount()).toBe(3);
      const modelIds = history.getRecords().map(r => r.modelId);
      expect(modelIds).toEqual(['old-2', 'old-3', 'new-1']);
    });

    it('should keep only the latest maxRecords after many appends', () => {
      const max = 5;
      const history = new RoutingHistory({ maxRecords: max });

      for (let i = 0; i < 20; i++) {
        history.append(makeRecord({ modelId: `model-${i}`, timestamp: i * 100 }));
      }

      expect(history.getRecordCount()).toBe(max);
      const records = history.getRecords();
      expect(records[0]!.modelId).toBe('model-15');
      expect(records[max - 1]!.modelId).toBe('model-19');
    });
  });

  describe('getStatsByModel 聚合正确性', () => {
    it('should aggregate stats correctly for multiple models', () => {
      const history = new RoutingHistory();

      history.append(makeRecord({ modelId: 'm1', qualityScore: 0.8, tokenCost: 100, latencyMs: 200 }));
      history.append(makeRecord({ modelId: 'm1', qualityScore: 0.6, tokenCost: 300, latencyMs: 400 }));
      history.append(makeRecord({ modelId: 'm2', qualityScore: 0.9, tokenCost: 500, latencyMs: 100 }));

      const stats = history.getStatsByModel();

      expect(stats.size).toBe(2);

      const m1 = stats.get('m1')!;
      expect(m1.avgQuality).toBeCloseTo(0.7, 5);
      expect(m1.avgCost).toBeCloseTo(200, 5);
      expect(m1.avgLatency).toBeCloseTo(300, 5);
      expect(m1.sampleCount).toBe(2);

      const m2 = stats.get('m2')!;
      expect(m2.avgQuality).toBeCloseTo(0.9, 5);
      expect(m2.avgCost).toBeCloseTo(500, 5);
      expect(m2.avgLatency).toBeCloseTo(100, 5);
      expect(m2.sampleCount).toBe(1);
    });

    it('should skip undefined metric values in aggregation', () => {
      const history = new RoutingHistory();
      history.append(makeRecord({ modelId: 'm1', qualityScore: 0.9 }));
      history.append(makeRecord({ modelId: 'm1', tokenCost: 400, qualityScore: undefined }));

      const stats = history.getStatsByModel();
      const m1 = stats.get('m1')!;
      // qualityScore 只有一条有效记录 0.9，avgQuality = 0.9
      expect(m1.avgQuality).toBeCloseTo(0.9, 5);
      expect(m1.sampleCount).toBe(2);
    });

    it('should use default 0.5 for avgQuality when no quality scores exist', () => {
      const history = new RoutingHistory();
      history.append(makeRecord({ modelId: 'm1', qualityScore: undefined, tokenCost: 100, latencyMs: 200 }));

      const stats = history.getStatsByModel();
      const m1 = stats.get('m1')!;
      expect(m1.avgQuality).toBe(0.5);
    });
  });

  describe('flush + load 往返一致性', () => {
    it('should persist records to JSONL and load them back', async () => {
      const filePath = path.join(tmpDir, 'history.jsonl');
      const history = new RoutingHistory({ persistPath: filePath });

      const records: RoutingRecord[] = [
        makeRecord({ modelId: 'm1', taskSignature: 'sig-a', timestamp: 1000 }),
        makeRecord({ modelId: 'm2', taskSignature: 'sig-b', timestamp: 2000 }),
        makeRecord({ modelId: 'm3', taskSignature: 'sig-c', timestamp: 3000 }),
      ];
      for (const r of records) history.append(r);

      await history.flush();

      const loaded = new RoutingHistory({ persistPath: filePath });
      await loaded.load();

      expect(loaded.getRecordCount()).toBe(3);
      const loadedRecords = loaded.getRecords() as RoutingRecord[];
      expect(loadedRecords[0]!.modelId).toBe('m1');
      expect(loadedRecords[0]!.taskSignature).toBe('sig-a');
      expect(loadedRecords[2]!.modelId).toBe('m3');
      expect(loadedRecords[2]!.taskSignature).toBe('sig-c');
    });

    it('should respect maxRecords on load (truncate to latest N)', async () => {
      const filePath = path.join(tmpDir, 'history-trunc.jsonl');
      const writer = new RoutingHistory({ persistPath: filePath });

      for (let i = 0; i < 10; i++) {
        writer.append(makeRecord({ modelId: `m-${i}`, timestamp: i * 100 }));
      }
      await writer.flush();

      const reader = new RoutingHistory({ persistPath: filePath, maxRecords: 5 });
      await reader.load();

      expect(reader.getRecordCount()).toBe(5);
      const ids = reader.getRecords().map(r => r.modelId);
      expect(ids[0]).toBe('m-5');
      expect(ids[4]).toBe('m-9');
    });

    it('should handle flushAppend for incremental writes', async () => {
      const filePath = path.join(tmpDir, 'history-append.jsonl');

      const history1 = new RoutingHistory({ persistPath: filePath });
      history1.append(makeRecord({ modelId: 'batch-1' }));
      await history1.flush();

      const history2 = new RoutingHistory({ persistPath: filePath });
      history2.append(makeRecord({ modelId: 'batch-2' }));
      await history2.flushAppend(history2.getRecords() as RoutingRecord[]);

      const reader = new RoutingHistory({ persistPath: filePath });
      await reader.load();

      expect(reader.getRecordCount()).toBe(2);
      expect(reader.getRecords()[0]!.modelId).toBe('batch-1');
      expect(reader.getRecords()[1]!.modelId).toBe('batch-2');
    });
  });

  describe('空记录降级', () => {
    it('should return empty array from getRecords when no records exist', () => {
      const history = new RoutingHistory();
      expect(history.getRecords()).toEqual([]);
    });

    it('should return 0 from getRecordCount when no records exist', () => {
      const history = new RoutingHistory();
      expect(history.getRecordCount()).toBe(0);
    });

    it('should return empty map from getStatsByModel when no records exist', () => {
      const history = new RoutingHistory();
      const stats = history.getStatsByModel();
      expect(stats.size).toBe(0);
    });

    it('should return empty array from findByTaskSignature when no records exist', () => {
      const history = new RoutingHistory();
      expect(history.findByTaskSignature('nonexistent')).toEqual([]);
    });

    it('should return empty array from findByModel when no records exist', () => {
      const history = new RoutingHistory();
      expect(history.findByModel('nonexistent')).toEqual([]);
    });

    it('should gracefully handle load from non-existent file', async () => {
      const filePath = path.join(tmpDir, 'does-not-exist', 'history.jsonl');
      const history = new RoutingHistory({ persistPath: filePath });
      await history.load();
      expect(history.getRecordCount()).toBe(0);
    });
  });

  describe('findByTaskSignature', () => {
    it('should return records matching the given task signature', () => {
      const history = new RoutingHistory();
      history.append(makeRecord({ taskSignature: 'refactor', modelId: 'm1' }));
      history.append(makeRecord({ taskSignature: 'debug', modelId: 'm2' }));
      history.append(makeRecord({ taskSignature: 'refactor', modelId: 'm3' }));
      history.append(makeRecord({ taskSignature: 'test', modelId: 'm4' }));

      const results = history.findByTaskSignature('refactor');
      expect(results.length).toBe(2);
      expect(results[0]!.modelId).toBe('m1');
      expect(results[1]!.modelId).toBe('m3');
    });

    it('should return empty array when no records match', () => {
      const history = new RoutingHistory();
      history.append(makeRecord({ taskSignature: 'debug' }));
      expect(history.findByTaskSignature('deploy')).toEqual([]);
    });
  });

  describe('findByModel', () => {
    it('should return records matching the given model ID', () => {
      const history = new RoutingHistory();
      history.append(makeRecord({ modelId: 'gpt-4o', taskSignature: 'task-1' }));
      history.append(makeRecord({ modelId: 'claude-3', taskSignature: 'task-2' }));
      history.append(makeRecord({ modelId: 'gpt-4o', taskSignature: 'task-3' }));

      const results = history.findByModel('gpt-4o');
      expect(results.length).toBe(2);
      expect(results[0]!.taskSignature).toBe('task-1');
      expect(results[1]!.taskSignature).toBe('task-3');
    });

    it('should return empty array when no records match the model', () => {
      const history = new RoutingHistory();
      history.append(makeRecord({ modelId: 'gpt-4o' }));
      expect(history.findByModel('gemini-pro')).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should remove all records', () => {
      const history = new RoutingHistory();
      history.append(makeRecord());
      history.append(makeRecord());
      history.append(makeRecord());
      expect(history.getRecordCount()).toBe(3);

      history.clear();
      expect(history.getRecordCount()).toBe(0);
      expect(history.getRecords()).toEqual([]);
    });
  });
});
