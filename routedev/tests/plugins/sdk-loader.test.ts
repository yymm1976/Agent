// tests/plugins/sdk-loader.test.ts
// PluginLoader 单元测试
// 覆盖：loadFromFile / loadFromDir / unload / listLoaded / 接口校验 / fail-open

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PluginLoader, createDefaultPluginContext } from '../../src/plugins/sdk-loader.js';
import type { PluginContext, RouteDevPlugin } from '../../src/plugins/sdk.js';

// ============================================================
// 临时目录管理
// ============================================================

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-plugin-sdk-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ============================================================
// 插件文件内容生成器
// ============================================================

const VALID_PLUGIN_JS = `
export default {
  name: 'test-plugin',
  version: '1.0.0',
  description: 'A test plugin',
  onLoad(ctx) {
    ctx.logger.info('loaded');
  },
  onUnload() {},
  registerTools(registry) {
    registry.register({
      definition: {
        name: 'test_tool',
        description: 'test',
        parameters: { type: 'object', properties: {} },
        requiresApproval: false,
        category: 'system'
      },
      async execute() { return { success: true, output: 'ok', durationMs: 0 }; },
      validateArgs() { return { valid: true, errors: [] }; }
    });
  },
  registerCommands(registry) {
    registry.register({
      name: 'test-cmd',
      description: 'test cmd',
      handler: async () => 'cmd-result'
    });
  }
};
`;

const PLUGIN_NO_NAME_JS = `
export default {
  version: '1.0.0'
};
`;

const PLUGIN_NO_VERSION_JS = `
export default {
  name: 'no-version'
};
`;

const PLUGIN_THROWS_ON_LOAD_JS = `
export default {
  name: 'throws-on-load',
  version: '1.0.0',
  onLoad() { throw new Error('onLoad boom'); }
};
`;

const PLUGIN_REGISTER_THROWS_JS = `
export default {
  name: 'register-throws',
  version: '1.0.0',
  registerTools() { throw new Error('register boom'); }
};
`;

const PLUGIN_NAMED_EXPORT_JS = `
export const plugin = {
  name: 'named-export-plugin',
  version: '2.0.0'
};
`;

async function writeFile(name: string, content: string): Promise<string> {
  const p = path.join(tempDir, name);
  await fs.writeFile(p, content, 'utf-8');
  return p;
}

// ============================================================
// PluginContext（测试用桩，避免触发宿主 logger 文件 transport）
// ============================================================

function makeTestContext(cwd: string): PluginContext {
  return {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    config: {},
    cwd,
    readFile: async (p: string) => fs.readFile(p, 'utf-8'),
    writeFile: async (p: string, c: string) => fs.writeFile(p, c, 'utf-8'),
  };
}

// ============================================================
// 测试
// ============================================================

