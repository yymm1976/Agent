// tests/plugins/registry-persistence.test.ts
// Phase 27 Task 4：插件状态持久化测试
// 验证 initAll() 读取状态文件恢复 enable/disable，enable()/disable() 写入状态文件

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 部分模拟 paths 模块：仅 mock getAppDataDir，保留 ensureDir 真实实现
// 注意：logger.ts 在模块加载时调用 getAppDataDir()，所以 mock 必须返回有效路径
vi.mock('../../src/utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/paths.js')>();
  return {
    ...actual,
    getAppDataDir: vi.fn(() => join(tmpdir(), 'routedev-test-default')),
  };
});

import { PluginRegistry } from '../../src/plugins/registry.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { AgentMiddlewarePipeline } from '../../src/agent/middleware.js';
import { defineToolPlugin } from '../../src/plugins/sdk.js';
import type { Plugin } from '../../src/plugins/types.js';
import { getAppDataDir } from '../../src/utils/paths.js';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** 创建一个空 PluginRegistry */
function makeRegistry(): PluginRegistry {
  return new PluginRegistry({
    globalPluginDirs: [],
    projectPluginDir: '/nonexistent',
    toolRegistry: new ToolRegistry(),
    middlewarePipeline: new AgentMiddlewarePipeline(),
    cwd: '/test',
  });
}

/** 通过反射注入插件（绕过 discover/loadPlugin 流程） */
function injectPlugin(reg: PluginRegistry, plugin: Plugin): void {
  (reg as unknown as { plugins: Map<string, unknown> }).plugins.set(plugin.id, {
    instance: plugin,
    manifest: {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      type: plugin.type,
      entry: 'index.js',
    },
    pluginDir: '/test',
    loaded: false,
    registeredToolNames: [],
    registeredHookPhases: [],
    registeredHookHandlers: [],
  });
  (reg as unknown as { loadOrder: string[] }).loadOrder.push(plugin.id);
}

describe('Phase 27 Task 4: 插件状态持久化', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'routedev-state-test-'));
    vi.mocked(getAppDataDir).mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // 测试 1：initAll() 启动时读取状态文件，恢复各插件的 enable/disable 状态
  it('initAll() 启动时读取状态文件，恢复各插件的 enable/disable 状态', async () => {
    // 1. 预写状态文件：tool-persist-test 设为 disabled
    const stateFile = join(tempDir, 'plugin-state.json');
    await writeFile(stateFile, JSON.stringify({
      plugins: {
        'tool-persist-test': { enabled: false },
      },
      updatedAt: Date.now(),
    }));

    // 2. 创建 registry 并注入插件（默认 enabled=true）
    const reg = makeRegistry();
    injectPlugin(reg, defineToolPlugin('persist-test', []));

    // 3. initAll() 应读取状态文件并恢复 enabled=false
    await reg.initAll();

    // 4. 验证插件状态被恢复为 disabled
    const status = reg.getPluginStatus('tool-persist-test');
    expect(status).not.toBeNull();
    expect(status?.enabled).toBe(false);
    expect(status?.loaded).toBe(true); // init 仍正常执行
  });

  // 测试 2：enable() 和 disable() 调用后自动写入状态文件
  it('enable() 和 disable() 调用后自动写入状态文件', async () => {
    const reg = makeRegistry();
    injectPlugin(reg, defineToolPlugin('persist-test', []));
    await reg.initAll();

    // 初始状态：enabled=true，状态文件不存在（initAll 未写入）
    expect(reg.getPluginStatus('tool-persist-test')?.enabled).toBe(true);

    // disable() 应触发写入
    reg.disable('tool-persist-test');
    const stateFile = join(tempDir, 'plugin-state.json');
    expect(existsSync(stateFile)).toBe(true);

    // 验证文件内容
    const raw = await readFile(stateFile, 'utf-8');
    const state = JSON.parse(raw);
    expect(state.plugins['tool-persist-test'].enabled).toBe(false);
    expect(state.updatedAt).toBeGreaterThan(0);

    // enable() 应再次触发写入
    reg.enable('tool-persist-test');
    const raw2 = await readFile(stateFile, 'utf-8');
    const state2 = JSON.parse(raw2);
    expect(state2.plugins['tool-persist-test'].enabled).toBe(true);
  });

  // 测试 3：状态文件损坏时 fallback 到默认全启用
  it('状态文件损坏（非法 JSON）时 fallback 到默认全启用', async () => {
    // 预写损坏的状态文件
    const stateFile = join(tempDir, 'plugin-state.json');
    await writeFile(stateFile, '{ this is not valid json }}}');

    const reg = makeRegistry();
    injectPlugin(reg, defineToolPlugin('persist-test', []));
    await reg.initAll();

    // 损坏文件 → fallback 到默认 → enabled=true
    const status = reg.getPluginStatus('tool-persist-test');
    expect(status?.enabled).toBe(true);
    expect(status?.loaded).toBe(true);
  });

  // 测试 4：状态文件缺少 plugins 字段时 fallback 到默认
  it('状态文件缺少 plugins 字段时 fallback 到默认', async () => {
    const stateFile = join(tempDir, 'plugin-state.json');
    await writeFile(stateFile, JSON.stringify({ updatedAt: 123 }));

    const reg = makeRegistry();
    injectPlugin(reg, defineToolPlugin('persist-test', []));
    await reg.initAll();

    // 缺少 plugins 字段 → fallback 到默认 → enabled=true
    const status = reg.getPluginStatus('tool-persist-test');
    expect(status?.enabled).toBe(true);
  });

  // 测试 5：状态文件不存在时保持默认状态（不报错）
  it('状态文件不存在时保持默认状态', async () => {
    const reg = makeRegistry();
    injectPlugin(reg, defineToolPlugin('persist-test', []));
    await reg.initAll();

    // 无状态文件 → 默认 enabled=true
    const status = reg.getPluginStatus('tool-persist-test');
    expect(status?.enabled).toBe(true);
    expect(status?.loaded).toBe(true);
  });

  // 测试 6：getStateFilePath() 返回 getAppDataDir()/plugin-state.json
  it('getStateFilePath() 返回正确的路径', () => {
    const reg = makeRegistry();
    const path = reg.getStateFilePath();
    expect(path).toBe(join(tempDir, 'plugin-state.json'));
  });
});
