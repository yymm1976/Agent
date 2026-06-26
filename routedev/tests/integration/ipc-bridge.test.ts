// tests/integration/ipc-bridge.test.ts
// Phase 39：IPC 桥接集成测试
// 验证 RouteDevEngine 的 CodeGraph/Experiment/Hook 桥接方法
//
// 测试策略：
//   - 使用临时目录作为 cwd，避免污染真实项目
//   - 不调用 engine.initialize()（桥接方法不需要 LLM/MCP 等依赖）
//   - fail-open 验证：底层模块异常时返回默认值而非抛异常

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RouteDevEngine } from '../../desktop/main/engine-bridge.js';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';

// ============================================================
// 测试辅助
// ============================================================

/** 构造最小 EngineBridgeOptions */
function makeOptions(cwd: string) {
  return {
    cwd,
    onStream: () => {},
    onToolConfirmRequest: () => {},
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('IPC Bridge - RouteDevEngine 桥接方法 (Phase 39)', () => {
  let tmpDir: string;
  let engine: RouteDevEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-ipc-'));
    const config = AppConfigSchema.parse({}) as AppConfig;
    engine = new RouteDevEngine(config, makeOptions(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============================================================
  // CodeGraph
  // ============================================================

  it('7. getCodeGraphStatus 未安装时返回 { available: false }', () => {
    const status = engine.getCodeGraphStatus();
    expect(status.available).toBe(false);
    expect(status.indexed).toBe(false);
  });

  // ============================================================
  // Experiment
  // ============================================================

  it('8. listExperiments 返回数组', () => {
    const list = engine.listExperiments();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(0);
  });

  it('9. adoptExperiment 不存在的 id 返回 error', async () => {
    const result = await engine.adoptExperiment('exp-nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('exp-nonexistent');
  });

  it('10. discardExperiment 不存在的 id 返回 error', async () => {
    const result = await engine.discardExperiment('exp-nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('exp-nonexistent');
  });

  it('11. getExperimentDiff 返回 diff 结构', async () => {
    const result = await engine.getExperimentDiff('exp-nonexistent');
    expect(result).toHaveProperty('diff');
    expect(result).toHaveProperty('filesChanged');
    expect(result).toHaveProperty('error');
    expect(typeof result.diff).toBe('string');
    expect(typeof result.filesChanged).toBe('number');
    expect(result.filesChanged).toBe(0);
    expect(result.error).toBeTruthy();
  });

  // ============================================================
  // Hook
  // ============================================================

  it('12. listHooks 返回数组', async () => {
    const list = await engine.listHooks();
    expect(Array.isArray(list)).toBe(true);
  });

  it('13. toggleHook 切换状态', async () => {
    // Phase 50 Task 8：HookGenerator 已移除，手动创建 Hook 用于测试
    const { HookConfigRegistry } = await import('../../src/hooks/registry.js');
    const configPath = path.join(tmpDir, '.routedev', 'hooks.json');
    const registry = new HookConfigRegistry(configPath);
    await registry.load();
    const testHookId = 'test-hook-toggle';
    registry.add({
      id: testHookId,
      name: '测试Hook',
      enabled: true,
      event: 'post-tool-call',
      command: 'echo test',
      failBehavior: 'warn',
      isTemplate: false,
    });
    await registry.save();

    // 切换为禁用
    const toggleResult = await engine.toggleHook(testHookId, false);
    expect(toggleResult.success).toBe(true);

    // 验证状态已变更
    const list = await engine.listHooks() as Array<{ id: string; enabled: boolean }>;
    const hook = list.find(h => h.id === testHookId);
    expect(hook).toBeDefined();
    expect(hook!.enabled).toBe(false);
  });

  it('14. deleteHook 删除后列表减少', async () => {
    // Phase 50 Task 8：HookGenerator 已移除，手动创建 Hook 用于测试
    const { HookConfigRegistry } = await import('../../src/hooks/registry.js');
    const configPath = path.join(tmpDir, '.routedev', 'hooks.json');
    const registry = new HookConfigRegistry(configPath);
    await registry.load();
    const testHookId = 'test-hook-delete';
    registry.add({
      id: testHookId,
      name: '测试Hook',
      enabled: true,
      event: 'post-tool-call',
      command: 'echo test',
      failBehavior: 'warn',
      isTemplate: false,
    });
    await registry.save();

    // 确认列表中有该 Hook
    const listBefore = await engine.listHooks() as Array<{ id: string }>;
    expect(listBefore.some(h => h.id === testHookId)).toBe(true);

    // 删除
    const deleteResult = await engine.deleteHook(testHookId);
    expect(deleteResult.success).toBe(true);

    // 确认列表中不再有该 Hook
    const listAfter = await engine.listHooks() as Array<{ id: string }>;
    expect(listAfter.some(h => h.id === testHookId)).toBe(false);
    expect(listAfter.length).toBe(listBefore.length - 1);
  });

  it('15. createHook 生成新 Hook（Phase 50 Task 8：生成器已移除，返回失败）', async () => {
    // HookGenerator 已作为死代码移除，createHook 应返回失败
    const result = await engine.createHook('保存文件后自动格式化');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
