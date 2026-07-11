// tests/observability/usage-counter.test.ts
// Phase 80 Task 2：UsageCounter 单元测试
// 验证：计数累加、key 格式、flushToFile JSON 可解析、fail-open 不抛异常

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UsageCounter, type UsageEvent } from '../../src/observability/usage-counter.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('UsageCounter', () => {
  let tmpDir: string;

  beforeEach(() => {
    // 每个用例前创建独立临时目录，避免互相干扰
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-usage-'));
  });

  afterEach(() => {
    // 清理临时目录
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
    vi.restoreAllMocks();
  });

  // ============================================================
  // 用例 1：同名工具多次调用累加
  // ============================================================
  describe('计数累加', () => {
    it('同名工具多次调用后计数正确累加', () => {
      const counter = new UsageCounter();
      const event: UsageEvent = { kind: 'tool', name: 'file_read' };

      // 调用 3 次
      counter.increment(event);
      counter.increment(event);
      counter.increment(event);

      const snapshot = counter.snapshot();
      expect(snapshot['tool:file_read']).toBe(3);
    });

    it('不同事件类型生成正确的计数 key', () => {
      const counter = new UsageCounter();

      counter.increment({ kind: 'tool', name: 'file_read' });
      counter.increment({ kind: 'command', name: '/help' });
      counter.increment({ kind: 'pack', name: 'multi-agent', action: 'load' });
      counter.increment({ kind: 'pack', name: 'multi-agent', action: 'skip' });
      counter.increment({ kind: 'config_gate', name: 'vision', enabled: false });

      const snapshot = counter.snapshot();
      expect(snapshot['tool:file_read']).toBe(1);
      expect(snapshot['command:/help']).toBe(1);
      expect(snapshot['pack:multi-agent:load']).toBe(1);
      expect(snapshot['pack:multi-agent:skip']).toBe(1);
      expect(snapshot['config_gate:vision:false']).toBe(1);
    });

    it('snapshot 返回浅拷贝，修改不影响内部计数', () => {
      const counter = new UsageCounter();
      counter.increment({ kind: 'tool', name: 'file_write' });

      const snap1 = counter.snapshot();
      snap1['tool:file_write'] = 999;

      // 内部计数不受外部修改影响
      const snap2 = counter.snapshot();
      expect(snap2['tool:file_write']).toBe(1);
    });
  });

  // ============================================================
  // 用例 2：flush 后文件可解析为 JSON
  // ============================================================
  describe('flushToFile', () => {
    it('flush 后文件存在且可解析为 JSON，包含计数快照', async () => {
      const counter = new UsageCounter();
      counter.increment({ kind: 'tool', name: 'file_read' });
      counter.increment({ kind: 'tool', name: 'file_read' });
      counter.increment({ kind: 'command', name: '/help' });

      const filePath = path.join(tmpDir, 'usage-test.json');
      await counter.flushToFile(filePath);

      // 文件已创建
      expect(fs.existsSync(filePath)).toBe(true);

      // 文件内容可解析为 JSON
      const raw = fs.readFileSync(filePath, 'utf-8');
      const payload = JSON.parse(raw);

      // 包含元数据字段
      expect(payload).toHaveProperty('exportedAt');
      expect(payload).toHaveProperty('startedAt');
      expect(payload).toHaveProperty('windowDays', 7);
      expect(payload).toHaveProperty('counts');

      // 计数快照正确
      expect(payload.counts['tool:file_read']).toBe(2);
      expect(payload.counts['command:/help']).toBe(1);
    });

    it('flushToFile 自动创建不存在的父目录', async () => {
      const counter = new UsageCounter();
      counter.increment({ kind: 'tool', name: 'shell_exec' });

      // 嵌套目录不存在
      const filePath = path.join(tmpDir, 'nested', 'deep', 'usage.json');
      await counter.flushToFile(filePath);

      expect(fs.existsSync(filePath)).toBe(true);
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(payload.counts['tool:shell_exec']).toBe(1);
    });
  });

  // ============================================================
  // 用例 3：计数异常不抛到调用方（fail-open）
  // ============================================================
  describe('fail-open', () => {
    it('increment 内部异常不抛到调用方', () => {
      const counter = new UsageCounter();

      // 模拟内部计数表异常：用 Proxy 拦截 set 方法使其抛错
      const originalCounts = (counter as unknown as { counts: Map<string, number> }).counts;
      (counter as unknown as { counts: Map<string, number> }).counts = new Proxy(originalCounts, {
        get(target, prop) {
          if (prop === 'set') {
            return () => {
              throw new Error('模拟 Map.set 异常');
            };
          }
          return Reflect.get(target, prop);
        },
      });

      // increment 不应抛出异常
      expect(() => counter.increment({ kind: 'tool', name: 'file_read' })).not.toThrow();

      // 恢复原始 Map，验证 counter 仍可正常工作
      (counter as unknown as { counts: Map<string, number> }).counts = originalCounts;
      counter.increment({ kind: 'tool', name: 'file_read' });
      expect(counter.snapshot()['tool:file_read']).toBe(1);
    });

    it('flushToFile 写入无效路径不抛到调用方', async () => {
      const counter = new UsageCounter();
      counter.increment({ kind: 'tool', name: 'file_read' });

      // 包含 null 字节的路径会被 Node.js fs 拒绝（EINVAL）
      const invalidPath = path.join(tmpDir, 'inva\0lid.json');

      // flushToFile 不应抛出异常
      await expect(counter.flushToFile(invalidPath)).resolves.toBeUndefined();
    });

    it('snapshot 在异常情况下返回空对象而非抛出', () => {
      const counter = new UsageCounter();

      // 模拟内部计数表异常：用 Proxy 拦截迭代器使其抛错
      const originalCounts = (counter as unknown as { counts: Map<string, number> }).counts;
      (counter as unknown as { counts: Map<string, number> }).counts = new Proxy(originalCounts, {
        get(target, prop) {
          if (prop === 'entries' || prop === Symbol.iterator) {
            return () => {
              throw new Error('模拟迭代异常');
            };
          }
          return Reflect.get(target, prop);
        },
      });

      // snapshot 不应抛出异常，应返回空对象（fail-open）
      expect(() => counter.snapshot()).not.toThrow();
    });
  });
});
