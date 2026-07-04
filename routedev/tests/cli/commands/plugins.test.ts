// tests/cli/commands/plugins.test.ts
// /plugins 命令单元测试
// 覆盖：list / load / unload / reload / 用法提示

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  pluginsCommand,
  _resetPluginLoaderForTesting,
} from '../../../src/cli/commands/plugins.js';
import type { ServiceContext } from '../../../src/cli/service-context.js';

// ============================================================
// 临时目录管理
// ============================================================

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-plugins-cmd-'));
  // 每个测试前重置单例，避免相互污染
  _resetPluginLoaderForTesting();
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ============================================================
// Mock ServiceContext
// ============================================================

function buildMockCtx(cwd: string): ServiceContext {
  return {
    config: {} as any,
    clientManager: {} as any,
    router: {} as any,
    tracker: {} as any,
    agentLoop: {} as any,
    checkpointWriter: {} as any,
    checkpointManager: {} as any,
    contextManager: {} as any,
    branchManager: {} as any,
    vision: {} as any,
    initAnalyzer: {} as any,
    goalParser: {} as any,
    goalVerifier: {} as any,
    blackboard: {} as any,
    orchestrator: {} as any,
    workerExecutor: {} as any,
    trace: {} as any,
    audit: {} as any,
    prompts: {} as any,
    projectMemory: {} as any,
    toolExecutor: {} as any,
    setToolExecutor: () => {},
    mcpManager: {} as any,
    commandBridge: {} as any,
    sessionId: 'test',
    cwd,
  } as ServiceContext;
}

// ============================================================
// 测试桩插件
// ============================================================

const VALID_PLUGIN_JS = `
export default {
  name: 'cmd-test-plugin',
  version: '1.2.3',
  description: 'plugin for /plugins command test',
  onLoad() {},
  onUnload() {}
};
`;

async function writePlugin(name: string, content: string = VALID_PLUGIN_JS): Promise<string> {
  const p = path.join(tempDir, name);
  await fs.writeFile(p, content, 'utf-8');
  return p;
}

// ============================================================
// 测试
// ============================================================

describe('/plugins 命令', () => {
  // ----- list -----

  describe('list', () => {
    it('无插件时返回提示', async () => {
      const ctx = buildMockCtx(tempDir);
      const result = await pluginsCommand.handler('list', ctx);

      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('暂无');
    });

    it('无参数默认执行 list', async () => {
      const ctx = buildMockCtx(tempDir);
      const result = await pluginsCommand.handler('', ctx);

      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('暂无');
    });

    it('已加载插件时返回列表', async () => {
      const file = await writePlugin('p.js');
      const ctx = buildMockCtx(tempDir);

      // 先 load
      const loadResult = await pluginsCommand.handler(`load ${file}`, ctx);
      expect(loadResult.messages![0]).toContain('成功');

      // 再 list
      const listResult = await pluginsCommand.handler('list', ctx);
      expect(listResult.type).toBe('handled');
      const msg = listResult.messages![0];
      expect(msg).toContain('cmd-test-plugin');
      expect(msg).toContain('1.2.3');
      expect(msg).toContain(file);
    });
  });

  // ----- load -----

  describe('load', () => {
    it('加载合法插件', async () => {
      const file = await writePlugin('load.js');
      const ctx = buildMockCtx(tempDir);

      const result = await pluginsCommand.handler(`load ${file}`, ctx);
      expect(result.type).toBe('handled');
      const msg = result.messages![0];
      expect(msg).toContain('cmd-test-plugin');
      expect(msg).toContain('1.2.3');
    });

    it('描述被包含在结果中', async () => {
      const file = await writePlugin('with-desc.js');
      const ctx = buildMockCtx(tempDir);

      const result = await pluginsCommand.handler(`load ${file}`, ctx);
      expect(result.messages![1]).toContain('plugin for /plugins command test');
    });

    it('缺少 path 参数返回用法', async () => {
      const ctx = buildMockCtx(tempDir);
      const result = await pluginsCommand.handler('load', ctx);
      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('用法');
    });

    it('加载不存在的文件返回错误', async () => {
      const ctx = buildMockCtx(tempDir);
      const result = await pluginsCommand.handler(
        `load ${path.join(tempDir, 'nope.js')}`,
        ctx,
      );
      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('失败');
    });

    it('加载无效插件（缺 name）返回错误', async () => {
      const file = await writePlugin(
        'bad.js',
        `export default { version: '1.0.0' };`,
      );
      const ctx = buildMockCtx(tempDir);
      const result = await pluginsCommand.handler(`load ${file}`, ctx);
      expect(result.messages![0]).toContain('失败');
      expect(result.messages![0]).toContain('name');
    });
  });

  // ----- unload -----

  describe('unload', () => {
    it('卸载已加载插件', async () => {
      const file = await writePlugin('unload.js');
      const ctx = buildMockCtx(tempDir);

      await pluginsCommand.handler(`load ${file}`, ctx);
      const result = await pluginsCommand.handler('unload cmd-test-plugin', ctx);

      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('已卸载');
      expect(result.messages![0]).toContain('cmd-test-plugin');

      // 验证已从列表中消失
      const listResult = await pluginsCommand.handler('list', ctx);
      expect(listResult.messages![0]).toContain('暂无');
    });

    it('缺少 name 参数返回用法', async () => {
      const ctx = buildMockCtx(tempDir);
      const result = await pluginsCommand.handler('unload', ctx);
      expect(result.messages![0]).toContain('用法');
    });

    it('卸载未加载的插件返回错误', async () => {
      const ctx = buildMockCtx(tempDir);
      const result = await pluginsCommand.handler('unload never-loaded', ctx);
      expect(result.messages![0]).toContain('失败');
    });
  });

  // ----- reload -----

  describe('reload', () => {
    it('重新加载已加载插件', async () => {
      const file = await writePlugin('reload.js');
      const ctx = buildMockCtx(tempDir);

      await pluginsCommand.handler(`load ${file}`, ctx);
      const result = await pluginsCommand.handler('reload cmd-test-plugin', ctx);

      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('重新加载');
      expect(result.messages![0]).toContain('cmd-test-plugin');

      // 验证仍在列表中
      const listResult = await pluginsCommand.handler('list', ctx);
      expect(listResult.messages![0]).toContain('cmd-test-plugin');
    });

    it('缺少 name 参数返回用法', async () => {
      const ctx = buildMockCtx(tempDir);
      const result = await pluginsCommand.handler('reload', ctx);
      expect(result.messages![0]).toContain('用法');
    });

    it('reload 未加载的插件返回错误', async () => {
      const ctx = buildMockCtx(tempDir);
      const result = await pluginsCommand.handler('reload never-loaded', ctx);
      expect(result.messages![0]).toContain('未加载');
    });
  });

  // ----- 未知子命令 -----

  describe('未知子命令', () => {
    it('返回用法提示', async () => {
      const ctx = buildMockCtx(tempDir);
      const result = await pluginsCommand.handler('unknown-sub', ctx);
      expect(result.type).toBe('handled');
      expect(result.messages![0]).toContain('用法');
    });
  });

  // ----- 命令元数据 -----

  describe('命令元数据', () => {
    it('命令名为 plugins', () => {
      expect(pluginsCommand.name).toBe('plugins');
    });

    it('有 description', () => {
      expect(pluginsCommand.description).toBeTruthy();
    });

    it('有 usage', () => {
      expect(pluginsCommand.usage).toBeTruthy();
      expect(pluginsCommand.usage).toContain('load');
      expect(pluginsCommand.usage).toContain('unload');
      expect(pluginsCommand.usage).toContain('reload');
    });
  });
});
