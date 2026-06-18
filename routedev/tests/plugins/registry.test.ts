// tests/plugins/registry.test.ts
// PluginRegistry 单元测试（Phase 22）
// 覆盖：discover / loadPlugin / initAll / enable / disable / destroyAll

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { AgentMiddlewarePipeline } from '../../src/agent/middleware.js';
import { defineToolPlugin, defineHookPlugin } from '../../src/plugins/sdk.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 创建临时插件目录结构 */
async function setupPluginDir(
  root: string,
  plugins: Array<{ dirName: string; manifest: Record<string, unknown>; entryContent: string }>,
): Promise<void> {
  for (const p of plugins) {
    const pluginDir = join(root, p.dirName);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'routedev-plugin.json'), JSON.stringify(p.manifest, null, 2));
    await writeFile(join(pluginDir, p.manifest.entry as string), p.entryContent);
  }
}

/** 创建一个有效的 tool 插件 entry 文件内容 */
function makeToolPluginEntry(pluginName: string, toolName: string): string {
  return `
export default {
  id: 'tool-${pluginName}',
  name: '${pluginName}',
  version: '1.0.0',
  type: 'tool',
  enabled: true,
  async init() {},
  async destroy() {},
  getTools() {
    return [{
      definition: {
        name: '${toolName}',
        description: '测试工具 ${toolName}',
        parameters: { type: 'object', properties: {} },
        requiresApproval: false,
        category: 'system',
      },
      async execute() { return { success: true, output: 'ok', durationMs: 0 }; },
      validateArgs() { return { valid: true, errors: [] }; },
    }];
  },
};
`;
}

function makeRegistry(globalDirs: string[], projectDir: string): PluginRegistry {
  return new PluginRegistry({
    globalPluginDirs: globalDirs,
    projectPluginDir: projectDir,
    toolRegistry: new ToolRegistry(),
    middlewarePipeline: new AgentMiddlewarePipeline(),
    cwd: '/test',
  });
}

