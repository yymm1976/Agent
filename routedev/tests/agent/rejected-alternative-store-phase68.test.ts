// tests/agent/rejected-alternative-store-phase68.test.ts
// Phase 68 Task 3: RejectedAlternativeStore 测试

import { describe, it, expect } from 'vitest';
import { RejectedAlternativeStore } from '../../src/agent/rejected-alternative-store.js';
import type { RejectedAlternative } from '../../src/agent/rejected-alternative-store.js';

function makeRecord(overrides: Partial<RejectedAlternative> = {}): RejectedAlternative {
  return {
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    proposalSummary: 'use synchronous file reads',
    rejectionReason: 'blocking I/O degrades throughput',
    gate: {
      gateType: 'cross-model-review',
      score: 0.3,
      threshold: 0.7,
    },
    reviewResult: {
      passed: false,
      issues: [{ severity: 'high', description: 'blocking I/O in hot path' }],
      summary: '方案不适合高并发场景',
    },
    taskDescription: 'implement file upload handler',
    relatedFiles: ['src/upload.ts'],
    timestamp: Date.now(),
    sessionId: 'session-001',
    ...overrides,
  };
}

describe('RejectedAlternativeStore', () => {
  describe('add + list 基本读写', () => {
    it('添加记录后 list 可返回', () => {
      const store = new RejectedAlternativeStore();
      const rec = makeRecord();
      store.add(rec);

      const result = store.list();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(rec.id);
    });

    it('list 支持 limit 和 offset', () => {
      const store = new RejectedAlternativeStore();
      for (let i = 0; i < 10; i++) {
        store.add(makeRecord({ id: `rec-${i}` }));
      }

      const page = store.list(3, 4);
      expect(page).toHaveLength(3);
      expect(page[0].id).toBe('rec-4');
    });
  });

  describe('FIFO 淘汰超出 maxRecords', () => {
    it('超过 maxRecords 时最早记录被淘汰', () => {
      const store = new RejectedAlternativeStore(3);
      store.add(makeRecord({ id: 'rec-oldest' }));
      store.add(makeRecord({ id: 'rec-middle' }));
      store.add(makeRecord({ id: 'rec-newest' }));
      store.add(makeRecord({ id: 'rec-extra' }));

      expect(store.size()).toBe(3);
      expect(store.getById('rec-oldest')).toBeUndefined();
      expect(store.getById('rec-extra')).toBeDefined();
    });
  });

  describe('queryByTask 关键词搜索', () => {
    it('命中相关任务描述', () => {
      const store = new RejectedAlternativeStore();
      store.add(makeRecord({ id: 'hit', taskDescription: 'implement file upload handler' }));
      store.add(makeRecord({ id: 'miss', taskDescription: 'refactor database schema' }));

      const results = store.queryByTask('file upload optimization');
      const ids = results.map((r) => r.id);
      expect(ids).toContain('hit');
      expect(ids).not.toContain('miss');
    });

    it('无匹配时返回空数组', () => {
      const store = new RejectedAlternativeStore();
      store.add(makeRecord({ taskDescription: 'implement file upload handler' }));

      const results = store.queryByTask('xyzqw');
      expect(results).toHaveLength(0);
    });

    it('空查询返回空数组', () => {
      const store = new RejectedAlternativeStore();
      store.add(makeRecord());
      expect(store.queryByTask('')).toHaveLength(0);
    });
  });

  describe('queryByTask Jaccard 排序', () => {
    it('更接近的匹配排名更高', () => {
      const store = new RejectedAlternativeStore();
      store.add(makeRecord({ id: 'close', taskDescription: 'implement file upload handler with retry logic' }));
      store.add(makeRecord({ id: 'loose', taskDescription: 'implement handler for database migration' }));

      const results = store.queryByTask('implement file upload handler');
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].id).toBe('close');
    });
  });

  describe('filterByGate 门类型过滤', () => {
    it('按 gateType 过滤', () => {
      const store = new RejectedAlternativeStore();
      store.add(makeRecord({ id: 'cmr', gate: { gateType: 'cross-model-review', score: 0.3, threshold: 0.7 } }));
      store.add(makeRecord({ id: 'qg', gate: { gateType: 'quantitative-gate', score: 0.5, threshold: 0.8 } }));
      store.add(makeRecord({ id: 'ur', gate: { gateType: 'user-reject' } }));

      const cmrResults = store.filterByGate('cross-model-review');
      expect(cmrResults).toHaveLength(1);
      expect(cmrResults[0].id).toBe('cmr');

      const urResults = store.filterByGate('user-reject');
      expect(urResults).toHaveLength(1);
      expect(urResults[0].id).toBe('ur');
    });
  });

  describe('serialize + deserialize 往返一致性', () => {
    it('序列化后反序列化恢复所有记录', () => {
      const store = new RejectedAlternativeStore();
      store.add(makeRecord({ id: 's1', taskDescription: 'alpha task' }));
      store.add(makeRecord({ id: 's2', taskDescription: 'beta task' }));

      const data = store.serialize();
      const store2 = new RejectedAlternativeStore();
      store2.deserialize(data);

      expect(store2.size()).toBe(2);
      expect(store2.getById('s1')?.taskDescription).toBe('alpha task');
      expect(store2.getById('s2')?.taskDescription).toBe('beta task');
    });
  });

  describe('size 返回正确计数', () => {
    it('空 store size 为 0', () => {
      expect(new RejectedAlternativeStore().size()).toBe(0);
    });

    it('add 后 size 递增', () => {
      const store = new RejectedAlternativeStore();
      store.add(makeRecord());
      expect(store.size()).toBe(1);
      store.add(makeRecord());
      expect(store.size()).toBe(2);
    });
  });

  describe('getById 返回正确记录', () => {
    it('查找存在的 id', () => {
      const store = new RejectedAlternativeStore();
      const rec = makeRecord({ id: 'find-me' });
      store.add(rec);
      expect(store.getById('find-me')?.id).toBe('find-me');
    });

    it('查找不存在的 id 返回 undefined', () => {
      const store = new RejectedAlternativeStore();
      store.add(makeRecord({ id: 'exists' }));
      expect(store.getById('not-exists')).toBeUndefined();
    });
  });

  describe('deserialize 容错处理损坏数据', () => {
    it('跳过损坏行，恢复有效记录', () => {
      const valid = makeRecord({ id: 'valid-line' });
      const corrupted = '{ this is not valid json !!!';
      const data = [JSON.stringify(valid), corrupted, ''].join('\n');

      const store = new RejectedAlternativeStore();
      store.deserialize(data);

      expect(store.size()).toBe(1);
      expect(store.getById('valid-line')).toBeDefined();
    });
  });
});
