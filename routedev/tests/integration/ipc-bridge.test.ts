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
    // 先创建一个 Hook（使用模板匹配的描述）
    const createResult = await engine.createHook('保存文件后自动格式化');
    expect(createResult.success).toBe(true);
    expect(createResult.hookId).toBeTruthy();

    // 切换为禁用
    const toggleResult = await engine.toggleHook(createResult.hookId!, false);
    expect(toggleResult.success).toBe(true);

    // 验证状态已变更
    const list = await engine.listHooks() as Array<{ id: string; enabled: boolean }>;
    const hook = list.find(h => h.id === createResult.hookId);
    expect(hook).toBeDefined();
    expect(hook!.enabled).toBe(false);
  });

  it('14. deleteHook 删除后列表减少', async () => {
    // 先创建一个 Hook
    const createResult = await engine.createHook('保存文件后自动格式化');
    expect(createResult.success).toBe(true);
    const hookId = createResult.hookId!;

    // 确认列表中有该 Hook
    const listBefore = await engine.listHooks() as Array<{ id: string }>;
    expect(listBefore.some(h => h.id === hookId)).toBe(true);

    // 删除
    const deleteResult = await engine.deleteHook(hookId);
    expect(deleteResult.success).toBe(true);

    // 确认列表中不再有该 Hook
    const listAfter = await engine.listHooks() as Array<{ id: string }>;
    expect(listAfter.some(h => h.id === hookId)).toBe(false);
    expect(listAfter.length).toBe(listBefore.length - 1);
  });

  it('15. createHook 生成新 Hook', async () => {
    // 使用模板匹配的描述（auto-format 模板）
    const result = await engine.createHook('保存文件后自动格式化');
    expect(result.success).toBe(true);
    expect(result.hookId).toBeTruthy();
    expect(typeof result.hookId).toBe('string');

    // 验证 Hook 已持久化
    const list = await engine.listHooks() as Array<{ id: string; name: string }>;
    const created = list.find(h => h.id === result.hookId);
    expect(created).toBeDefined();
  });
});