describe('PluginRegistry', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'routedev-plugin-test-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  // 测试 5：discover() 空目录返回空数组，不抛异常
  it('discover() 空目录返回空数组', async () => {
    const globalDir = join(tempRoot, 'global');
    const projectDir = join(tempRoot, 'project');
    await mkdir(globalDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });

    const reg = makeRegistry([globalDir], projectDir);
    const manifests = await reg.discover();
    expect(manifests).toEqual([]);
  });

  // 测试 6：discover() 含无效清单时跳过无效项，返回有效清单
  it('discover() 含无效清单时跳过无效项', async () => {
    const globalDir = join(tempRoot, 'global');
    await mkdir(join(globalDir, 'valid-plugin'), { recursive: true });
    await writeFile(
      join(globalDir, 'valid-plugin', 'routedev-plugin.json'),
      JSON.stringify({ id: 'tool-valid', name: 'valid', version: '1.0.0', type: 'tool', entry: 'index.js' }),
    );
    await writeFile(
      join(globalDir, 'valid-plugin', 'index.js'),
      makeToolPluginEntry('valid', 'valid_tool'),
    );

    // 无效清单：缺 type 字段
    await mkdir(join(globalDir, 'invalid-plugin'), { recursive: true });
    await writeFile(
      join(globalDir, 'invalid-plugin', 'routedev-plugin.json'),
      JSON.stringify({ id: 'invalid', name: 'invalid', version: '1.0.0', entry: 'index.js' }),
    );

    const projectDir = join(tempRoot, 'project');
    await mkdir(projectDir, { recursive: true });

    const reg = makeRegistry([globalDir], projectDir);
    const manifests = await reg.discover();
    expect(manifests).toHaveLength(1);
    expect(manifests[0].id).toBe('tool-valid');
  });

  // 测试 7：loadPlugin() 入口文件不存在时 status.error 有值，进程不崩溃
  it('loadPlugin() 入口文件不存在时记录 error', async () => {
    const projectDir = join(tempRoot, 'project');
    await mkdir(projectDir, { recursive: true });

    const reg = makeRegistry([], projectDir);
    const manifest = {
      id: 'missing-entry',
      name: 'missing',
      version: '1.0.0',
      type: 'tool',
      entry: 'nonexistent.js',
    };
    await reg.loadPlugin(manifest, projectDir);

    const status = reg.getPluginStatus('missing-entry');
    expect(status).not.toBeNull();
    expect(status?.loaded).toBe(false);
    expect(status?.error).toBeTruthy();
  });

  // 测试 8：initAll() 单个插件 init 抛异常时其他插件正常初始化
  it('initAll() 单个插件 init 抛异常不阻塞其他', async () => {
    const globalDir = join(tempRoot, 'global');
    await setupPluginDir(globalDir, [
      {
        dirName: 'good-plugin',
        manifest: { id: 'tool-good', name: 'good', version: '1.0.0', type: 'tool', entry: 'index.js' },
        entryContent: makeToolPluginEntry('good', 'good_tool'),
      },
      {
        dirName: 'bad-plugin',
        manifest: { id: 'tool-bad', name: 'bad', version: '1.0.0', type: 'tool', entry: 'index.js' },
        entryContent: `
export default {
  id: 'tool-bad', name: 'bad', version: '1.0.0', type: 'tool', enabled: true,
  async init() { throw new Error('init failed on purpose'); },
  async destroy() {},
  getTools() { return []; },
};
`,
      },
    ]);

    const projectDir = join(tempRoot, 'project');
    await mkdir(projectDir, { recursive: true });

    const reg = makeRegistry([globalDir], projectDir);
    const manifests = await reg.discover();
    for (const m of manifests) {
      await reg.loadPlugin(m, (m as any)._pluginDir);
    }
    await reg.initAll();

    const goodStatus = reg.getPluginStatus('tool-good');
    expect(goodStatus?.loaded).toBe(true);
    expect(goodStatus?.error).toBeUndefined();

    const badStatus = reg.getPluginStatus('tool-bad');
    expect(badStatus?.loaded).toBe(false);
    expect(badStatus?.error).toContain('init failed');
  });

  // 测试 9：enable/disable 状态切换正确，ToolPlugin 的工具注册/注销
  it('enable/disable 切换状态并注册/注销工具', async () => {
    const toolRegistry = new ToolRegistry();
    const middlewarePipeline = new AgentMiddlewarePipeline();
    const projectDir = join(tempRoot, 'project');
    await mkdir(projectDir, { recursive: true });

    const reg = new PluginRegistry({
      globalPluginDirs: [],
      projectPluginDir: projectDir,
      toolRegistry,
      middlewarePipeline,
      cwd: '/test',
    });

    // 直接加载一个 SDK 创建的插件（不走 discover）
    const toolPlugin = defineToolPlugin('toggle', [
      {
        name: 'toggle_tool',
        description: '可切换工具',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ success: true, output: 'ok', durationMs: 0 }),
      },
    ]);

    const manifest = {
      id: 'tool-toggle',
      name: 'toggle',
      version: '1.0.0',
      type: 'tool' as const,
      entry: 'index.js',
    };
    // 用 loadPlugin 需要 import，这里直接注入：模拟已加载状态
    // 改用动态 import 方式：写文件后加载
    const pluginDir = join(projectDir, 'toggle-plugin');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'routedev-plugin.json'), JSON.stringify(manifest));
    await writeFile(
      join(pluginDir, 'index.js'),
      makeToolPluginEntry('toggle', 'toggle_tool'),
    );

    const manifests = await reg.discover();
    expect(manifests).toHaveLength(1);
    await reg.loadPlugin(manifests[0], (manifests[0] as any)._pluginDir);
    await reg.initAll();

    // 初始：已启用，工具已注册
    expect(toolRegistry.has('toggle_tool')).toBe(true);
    expect(reg.getPluginStatus('tool-toggle')?.enabled).toBe(true);

    // disable：工具注销
    const disabled = reg.disable('tool-toggle');
    expect(disabled).toBe(true);
    expect(toolRegistry.has('toggle_tool')).toBe(false);
    expect(reg.getPluginStatus('tool-toggle')?.enabled).toBe(false);

    // enable：工具重新注册
    const enabled = reg.enable('tool-toggle');
    expect(enabled).toBe(true);
    expect(toolRegistry.has('toggle_tool')).toBe(true);
    expect(reg.getPluginStatus('tool-toggle')?.enabled).toBe(true);
  });

  // 测试 10：destroyAll() 逆序调用 destroy
  it('destroyAll() 按注册逆序销毁', async () => {
    const projectDir = join(tempRoot, 'project');
    await mkdir(projectDir, { recursive: true });

    const toolRegistry = new ToolRegistry();
    const middlewarePipeline = new AgentMiddlewarePipeline();
    const reg = new PluginRegistry({
      globalPluginDirs: [],
      projectPluginDir: projectDir,
      toolRegistry,
      middlewarePipeline,
      cwd: '/test',
    });

    const destroyOrder: string[] = [];

    // 创建 3 个插件目录
    await setupPluginDir(projectDir, [
      {
        dirName: 'p1',
        manifest: { id: 'tool-p1', name: 'p1', version: '1.0.0', type: 'tool', entry: 'index.js' },
        entryContent: `
export default {
  id: 'tool-p1', name: 'p1', version: '1.0.0', type: 'tool', enabled: true,
  async init() {}, async destroy() { globalThis.__destroyOrder?.push('p1'); },
  getTools() { return []; },
};
`,
      },
      {
        dirName: 'p2',
        manifest: { id: 'tool-p2', name: 'p2', version: '1.0.0', type: 'tool', entry: 'index.js' },
        entryContent: `
export default {
  id: 'tool-p2', name: 'p2', version: '1.0.0', type: 'tool', enabled: true,
  async init() {}, async destroy() { globalThis.__destroyOrder?.push('p2'); },
  getTools() { return []; },
};
`,
      },
      {
        dirName: 'p3',
        manifest: { id: 'tool-p3', name: 'p3', version: '1.0.0', type: 'tool', entry: 'index.js' },
        entryContent: `
export default {
  id: 'tool-p3', name: 'p3', version: '1.0.0', type: 'tool', enabled: true,
  async init() {}, async destroy() { globalThis.__destroyOrder?.push('p3'); },
  getTools() { return []; },
};
`,
      },
    ]);

    (globalThis as any).__destroyOrder = destroyOrder;

    const manifests = await reg.discover();
    for (const m of manifests) {
      await reg.loadPlugin(m, (m as any)._pluginDir);
    }
    await reg.initAll();
    await reg.destroyAll();

    // 逆序：p3, p2, p1
    expect(destroyOrder).toEqual(['p3', 'p2', 'p1']);

    delete (globalThis as any).__destroyOrder;
  });
});
