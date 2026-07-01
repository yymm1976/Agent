// tests/agents/instance-harness.test.ts
// Phase 51 Task 6：三层抽象 Instance/Harness/Session 单元测试
//
// 覆盖关键能力：
//   1. createSessionStorageKey / parseSessionStorageKey 三元组编解码
//   2. HarnessScope.abort 级联取消子 scope / 不影响父 scope
//   3. createDefaultInstance 生成默认 Instance
//
// 全部为纯函数测试，不依赖 LLM 或文件系统。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSessionStorageKey,
  parseSessionStorageKey,
  HarnessScope,
  createDefaultInstance,
  createHarness,
  type AgentInstance,
} from '../../src/agents/instance-harness.js';

describe('Phase 51 Task 6: instance-harness 单元测试', () => {
  beforeEach(() => {
    // 纯函数 / 局部对象，无外部状态需要重置
  });

  // ============================================================
  // 1. createSessionStorageKey / parseSessionStorageKey
  // ============================================================

  it('1.1 createSessionStorageKey: 生成 instanceId/harnessName/sessionName 格式', () => {
    const key = createSessionStorageKey('inst-1', 'default', 'task-abc');
    expect(key).toBe('inst-1/default/task-abc');
    expect(key.split('/')).toHaveLength(3);
  });

  it('1.2 parseSessionStorageKey: 正确解析三元组', () => {
    const parsed = parseSessionStorageKey('inst-1/default/task-abc');
    expect(parsed).not.toBeNull();
    expect(parsed!.instanceId).toBe('inst-1');
    expect(parsed!.harnessName).toBe('default');
    expect(parsed!.sessionName).toBe('task-abc');
  });

  it('1.3 parseSessionStorageKey: 段数不为 3 时返回 null', () => {
    expect(parseSessionStorageKey('only-one-segment')).toBeNull();
    expect(parseSessionStorageKey('two/segments')).toBeNull();
    expect(parseSessionStorageKey('four/segments/here/extra')).toBeNull();
    expect(parseSessionStorageKey('')).toBeNull();
  });

  it('1.4 parseSessionStorageKey: 存在空段时返回 null', () => {
    // 中间段为空
    expect(parseSessionStorageKey('inst-1//task-abc')).toBeNull();
    // 首段为空
    expect(parseSessionStorageKey('/default/task-abc')).toBeNull();
    // 末段为空
    expect(parseSessionStorageKey('inst-1/default/')).toBeNull();
  });

  it('1.5 createSessionStorageKey 与 parseSessionStorageKey 互逆', () => {
    const cases = [
      { instanceId: 'i1', harnessName: 'h1', sessionName: 's1' },
      { instanceId: 'project-a', harnessName: 'default', sessionName: 'task-123' },
      { instanceId: 'inst_xyz', harnessName: 'harness_abc', sessionName: 'session_def' },
    ];
    for (const c of cases) {
      const key = createSessionStorageKey(c.instanceId, c.harnessName, c.sessionName);
      const parsed = parseSessionStorageKey(key);
      expect(parsed).toEqual(c);
    }
  });

  // ============================================================
  // 2. HarnessScope.abort 级联取消
  // ============================================================

  it('2.1 HarnessScope.abort: 级联取消子 scope', () => {
    const root = new HarnessScope();
    const child = root.createChild();
    const grandChild = child.createChild();

    expect(root.signal.aborted).toBe(false);
    expect(child.signal.aborted).toBe(false);
    expect(grandChild.signal.aborted).toBe(false);

    root.abort('cancelled');

    expect(root.signal.aborted).toBe(true);
    expect(child.signal.aborted).toBe(true);
    expect(grandChild.signal.aborted).toBe(true);
    // reason 应被传递
    expect(root.signal.reason).toBe('cancelled');
  });

  it('2.2 HarnessScope.abort: 不影响父 scope', () => {
    const root = new HarnessScope();
    const child = root.createChild();

    child.abort('child cancelled');

    // 子被取消
    expect(child.signal.aborted).toBe(true);
    // 父不受影响
    expect(root.signal.aborted).toBe(false);
  });

  it('2.3 HarnessScope.abort: 清理子 scope 引用，避免重复 abort 遍历已取消的子 scope', () => {
    const root = new HarnessScope();
    const child = root.createChild();
    const grandChild = child.createChild();

    root.abort('first cancel');

    // 重复 abort 不应抛错
    expect(() => root.abort('second cancel')).not.toThrow();
    // 子 scope 仍处于已取消状态
    expect(child.signal.aborted).toBe(true);
    expect(grandChild.signal.aborted).toBe(true);
  });

  // ============================================================
  // 3. createDefaultInstance / createHarness
  // ============================================================

  it('3.1 createDefaultInstance: 生成 id="default" 的 AgentInstance', () => {
    const instance = createDefaultInstance('/path/to/project');
    expect(instance.id).toBe('default');
    expect(instance.projectPath).toBe('/path/to/project');
    expect(instance.createdAt).toBeGreaterThan(0);
  });

  it('3.2 createHarness: 使用 Instance 初始化 harness', () => {
    const instance: AgentInstance = createDefaultInstance('/project');
    const harness = createHarness(instance, 'default', 'gpt-5.4');
    expect(harness.instanceId).toBe('default');
    expect(harness.name).toBe('default');
    expect(harness.modelId).toBe('gpt-5.4');
    expect(harness.scopeAbortController).toBeInstanceOf(AbortController);
    expect(harness.createdAt).toBeGreaterThan(0);
    // toolRegistry / skills / filesystem 留空待后续 Phase 接入
    expect(harness.toolRegistry).toBeNull();
    expect(harness.skills).toBeNull();
    expect(harness.filesystem).toBeNull();
  });
});
