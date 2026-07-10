// tests/desktop/ipc-guard.test.ts
// TD-08：ipcGuard 单元测试
// 覆盖 string / object / optional 三个校验器：正常、类型错误、超长、缺失字段等场景

import { describe, it, expect } from 'vitest';
import { ipcGuard } from '../../desktop/main/ipc-guard.js';

describe('ipcGuard.string', () => {
  it('正常字符串原样返回', () => {
    const validate = ipcGuard.string(100);
    expect(validate('hello')).toBe('hello');
  });

  it('空字符串原样返回（长度校验不拦空串，由 handler 业务逻辑判断）', () => {
    const validate = ipcGuard.string(100);
    expect(validate('')).toBe('');
  });

  it('恰好达到上限长度时通过', () => {
    const validate = ipcGuard.string(5);
    expect(validate('abcde')).toBe('abcde');
  });

  it('非字符串（number）抛错', () => {
    const validate = ipcGuard.string(100);
    expect(() => validate(123)).toThrow('参数必须是字符串');
  });

  it('非字符串（null）抛错', () => {
    const validate = ipcGuard.string(100);
    expect(() => validate(null)).toThrow('参数必须是字符串');
  });

  it('非字符串（undefined）抛错', () => {
    const validate = ipcGuard.string(100);
    expect(() => validate(undefined)).toThrow('参数必须是字符串');
  });

  it('非字符串（对象）抛错', () => {
    const validate = ipcGuard.string(100);
    expect(() => validate({ text: 'x' })).toThrow('参数必须是字符串');
  });

  it('超过最大长度抛错', () => {
    const validate = ipcGuard.string(5);
    expect(() => validate('abcdef')).toThrow('字符串长度不能超过 5');
  });

  it('错误信息包含具体的最大长度值', () => {
    const validate = ipcGuard.string(256);
    try {
      validate('a'.repeat(257));
      throw new Error('应在上一步抛错');
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toContain('256');
    }
  });
});

describe('ipcGuard.object', () => {
  it('正常对象返回校验后的对象', () => {
    const validate = ipcGuard.object<{ name: string; age: number }>({
      name: ipcGuard.string(100),
      age: (v: unknown) => {
        if (typeof v !== 'number') throw new Error('age 必须是数字');
        return v;
      },
    });
    const result = validate({ name: 'alice', age: 30 });
    expect(result.name).toBe('alice');
    expect(result.age).toBe(30);
  });

  it('null 抛错', () => {
    const validate = ipcGuard.object<{ name: string }>({ name: ipcGuard.string(100) });
    expect(() => validate(null)).toThrow('参数必须是对象');
  });

  it('undefined 抛错', () => {
    const validate = ipcGuard.object<{ name: string }>({ name: ipcGuard.string(100) });
    expect(() => validate(undefined)).toThrow('参数必须是对象');
  });

  it('原始值（number）抛错', () => {
    const validate = ipcGuard.object<{ name: string }>({ name: ipcGuard.string(100) });
    expect(() => validate(42)).toThrow('参数必须是对象');
  });

  it('数组抛错（typeof 数组是 object，但应为对象）', () => {
    // 注意：当前实现 typeof [] === 'object' 会通过类型检查，
    // 但若 shape 中有字段校验，数组下标取值会得到 undefined，由字段校验器决定是否抛错
    const validate = ipcGuard.object<{ name: string }>({ name: ipcGuard.string(100) });
    expect(() => validate(['x'])).toThrow('参数必须是字符串');
  });

  it('字段校验失败时抛出字段校验器的错误信息', () => {
    const validate = ipcGuard.object<{ name: string }>({ name: ipcGuard.string(100) });
    expect(() => validate({ name: 123 })).toThrow('参数必须是字符串');
  });

  it('单字段超长时抛错', () => {
    const validate = ipcGuard.object<{ name: string }>({ name: ipcGuard.string(3) });
    expect(() => validate({ name: 'abcd' })).toThrow('字符串长度不能超过 3');
  });

  it('passthrough：未声明字段原样保留', () => {
    const validate = ipcGuard.object<{ name: string }>({ name: ipcGuard.string(100) });
    const result = validate({ name: 'alice', extra: 'kept', systemPrompt: 'p' }) as { name: string; extra: string; systemPrompt: string };
    expect(result.name).toBe('alice');
    expect(result.extra).toBe('kept');
    expect(result.systemPrompt).toBe('p');
  });

  it('空 shape 仅校验非空对象（passthrough 保留全部字段）', () => {
    const validate = ipcGuard.object<Record<string, unknown>>({});
    const result = validate({ a: 1, b: 'x' });
    expect(result.a).toBe(1);
    expect(result.b).toBe('x');
  });

  it('多字段中首个失败立即抛错（短路）', () => {
    const validate = ipcGuard.object<{ a: string; b: string }>({
      a: ipcGuard.string(5),
      b: ipcGuard.string(5),
    });
    expect(() => validate({ a: 'toolong', b: 'ok' })).toThrow('字符串长度不能超过 5');
  });

  it('多字段全部通过时返回完整对象', () => {
    const validate = ipcGuard.object<{ a: string; b: string }>({
      a: ipcGuard.string(5),
      b: ipcGuard.string(5),
    });
    const result = validate({ a: 'aa', b: 'bb' });
    expect(result).toEqual({ a: 'aa', b: 'bb' });
  });
});

describe('ipcGuard.optional', () => {
  it('undefined 返回 undefined', () => {
    const validate = ipcGuard.optional(ipcGuard.string(100));
    expect(validate(undefined)).toBeUndefined();
  });

  it('null 返回 undefined', () => {
    const validate = ipcGuard.optional(ipcGuard.string(100));
    expect(validate(null)).toBeUndefined();
  });

  it('有值时调用内层校验器', () => {
    const validate = ipcGuard.optional(ipcGuard.string(100));
    expect(validate('hello')).toBe('hello');
  });

  it('有值但内层校验失败时抛错', () => {
    const validate = ipcGuard.optional(ipcGuard.string(3));
    expect(() => validate('abcd')).toThrow('字符串长度不能超过 3');
  });

  it('有值但类型错误时抛错', () => {
    const validate = ipcGuard.optional(ipcGuard.string(100));
    expect(() => validate(123)).toThrow('参数必须是字符串');
  });

  it('与 object 组合：可选字段缺失时不抛错', () => {
    interface Shape { name: string; nickname?: string }
    const validate = ipcGuard.object<Shape>({
      name: ipcGuard.string(100),
      nickname: ipcGuard.optional(ipcGuard.string(100)),
    });
    const result = validate({ name: 'alice' });
    expect(result.name).toBe('alice');
    expect(result.nickname).toBeUndefined();
  });

  it('与 object 组合：可选字段有值时校验通过', () => {
    interface Shape { name: string; nickname?: string }
    const validate = ipcGuard.object<Shape>({
      name: ipcGuard.string(100),
      nickname: ipcGuard.optional(ipcGuard.string(100)),
    });
    const result = validate({ name: 'alice', nickname: 'ali' });
    expect(result.name).toBe('alice');
    expect(result.nickname).toBe('ali');
  });

  it('与 object 组合：可选字段有值但校验失败时抛错', () => {
    interface Shape { name: string; nickname?: string }
    const validate = ipcGuard.object<Shape>({
      name: ipcGuard.string(100),
      nickname: ipcGuard.optional(ipcGuard.string(3)),
    });
    expect(() => validate({ name: 'alice', nickname: 'toolong' })).toThrow('字符串长度不能超过 3');
  });
});