describe('PluginLoader', () => {
  let loader: PluginLoader;

  beforeEach(() => {
    loader = new PluginLoader(makeTestContext(tempDir));
  });

  // ----- loadFromFile -----

  describe('loadFromFile', () => {
    it('加载合法插件（default export）', async () => {
      const file = await writeFile('valid.js', VALID_PLUGIN_JS);
      const plugin = await loader.loadFromFile(file);

      expect(plugin.name).toBe('test-plugin');
      expect(plugin.version).toBe('1.0.0');
      expect(plugin.description).toBe('A test plugin');
    });

    it('加载 named export 插件', async () => {
      const file = await writeFile('named.js', PLUGIN_NAMED_EXPORT_JS);
      const plugin = await loader.loadFromFile(file);

      expect(plugin.name).toBe('named-export-plugin');
      expect(plugin.version).toBe('2.0.0');
    });

    it('onLoad 被调用', async () => {
      let called = false;
      const file = await writeFile(
        'onload.js',
        `export default {
          name: 'onload-test',
          version: '1.0.0',
          onLoad(ctx) { called = true; }
        };`.replace('called = true', 'globalThis.__onloadCalled = true'),
      );
      // 注入 globalThis 标记
      (globalThis as any).__onloadCalled = false;
      await loader.loadFromFile(file);
      expect((globalThis as any).__onloadCalled).toBe(true);
      delete (globalThis as any).__onloadCalled;
    });

    it('registerTools 被调用，工具被收集', async () => {
      const file = await writeFile('with-tools.js', VALID_PLUGIN_JS);
      const plugin = await loader.loadFromFile(file);

      const tools = loader.getPluginTools(plugin.name);
      expect(tools).toHaveLength(1);
      expect(tools[0].definition.name).toBe('test_tool');
    });

    it('registerCommands 被调用，命令被收集', async () => {
      const file = await writeFile('with-cmds.js', VALID_PLUGIN_JS);
      const plugin = await loader.loadFromFile(file);

      const cmds = loader.getPluginCommands(plugin.name);
      expect(cmds).toHaveLength(1);
      expect(cmds[0].name).toBe('test-cmd');
    });

    it('接口校验失败（缺少 name）抛错', async () => {
      const file = await writeFile('no-name.js', PLUGIN_NO_NAME_JS);
      await expect(loader.loadFromFile(file)).rejects.toThrow('name');
    });

    it('接口校验失败（缺少 version）抛错', async () => {
      const file = await writeFile('no-version.js', PLUGIN_NO_VERSION_JS);
      await expect(loader.loadFromFile(file)).rejects.toThrow('version');
    });

    it('不支持的文件扩展名抛错', async () => {
      const file = await writeFile('plugin.txt', VALID_PLUGIN_JS);
      await expect(loader.loadFromFile(file)).rejects.toThrow('扩展名');
    });

    it('onLoad 抛错时加载失败', async () => {
      const file = await writeFile('throws.js', PLUGIN_THROWS_ON_LOAD_JS);
      await expect(loader.loadFromFile(file)).rejects.toThrow('onLoad');
    });

    it('registerTools 抛错时 fail-open（不影响加载）', async () => {
      const file = await writeFile('register-throws.js', PLUGIN_REGISTER_THROWS_JS);
      // registerTools 抛错被 safeRegister 捕获，加载仍成功
      const plugin = await loader.loadFromFile(file);
      expect(plugin.name).toBe('register-throws');
      // 但工具未被收集
      expect(loader.getPluginTools(plugin.name)).toHaveLength(0);
    });

    it('文件不存在抛错', async () => {
      await expect(
        loader.loadFromFile(path.join(tempDir, 'nonexistent.js')),
      ).rejects.toThrow();
    });

    it('重复加载同名插件抛错', async () => {
      const file = await writeFile('dup.js', VALID_PLUGIN_JS);
      await loader.loadFromFile(file);
      await expect(loader.loadFromFile(file)).rejects.toThrow('已加载');
    });

    it('相对路径基于 cwd 解析', async () => {
      const file = await writeFile('relative.js', VALID_PLUGIN_JS);
      const relativePath = path.basename(file);
      const plugin = await loader.loadFromFile(relativePath);
      expect(plugin.name).toBe('test-plugin');
    });
  });

  // ----- loadFromDir -----

  describe('loadFromDir', () => {
    it('加载目录下所有 .js 插件', async () => {
      await writeFile('a.js', VALID_PLUGIN_JS);
      await writeFile(
        'b.js',
        `export default { name: 'b-plugin', version: '1.0.0' };`,
      );

      const plugins = await loader.loadFromDir(tempDir);
      expect(plugins).toHaveLength(2);
      const names = plugins.map(p => p.name).sort();
      expect(names).toEqual(['b-plugin', 'test-plugin']);
    });

    it('跳过 .txt 等不支持的扩展名', async () => {
      await writeFile('valid.js', VALID_PLUGIN_JS);
      await writeFile('readme.txt', 'not a plugin');

      const plugins = await loader.loadFromDir(tempDir);
      expect(plugins).toHaveLength(1);
    });

    it('fail-open：单个插件失败不影响其他', async () => {
      await writeFile('bad.js', PLUGIN_NO_NAME_JS);
      await writeFile(
        'good.js',
        `export default { name: 'good', version: '1.0.0' };`,
      );

      const plugins = await loader.loadFromDir(tempDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('good');
    });

    it('目录不存在时返回空数组', async () => {
      const plugins = await loader.loadFromDir(
        path.join(tempDir, 'nonexistent'),
      );
      expect(plugins).toEqual([]);
    });

    it('跳过子目录', async () => {
      await writeFile('valid.js', VALID_PLUGIN_JS);
      await fs.mkdir(path.join(tempDir, 'subdir'), { recursive: true });

      const plugins = await loader.loadFromDir(tempDir);
      expect(plugins).toHaveLength(1);
    });
  });

  // ----- unload -----

  describe('unload', () => {
    it('卸载已加载插件', async () => {
      const file = await writeFile('unload.js', VALID_PLUGIN_JS);
      const plugin = await loader.loadFromFile(file);

      await loader.unload(plugin);
      expect(loader.listLoaded()).toHaveLength(0);
      expect(loader.has(plugin.name)).toBe(false);
    });

    it('用 name 字符串卸载', async () => {
      const file = await writeFile('unload-by-name.js', VALID_PLUGIN_JS);
      await loader.loadFromFile(file);

      await loader.unload('test-plugin');
      expect(loader.has('test-plugin')).toBe(false);
    });

    it('onUnload 被调用', async () => {
      (globalThis as any).__onUnloadCalled = false;
      const file = await writeFile(
        'onunload.js',
        `export default {
          name: 'onunload-test',
          version: '1.0.0',
          onUnload() { globalThis.__onUnloadCalled = true; }
        };`,
      );
      const plugin = await loader.loadFromFile(file);
      await loader.unload(plugin);
      expect((globalThis as any).__onUnloadCalled).toBe(true);
      delete (globalThis as any).__onUnloadCalled;
    });

    it('卸载未加载的插件抛错', async () => {
      await expect(loader.unload('never-loaded')).rejects.toThrow('未加载');
    });

    it('onUnload 抛错时不阻塞清理', async () => {
      const file = await writeFile(
        'unload-throws.js',
        `export default {
          name: 'unload-throws',
          version: '1.0.0',
          onUnload() { throw new Error('unload boom'); }
        };`,
      );
      const plugin = await loader.loadFromFile(file);
      // 不应抛错
      await loader.unload(plugin);
      expect(loader.has('unload-throws')).toBe(false);
    });
  });

  // ----- listLoaded / has / getPlugin -----

  describe('listLoaded / has / getPlugin', () => {
    it('listLoaded 返回 name/version/path', async () => {
      const file = await writeFile('list.js', VALID_PLUGIN_JS);
      await loader.loadFromFile(file);

      const list = loader.listLoaded();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('test-plugin');
      expect(list[0].version).toBe('1.0.0');
      expect(list[0].path).toBe(file);
    });

    it('has 检查插件是否加载', async () => {
      expect(loader.has('test-plugin')).toBe(false);
      const file = await writeFile('has.js', VALID_PLUGIN_JS);
      await loader.loadFromFile(file);
      expect(loader.has('test-plugin')).toBe(true);
    });

    it('getPlugin 返回插件实例', async () => {
      const file = await writeFile('get.js', VALID_PLUGIN_JS);
      const loaded = await loader.loadFromFile(file);

      const got = loader.getPlugin('test-plugin');
      expect(got).toBe(loaded);
    });

    it('getPlugin 未加载返回 undefined', () => {
      expect(loader.getPlugin('nonexistent')).toBeUndefined();
    });
  });

  // ----- reload（通过 unload + loadFromFile 组合） -----

  describe('reload 场景', () => {
    it('unload 后可重新加载同名插件', async () => {
      const file = await writeFile('reload.js', VALID_PLUGIN_JS);
      const p1 = await loader.loadFromFile(file);
      await loader.unload(p1);
      const p2 = await loader.loadFromFile(file);
      expect(p2.name).toBe('test-plugin');
      expect(loader.listLoaded()).toHaveLength(1);
    });
  });
});

// ============================================================
// createDefaultPluginContext
// ============================================================

describe('createDefaultPluginContext', () => {
  it('返回带 logger/config/cwd/readFile/writeFile 的上下文', () => {
    const ctx = createDefaultPluginContext('/some/cwd', { key: 'value' });
    expect(ctx.cwd).toBe('/some/cwd');
    expect(ctx.config).toEqual({ key: 'value' });
    expect(typeof ctx.logger.info).toBe('function');
    expect(typeof ctx.logger.warn).toBe('function');
    expect(typeof ctx.logger.error).toBe('function');
    expect(typeof ctx.logger.debug).toBe('function');
    expect(typeof ctx.readFile).toBe('function');
    expect(typeof ctx.writeFile).toBe('function');
  });

  it('logger 调用不抛错', () => {
    const ctx = createDefaultPluginContext('/cwd');
    expect(() => {
      ctx.logger.info('test');
      ctx.logger.warn('test');
      ctx.logger.error('test');
      ctx.logger.debug('test');
    }).not.toThrow();
  });

  it('readFile/writeFile 实际读写文件', async () => {
    const ctx = createDefaultPluginContext(tempDir);
    const filePath = path.join(tempDir, 'rw-test.txt');
    await ctx.writeFile(filePath, 'hello');
    const content = await ctx.readFile(filePath);
    expect(content).toBe('hello');
  });
});
