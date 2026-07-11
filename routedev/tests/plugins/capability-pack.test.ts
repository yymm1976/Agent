// tests/plugins/capability-pack.test.ts
// Phase 82 Task 1：能力包运行时单元测试
//
// 覆盖：
//   1. 默认不 register 任何 Pack 工具
//   2. enable 后可调用 register
//   3. 重复 enable 幂等
//   4. register 抛错不阻断 Core（fail-open）
//   5. usage-counter 记录 pack load/skip
//   6. unregister 清理

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CapabilityPackRegistry } from '../../src/plugins/capability-pack-registry.js';
import {
  CommandRegistry,
  PackEventBus,
  type CapabilityPack,
  type PackContext,
} from '../../src/plugins/capability-pack.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { UsageCounter } from '../../src/observability/usage-counter.js';
import { logger } from '../../src/utils/logger.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { ITool } from '../../src/tools/types.js';

// ============================================================
// 测试辅助工厂
// ============================================================

/** 创建一个最小化的 mock ITool（供 Pack.register 注册到 ToolRegistry） */
function makeMockTool(name: string): ITool {
  return {
    definition: {
      name,
      description: `测试工具 ${name}`,
      parameters: { type: 'object', properties: {} },
      requiresApproval: false,
      category: 'system',
    },
    async execute() {
      return { success: true, output: 'ok', durationMs: 0 };
    },
    validateArgs() {
      return { valid: true, errors: [] };
    },
  };
}

/** 创建一个 mock CapabilityPack（register 时注册指定工具） */
function makeMockPack(
  id: string,
  opts?: {
    layer?: 'extended' | 'standard';
    toolName?: string;
    registerFn?: (ctx: PackContext) => void | Promise<void>;
    throwInRegister?: Error;
  },
): CapabilityPack & { registerCalls: number; lastCtx?: PackContext } {
  const toolName = opts?.toolName ?? `tool_${id}`;
  let registerCalls = 0;
  let lastCtx: PackContext | undefined;

  const pack: CapabilityPack & { registerCalls: number; lastCtx?: PackContext } = {
    id,
    configKey: id,
    layer: opts?.layer ?? 'standard',
    description: `测试 Pack ${id}`,
    costHint: '+1 tool',
    defaultEnabled: false,
    async register(ctx: PackContext) {
      registerCalls++;
      lastCtx = ctx;
      if (opts?.throwInRegister) {
        throw opts.throwInRegister;
      }
      if (opts?.registerFn) {
        await opts.registerFn(ctx);
      } else {
        ctx.tools.register(makeMockTool(toolName));
      }
    },
    get registerCalls() {
      return registerCalls;
    },
    get lastCtx() {
      return lastCtx;
    },
  };

  return pack;
}

