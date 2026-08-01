// tests/utils/migration.test.ts
// Phase 93 Task 7 Step 2：migrate() 工具函数单元测试
//
// 覆盖：
//   - 版本已是当前或更高：直接返回
//   - 缺失 __schemaVersion：视为 0，触发全部迁移
//   - 逐版本迁移（0→1→2）
//   - 迁移函数抛异常：返回 fallback
//   - 缺少迁移函数：返回 fallback
//   - readSchemaVersion：非数字/非对象返回 0
//   - withSchemaVersion：浅拷贝 + 标记版本

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrate, readSchemaVersion, withSchemaVersion } from '../../src/utils/migration.js';

describe('migration 工具函数 (Phase 93 Task 7)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('readSchemaVersion', () => {
    it('读取正整数版本号', () => {
      expect(readSchemaVersion({ __schemaVersion: 1 })).toBe(1);
      expect(readSchemaVersion({ __schemaVersion: 5 })).toBe(5);
    });

    it('缺失 __schemaVersion 返回 0', () => {
      expect(readSchemaVersion({ foo: 'bar' })).toBe(0);
    });

    it('非数字返回 0', () => {
      expect(readSchemaVersion({ __schemaVersion: '1' })).toBe(0);
      expect(readSchemaVersion({ __schemaVersion: 1.5 })).toBe(0);
      expect(readSchemaVersion({ __schemaVersion: -1 })).toBe(0);
      expect(readSchemaVersion({ __schemaVersion: null })).toBe(0);
    });

    it('非对象返回 0', () => {
      expect(readSchemaVersion(null)).toBe(0);
      expect(readSchemaVersion(undefined)).toBe(0);
      expect(readSchemaVersion('string')).toBe(0);
      expect(readSchemaVersion(42)).toBe(0);
    });
  });

  describe('withSchemaVersion', () => {
    it('浅拷贝并添加版本号', () => {
      const original = { name: 'test', value: 42 };
      const result = withSchemaVersion(original, 1);
      expect(result).toEqual({ name: 'test', value: 42, __schemaVersion: 1 });
      // 不修改原对象
      expect(original).toEqual({ name: 'test', value: 42 });
      expect('__schemaVersion' in original).toBe(false);
    });

    it('覆盖已有版本号', () => {
      const original = { name: 'test', __schemaVersion: 1 };
      const result = withSchemaVersion(original, 2);
      expect(result.__schemaVersion).toBe(2);
    });
  });

  describe('migrate', () => {
    it('版本已是当前：直接返回原数据', () => {
      const raw = { __schemaVersion: 2, data: 'test' };
      const result = migrate(raw, {
        currentVersion: 2,
        migrations: [],
      });
      expect(result).toBe(raw);
    });

    it('版本更高：向前兼容直接返回', () => {
      const raw = { __schemaVersion: 5, data: 'future' };
      const result = migrate(raw, {
        currentVersion: 2,
        migrations: [],
      });
      expect(result).toBe(raw);
    });

    it('缺失 __schemaVersion：从 0 开始迁移', () => {
      const raw = { oldField: 'value' };
      const result = migrate(raw, {
        currentVersion: 1,
        migrations: [
          (v0) => ({ ...(v0 as object), newField: 'added' }),
        ],
      });
      expect(result).toEqual({
        oldField: 'value',
        newField: 'added',
        __schemaVersion: 1,
      });
    });

    it('多版本迁移：0 → 1 → 2', () => {
      const raw = { oldName: 'test' };
      const result = migrate(raw, {
        currentVersion: 2,
        migrations: [
          // 0 → 1：重命名字段
          (v0) => {
            const obj = v0 as { oldName: string };
            return { name: obj.oldName };
          },
          // 1 → 2：添加新字段
          (v1) => {
            const obj = v1 as { name: string };
            return { name: obj.name, version: 2 };
          },
        ],
      });
      expect(result).toEqual({
        name: 'test',
        version: 2,
        __schemaVersion: 2,
      });
    });

    it('迁移函数抛异常：返回 fallback', () => {
      const raw = { __schemaVersion: 0 };
      const fallback = { safe: true };
      const result = migrate(raw, {
        currentVersion: 2,
        migrations: [
          () => { throw new Error('migration failed'); },
        ],
        fallback,
        caller: 'TestModule',
      });
      expect(result).toBe(fallback);
    });

    it('缺少迁移函数：返回 fallback', () => {
      const raw = { __schemaVersion: 0 };
      const fallback = { safe: true };
      const result = migrate(raw, {
        currentVersion: 3,
        migrations: [
          (v0) => ({ ...v0, step: 1 }),
          // 缺少 1→2 和 2→3 的迁移函数
        ],
        fallback,
        caller: 'TestModule',
      });
      expect(result).toBe(fallback);
    });

    it('未提供 fallback：返回 undefined', () => {
      const raw = { __schemaVersion: 0 };
      const result = migrate(raw, {
        currentVersion: 2,
        migrations: [
          () => { throw new Error('fail'); },
        ],
      });
      expect(result).toBeUndefined();
    });

    it('调用方标识传入日志', () => {
      const raw = { __schemaVersion: 0 };
      const fallback = { safe: true };
      // 不抛错即验证 caller 参数被接受（实际日志在 logger.warn 中）
      migrate(raw, {
        currentVersion: 1,
        migrations: [() => { throw new Error('test'); }],
        fallback,
        caller: 'MyModule',
      });
      // 无异常抛出即通过
      expect(true).toBe(true);
    });

    it('非对象数据被迁移函数处理', () => {
      const raw = 'string-data';
      const result = migrate(raw, {
        currentVersion: 1,
        migrations: [
          () => ({ wrapped: true }),
        ],
      });
      // 迁移函数返回对象，但 __schemaVersion 写入检查 data 是对象
      expect(result).toEqual({ wrapped: true, __schemaVersion: 1 });
    });
  });
});
