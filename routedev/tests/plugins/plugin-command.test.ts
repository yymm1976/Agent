// tests/plugins/plugin-command.test.ts
// /plugin 命令测试（Phase 22）
// 覆盖：/plugin list 和 /plugin info <name>

import { describe, it, expect, beforeAll } from 'vitest';
import { pluginCommand } from '../../src/cli/commands/plugin.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { AgentMiddlewarePipeline } from '../../src/agent/middleware.js';
import type { ServiceContext } from '../../src/cli/service-context.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures');

function buildMockCtx(pluginRegistry?: PluginRegistry): ServiceContext {
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
    dream: {} as any,
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
    cwd: '/test',
    ...(pluginRegistry ? { pluginRegistry } : {}),
  } as ServiceContext;
}

describe('/plugin 命令', () => {
  // 测试 12：/plugin list 返回 handled + 插件列表字符串
  it('/plugin list 返回 handled + 插件列表', async () => {
    const toolRegistry = new ToolRegistry();
    const middlewarePipeline = new AgentMiddlewarePipeline();
    const reg = new PluginRegistry({
      globalPluginDirs: [fixturesDir],
      projectPluginDir: join(fixturesDir, 'nonexistent'),
      toolRegistry,
      middlewarePipeline,
      cwd: '/test',
    });

    const manifests = await reg.discover();
    for (const m of manifests) {
      await reg.loadPlugin(m, (m as any)._pluginDir);
    }
    await reg.initAll();

    const ctx = buildMockCtx(reg);
    const result = await pluginCommand.handler('list', ctx);

    expect(result.type).toBe('handled');
    expect(result.messages).toBeDefined();
    expect(result.messages![0]).toContain('已安装插件');
    expect(result.messages![0]).toContain('Sample');

    await reg.destroyAll();
  });

  // 测试 13：/plugin info <name> 返回插件详情
  it('/plugin info <name> 返回插件详情', async () => {
    const toolRegistry = new ToolRegistry();
    const middlewarePipeline = new AgentMiddlewarePipeline();
    const reg = new PluginRegistry({
      globalPluginDirs: [fixturesDir],
      projectPluginDir: join(fixturesDir, 'nonexistent'),
      toolRegistry,
      middlewarePipeline,
      cwd: '/test',
    });

    const manifests = await reg.discover();
    for (const m of manifests) {
      await reg.loadPlugin(m, (m as any)._pluginDir);
    }
    await reg.initAll();

    const ctx = buildMockCtx(reg);
    const result = await pluginCommand.handler('info sample-tool', ctx);

    expect(result.type).toBe('handled');
    expect(result.messages).toBeDefined();
    const msg = result.messages![0];
    expect(msg).toContain('Sample');
    expect(msg).toContain('tool');
    expect(msg).toContain('sample_echo');

    await reg.destroyAll();
  });

  // 额外：插件系统未初始化时返回提示
  it('插件系统未初始化时返回提示', async () => {
    const ctx = buildMockCtx(undefined);
    const result = await pluginCommand.handler('list', ctx);
    expect(result.type).toBe('handled');
    expect(result.messages![0]).toContain('插件系统未初始化');
  });

  // 额外：/plugin enable/disable 用法提示
  it('/plugin enable 缺少参数时返回用法', async () => {
    // 需要提供 pluginRegistry，否则会先返回"插件系统未初始化"
    const toolRegistry = new ToolRegistry();
    const middlewarePipeline = new AgentMiddlewarePipeline();
    const reg = new PluginRegistry({
      globalPluginDirs: [],
      projectPluginDir: '/nonexistent',
      toolRegistry,
      middlewarePipeline,
      cwd: '/test',
    });
    const ctx = buildMockCtx(reg);
    const result = await pluginCommand.handler('enable', ctx);
    expect(result.type).toBe('handled');
    expect(result.messages![0]).toContain('用法');
  });
});
