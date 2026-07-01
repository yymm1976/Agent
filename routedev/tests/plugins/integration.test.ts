// tests/plugins/integration.test.ts
// 集成测试：加载 sample-plugin 并验证工具注册（Phase 22）

import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { AgentMiddlewarePipeline } from '../../src/agent/middleware.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures');

describe('Plugin 集成测试', () => {
  // 测试 11：加载 sample tool plugin → ToolRegistry.has(pluginToolName) === true
  it('加载 sample-plugin 后工具注册到 ToolRegistry', async () => {
    const toolRegistry = new ToolRegistry();
    const middlewarePipeline = new AgentMiddlewarePipeline();

    const reg = new PluginRegistry({
      globalPluginDirs: [fixturesDir],
      projectPluginDir: join(fixturesDir, 'nonexistent-project-dir'),
      toolRegistry,
      middlewarePipeline,
      cwd: '/test',
    });

    // 发现 + 加载 + 初始化
    const manifests = await reg.discover();
    expect(manifests.length).toBeGreaterThan(0);
    const sampleManifest = manifests.find(m => m.id === 'tool-sample');
    expect(sampleManifest).toBeDefined();

    for (const m of manifests) {
      await reg.loadPlugin(m, (m as any)._pluginDir);
    }
    await reg.initAll();
    reg.enable('tool-sample');

    // 验证工具已注册
    expect(toolRegistry.has('sample_echo')).toBe(true);

    // 验证状态
    const status = reg.getPluginStatus('tool-sample');
    expect(status?.loaded).toBe(true);
    expect(status?.enabled).toBe(true);
    expect(status?.registeredTools).toContain('sample_echo');

    // 验证工具可执行
    const tool = toolRegistry.get('sample_echo');
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { message: 'hello' },
      {
        workingDirectory: '/test',
        allowedDirectories: ['/test'],
        environment: {},
        timeoutMs: 5000,
      },
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello');

    // 清理
    await reg.destroyAll();
  });
});
