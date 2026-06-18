// tests/plugins/sdk.test.ts
// 插件 SDK 辅助函数测试（Phase 22）
// 覆盖：defineToolPlugin / defineHookPlugin / defineThemePlugin / defineRouterPlugin

import { describe, it, expect } from 'vitest';
import {
  defineToolPlugin,
  defineHookPlugin,
  defineThemePlugin,
  defineRouterPlugin,
} from '../../src/plugins/sdk.js';
import type { ClassificationInput, ClassificationResult } from '../../src/router/types.js';

describe('Plugin SDK', () => {
  // 测试 1：defineToolPlugin 返回合法 ToolPlugin
  it('defineToolPlugin 返回合法 ToolPlugin', () => {
    const plugin = defineToolPlugin('mytool', [
      {
        name: 'echo',
        description: '回显工具',
        parameters: { type: 'object', properties: { msg: { type: 'string' } } },
        execute: async (args) => ({
          success: true,
          output: String(args.msg ?? ''),
          durationMs: 0,
        }),
      },
    ]);

    expect(plugin.type).toBe('tool');
    expect(plugin.id).toBe('tool-mytool');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.enabled).toBe(true);

    const tools = plugin.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].definition.name).toBe('echo');
    expect(tools[0].definition.category).toBe('system');
    expect(tools[0].definition.requiresApproval).toBe(false);
    // validateArgs 默认总是有效
    expect(tools[0].validateArgs({})).toEqual({ valid: true, errors: [] });
  });

  // 测试 2：defineHookPlugin 返回合法 HookPlugin
  it('defineHookPlugin 返回合法 HookPlugin', () => {
    const handler = async (_ctx, next) => {
      await next();
    };
    const plugin = defineHookPlugin('myhook', [
      { phase: 'onAgent', handler },
      { phase: 'onReasoning', handler },
    ]);

    expect(plugin.type).toBe('hook');
    expect(plugin.id).toBe('hook-myhook');
    expect(plugin.version).toBe('1.0.0');

    const hooks = plugin.getHooks();
    expect(hooks).toHaveLength(2);
    expect(hooks[0].phase).toBe('onAgent');
    expect(hooks[1].phase).toBe('onReasoning');
    expect(typeof hooks[0].handler).toBe('function');
  });

  // 测试 3：defineThemePlugin 返回合法 ThemePlugin
  it('defineThemePlugin 返回合法 ThemePlugin', () => {
    const plugin = defineThemePlugin('dark', {
      colors: { primary: '#ff0000', background: '#000000' },
      renderStatusBar: () => 'custom-status',
    });

    expect(plugin.type).toBe('theme');
    expect(plugin.id).toBe('theme-dark');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.colors?.primary).toBe('#ff0000');
    expect(plugin.colors?.background).toBe('#000000');
    expect(typeof plugin.renderStatusBar).toBe('function');
    expect(plugin.renderStatusBar?.({})).toBe('custom-status');
  });

  // 测试 4：defineRouterPlugin 返回合法 RouterPlugin
  it('defineRouterPlugin 返回合法 RouterPlugin，classify() 可调', async () => {
    const classifier = async (
      input: ClassificationInput,
    ): Promise<ClassificationResult | null> => {
      if (input.query.includes('complex')) {
        return {
          tier: 'complex',
          confidence: 0.9,
          reasoning: 'router-plugin-test',
          source: 'rule',
        };
      }
      return null;
    };
    const plugin = defineRouterPlugin('myrouter', classifier);

    expect(plugin.type).toBe('router');
    expect(plugin.id).toBe('router-myrouter');
    expect(plugin.version).toBe('1.0.0');

    const result = await plugin.classify({ query: 'this is complex' });
    expect(result).not.toBeNull();
    expect(result?.tier).toBe('complex');
    expect(result?.reasoning).toBe('router-plugin-test');

    const nullResult = await plugin.classify({ query: 'simple' });
    expect(nullResult).toBeNull();
  });

  // 额外：验证 init/destroy 是空 async 函数
  it('所有 define* 插件的 init/destroy 可安全调用', async () => {
    const tool = defineToolPlugin('t', []);
    const hook = defineHookPlugin('h', []);
    const theme = defineThemePlugin('th', {});
    const router = defineRouterPlugin('r', async () => null);

    await expect(tool.init({ cwd: '/', config: {}, log: () => {} })).resolves.toBeUndefined();
    await expect(tool.destroy()).resolves.toBeUndefined();
    await expect(hook.init({ cwd: '/', config: {}, log: () => {} })).resolves.toBeUndefined();
    await expect(hook.destroy()).resolves.toBeUndefined();
    await expect(theme.init({ cwd: '/', config: {}, log: () => {} })).resolves.toBeUndefined();
    await expect(theme.destroy()).resolves.toBeUndefined();
    await expect(router.init({ cwd: '/', config: {}, log: () => {} })).resolves.toBeUndefined();
    await expect(router.destroy()).resolves.toBeUndefined();
  });
});