/** 创建一个 PackContext（使用真实的 ToolRegistry / CommandRegistry / PackEventBus / UsageCounter） */
function makePackContext(configOverrides?: Record<string, { enabled?: boolean }>): PackContext {
  const config = {
    packs: configOverrides ?? {},
  } as unknown as AppConfig;

  return {
    tools: new ToolRegistry(),
    commands: new CommandRegistry(),
    events: new PackEventBus(),
    config,
    logger,
    usage: new UsageCounter(),
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('CapabilityPackRegistry', () => {
  let registry: CapabilityPackRegistry;

  beforeEach(() => {
    registry = new CapabilityPackRegistry();
  });

  // 测试 1：默认不 register 任何 Pack 工具
  it('默认不 register 任何 Pack 工具（所有 pack 未 enabled）', async () => {
    const pack = makeMockPack('testPackA');
    registry.register(pack);

    const ctx = makePackContext(); // 空 packs 配置，无 enabled
    await registry.loadEnabled(ctx);

    // register 未被调用
    expect(pack.registerCalls).toBe(0);
    // ToolRegistry 为空
    expect(ctx.tools.size).toBe(0);
    // 无 pack:load 计数
    const snapshot = ctx.usage.snapshot();
    expect(Object.keys(snapshot).filter((k) => k.startsWith('pack:'))).toHaveLength(0);
  });

  // 测试 2：enable 后可调用 register
  it('enable 后可调用 register，工具被注册到 ToolRegistry', async () => {
    const pack = makeMockPack('testPackA', { toolName: 'mock_tool_a' });
    registry.register(pack);

    const ctx = makePackContext({ testPackA: { enabled: true } });
    await registry.loadEnabled(ctx);

    // register 被调用一次
    expect(pack.registerCalls).toBe(1);
    // 工具已注册
    expect(ctx.tools.has('mock_tool_a')).toBe(true);
    expect(ctx.tools.size).toBe(1);
    // usage-counter 记录 pack:testPackA:load
    const snapshot = ctx.usage.snapshot();
    expect(snapshot['pack:testPackA:load']).toBe(1);
    expect(snapshot['pack:testPackA:skip']).toBeUndefined();
  });

  // 测试 3：重复 enable 幂等
  it('重复 loadEnabled 幂等（已加载的 Pack 不再重复 register）', async () => {
    const pack = makeMockPack('testPackA', { toolName: 'mock_tool_a' });
    registry.register(pack);

    const ctx = makePackContext({ testPackA: { enabled: true } });

    // 第一次加载
    await registry.loadEnabled(ctx);
    expect(pack.registerCalls).toBe(1);

    // 第二次加载——幂等，不重复调用 register
    await registry.loadEnabled(ctx);
    expect(pack.registerCalls).toBe(1);

    // 工具仍只有一个
    expect(ctx.tools.size).toBe(1);
    // usage-counter 的 load 计数仍为 1（第二次未重复计数）
    const snapshot = ctx.usage.snapshot();
    expect(snapshot['pack:testPackA:load']).toBe(1);
  });

  // 测试 4：register 抛错不阻断 Core（fail-open）
  it('register 抛错不阻断 Core（fail-open），其他 Pack 仍可正常加载', async () => {
    const brokenPack = makeMockPack('brokenPack', {
      throwInRegister: new Error('模拟 register 失败'),
    });
    const normalPack = makeMockPack('normalPack', { toolName: 'mock_tool_normal' });
    registry.register(brokenPack);
    registry.register(normalPack);

    const ctx = makePackContext({
      brokenPack: { enabled: true },
      normalPack: { enabled: true },
    });

    // loadEnabled 不抛异常
    await expect(registry.loadEnabled(ctx)).resolves.toBeUndefined();

    // brokenPack 的 register 被调用（但抛错了）
    expect(brokenPack.registerCalls).toBe(1);
    // normalPack 的 register 也被调用（未被 brokenPack 阻断）
    expect(normalPack.registerCalls).toBe(1);
    // normalPack 的工具已注册
    expect(ctx.tools.has('mock_tool_normal')).toBe(true);
    // brokenPack 未标记为已加载
    expect(registry.isLoaded('brokenPack')).toBe(false);
    // normalPack 已标记为已加载
    expect(registry.isLoaded('normalPack')).toBe(true);
  });

  // 测试 5：usage-counter 记录 pack load/skip
  it('usage-counter 正确记录 pack load 和 skip', async () => {
    const successPack = makeMockPack('successPack', { toolName: 'tool_success' });
    const failPack = makeMockPack('failPack', {
      throwInRegister: new Error('故意失败'),
    });
    const disabledPack = makeMockPack('disabledPack', { toolName: 'tool_disabled' });
    registry.register(successPack);
    registry.register(failPack);
    registry.register(disabledPack);

    const ctx = makePackContext({
      successPack: { enabled: true },
      failPack: { enabled: true },
      disabledPack: { enabled: false },
    });

    await registry.loadEnabled(ctx);

    const snapshot = ctx.usage.snapshot();
    // successPack 记录 load
    expect(snapshot['pack:successPack:load']).toBe(1);
    expect(snapshot['pack:successPack:skip']).toBeUndefined();
    // failPack 记录 skip
    expect(snapshot['pack:failPack:skip']).toBe(1);
    expect(snapshot['pack:failPack:load']).toBeUndefined();
    // disabledPack 未 enabled，不记录任何计数
    expect(snapshot['pack:disabledPack:load']).toBeUndefined();
    expect(snapshot['pack:disabledPack:skip']).toBeUndefined();
  });

  // 测试 6：unregister 清理
  it('unregister 从注册表中移除 Pack，loadEnabled 不再加载它', async () => {
    const pack = makeMockPack('testPackA', { toolName: 'mock_tool_a' });
    registry.register(pack);
    expect(registry.get('testPackA')).toBeDefined();
    expect(registry.listAll()).toHaveLength(1);

    // 先加载
    const ctx = makePackContext({ testPackA: { enabled: true } });
    await registry.loadEnabled(ctx);
    expect(registry.isLoaded('testPackA')).toBe(true);

    // unregister 清理
    registry.unregister('testPackA');
    expect(registry.get('testPackA')).toBeUndefined();
    expect(registry.listAll()).toHaveLength(0);
    // 加载标记也清除
    expect(registry.isLoaded('testPackA')).toBe(false);

    // 再次 loadEnabled 不会报错也不会重新加载
    await registry.loadEnabled(ctx);
    expect(pack.registerCalls).toBe(1); // 仍为 1，未被再次调用
  });

  // 额外测试 7：listByLayer 按层级过滤
  it('listByLayer 按层级过滤 Pack', () => {
    const extendedPack = makeMockPack('ext1', { layer: 'extended' });
    const standardPack = makeMockPack('std1', { layer: 'standard' });
    registry.register(extendedPack);
    registry.register(standardPack);

    expect(registry.listAll()).toHaveLength(2);
    expect(registry.listByLayer('extended')).toHaveLength(1);
    expect(registry.listByLayer('extended')[0].id).toBe('ext1');
    expect(registry.listByLayer('standard')).toHaveLength(1);
    expect(registry.listByLayer('standard')[0].id).toBe('std1');
  });
});

// ============================================================
// CommandRegistry 测试
// ============================================================

describe('CommandRegistry', () => {
  it('register / execute / unregister / list 基本流程', async () => {
    const cmd = new CommandRegistry();
    const handler = vi.fn((args: string) => `结果: ${args}`);

    // 初始为空
    expect(cmd.list()).toHaveLength(0);
    expect(cmd.has('test')).toBe(false);

    // 注册
    cmd.register('test', handler);
    expect(cmd.has('test')).toBe(true);
    expect(cmd.list()).toEqual(['test']);

    // 执行
    const result = await cmd.execute('test', 'hello');
    expect(result).toBe('结果: hello');
    expect(handler).toHaveBeenCalledWith('hello');

    // 注销
    cmd.unregister('test');
    expect(cmd.has('test')).toBe(false);
    expect(cmd.list()).toHaveLength(0);

    // 注销后执行抛异常
    await expect(cmd.execute('test', '')).rejects.toThrow('Command "test" not found');
  });

  it('重复注册同名命令抛异常', () => {
    const cmd = new CommandRegistry();
    cmd.register('dup', () => 'a');
    expect(() => cmd.register('dup', () => 'b')).toThrow('Command "dup" already registered');
  });
});

// ============================================================
// PackEventBus 测试
// ============================================================

describe('PackEventBus', () => {
  it('on / emit / off 基本流程', () => {
    const bus = new PackEventBus();
    const handler = vi.fn((payload: unknown) => {});

    // 订阅
    bus.on('tool_call', handler);
    expect(bus.listenerCount('tool_call')).toBe(1);

    // 触发
    bus.emit('tool_call', { tool: 'file_read' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ tool: 'file_read' });

    // 取消订阅
    bus.off('tool_call', handler);
    expect(bus.listenerCount('tool_call')).toBe(0);

    // 取消后触发不再调用
    bus.emit('tool_call', { tool: 'file_write' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('单个处理器异常不阻断其他处理器（fail-open）', () => {
    const bus = new PackEventBus();
    const badHandler = vi.fn(() => {
      throw new Error('模拟处理器异常');
    });
    const goodHandler = vi.fn(() => {});

    bus.on('message', badHandler);
    bus.on('message', goodHandler);

    // emit 不抛异常
    expect(() => bus.emit('message', { text: 'hi' })).not.toThrow();

    // 两个处理器都被调用（bad 抛错不影响 good）
    expect(badHandler).toHaveBeenCalledTimes(1);
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });

  it('无订阅者时 emit 不报错', () => {
    const bus = new PackEventBus();
    expect(() => bus.emit('turn_start', {})).not.toThrow();
    expect(bus.listenerCount('turn_start')).toBe(0);
  });
});
