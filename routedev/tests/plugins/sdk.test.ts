// tests/plugins/sdk.test.ts
// SDK 接口与收集型注册表单元测试
// 覆盖：validatePlugin / CollectingToolRegistry / CollectingCommandRegistry /
//       CollectingHookRegistry / CollectingMiddlewareRegistry

import { describe, it, expect } from 'vitest';
import {
  validatePlugin,
  CollectingToolRegistry,
  CollectingCommandRegistry,
  CollectingHookRegistry,
  CollectingMiddlewareRegistry,
  type RouteDevPlugin,
  type PluginContext,
} from '../../src/plugins/sdk.js';
import type { ITool, ToolDefinition } from '../../src/tools/types.js';

// ============================================================
// 测试桩
// ============================================================

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const stubContext: PluginContext = {
  logger: stubLogger,
  config: {},
  cwd: '/test',
  readFile: async () => '',
  writeFile: async () => {},
};

const stubToolDef: ToolDefinition = {
  name: 'test_tool',
  description: '测试工具',
  parameters: { type: 'object', properties: {} },
  requiresApproval: false,
  category: 'system',
};

function makeStubTool(name: string): ITool {
  return {
    definition: { ...stubToolDef, name },
    async execute() {
      return { success: true, output: '', durationMs: 0 };
    },
    validateArgs() {
      return { valid: true, errors: [] };
    },
  };
}

// ============================================================
// validatePlugin
// ============================================================

describe('validatePlugin', () => {
  it('合法插件返回 null', () => {
    const plugin: RouteDevPlugin = { name: 'demo', version: '1.0.0' };
    expect(validatePlugin(plugin)).toBeNull();
  });

  it('null 返回错误', () => {
    expect(validatePlugin(null)).toContain('对象');
  });

  it('非对象返回错误', () => {
    expect(validatePlugin('not-an-object')).toContain('对象');
  });

  it('缺少 name 返回错误', () => {
    expect(validatePlugin({ version: '1.0.0' })).toContain('name');
  });

  it('name 为空字符串返回错误', () => {
    expect(validatePlugin({ name: '  ', version: '1.0.0' })).toContain('name');
  });

  it('缺少 version 返回错误', () => {
    expect(validatePlugin({ name: 'demo' })).toContain('version');
  });

  it('version 为空字符串返回错误', () => {
    expect(validatePlugin({ name: 'demo', version: '' })).toContain('version');
  });

  it('带 description 的完整插件校验通过', () => {
    const plugin: RouteDevPlugin = {
      name: 'demo',
      version: '1.0.0',
      description: 'A demo plugin',
      onLoad: () => {},
      onUnload: () => {},
      registerTools: () => {},
    };
    expect(validatePlugin(plugin)).toBeNull();
  });
});

// ============================================================
// CollectingToolRegistry
// ============================================================

describe('CollectingToolRegistry', () => {
  it('register / list / unregister', () => {
    const reg = new CollectingToolRegistry();
    expect(reg.list()).toHaveLength(0);

    const tool = makeStubTool('a');
    reg.register(tool);
    expect(reg.list()).toEqual(['a']);

    const tool2 = makeStubTool('b');
    reg.register(tool2);
    expect(reg.list()).toEqual(['a', 'b']);

    reg.unregister('a');
    expect(reg.list()).toEqual(['b']);
  });

  it('getRegistered 返回所有工具实例', () => {
    const reg = new CollectingToolRegistry();
    const t1 = makeStubTool('x');
    const t2 = makeStubTool('y');
    reg.register(t1);
    reg.register(t2);
    const all = reg.getRegistered();
    expect(all).toHaveLength(2);
    expect(all.map(t => t.definition.name).sort()).toEqual(['x', 'y']);
  });

  it('重复 register 同名工具会覆盖', () => {
    const reg = new CollectingToolRegistry();
    reg.register(makeStubTool('dup'));
    reg.register(makeStubTool('dup'));
    expect(reg.list()).toEqual(['dup']);
    expect(reg.getRegistered()).toHaveLength(1);
  });

  it('unregister 不存在的 name 不报错', () => {
    const reg = new CollectingToolRegistry();
    expect(() => reg.unregister('nonexistent')).not.toThrow();
  });
});

// ============================================================
// CollectingCommandRegistry
// ============================================================

describe('CollectingCommandRegistry', () => {
  it('register / list / unregister', () => {
    const reg = new CollectingCommandRegistry();
    expect(reg.list()).toHaveLength(0);

    reg.register({
      name: 'cmd1',
      description: 'cmd1',
      handler: async () => 'ok',
    });
    expect(reg.list()).toEqual(['cmd1']);

    reg.register({
      name: 'cmd2',
      description: 'cmd2',
      handler: async () => 'ok',
    });
    expect(reg.list()).toEqual(['cmd1', 'cmd2']);

    reg.unregister('cmd1');
    expect(reg.list()).toEqual(['cmd2']);
  });

  it('getRegistered 返回命令实例', () => {
    const reg = new CollectingCommandRegistry();
    reg.register({ name: 'c', description: 'c', handler: async () => 'ok' });
    expect(reg.getRegistered()).toHaveLength(1);
    expect(reg.getRegistered()[0].name).toBe('c');
  });
});

// ============================================================
// CollectingHookRegistry
// ============================================================

describe('CollectingHookRegistry', () => {
  it('register / unregister', () => {
    const reg = new CollectingHookRegistry();
    const fn = () => {};
    reg.register('onMessage', fn);
    expect(reg.getRegistered().get('onMessage')).toBe(fn);

    reg.unregister('onMessage');
    expect(reg.getRegistered().has('onMessage')).toBe(false);
  });

  it('getRegistered 返回独立副本', () => {
    const reg = new CollectingHookRegistry();
    reg.register('e1', () => {});
    const m1 = reg.getRegistered();
    const m2 = reg.getRegistered();
    expect(m1).not.toBe(m2); // 不同实例
    expect(m1.get('e1')).toBe(m2.get('e1')); // 但内容相同
  });
});

// ============================================================
// CollectingMiddlewareRegistry
// ============================================================

describe('CollectingMiddlewareRegistry', () => {
  it('register / unregister', () => {
    const reg = new CollectingMiddlewareRegistry();
    const fn = () => {};
    reg.register('beforeAct', fn);
    expect(reg.getRegistered().get('beforeAct')).toBe(fn);

    reg.unregister('beforeAct');
    expect(reg.getRegistered().has('beforeAct')).toBe(false);
  });
});

// ============================================================
// PluginContext 桩
// ============================================================

describe('PluginContext（桩）', () => {
  it('stubContext 字段齐全', () => {
    expect(stubContext.logger).toBeDefined();
    expect(stubContext.config).toEqual({});
    expect(stubContext.cwd).toBe('/test');
    expect(typeof stubContext.readFile).toBe('function');
    expect(typeof stubContext.writeFile).toBe('function');
  });
});
