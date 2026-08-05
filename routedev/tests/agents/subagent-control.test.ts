// tests/agents/subagent-control.test.ts
// B-05B：list_agents / stop_agent 生命周期工具测试
import { describe, expect, it } from 'vitest';
import { SubagentRegistry } from '../../src/agents/subagent-registry.js';
import { createListAgentsTool, createStopAgentTool } from '../../src/tools/builtin/subagent-control.js';

function seedRegistry(registry: SubagentRegistry, id: string, extra: Partial<Parameters<SubagentRegistry['register']>[0]> = {}) {
  registry.register({
    childSessionId: id,
    parentSessionId: 'parent-1',
    description: `任务 ${id}`,
    subagentType: 'explore',
    status: 'running',
    ...extra,
  });
}

describe('B-05B list_agents', () => {
  it('空 registry 返回明确说明', async () => {
    const registry = new SubagentRegistry();
    const tool = createListAgentsTool(registry);
    const result = await tool.execute({}, {} as never);
    expect(result.success).toBe(true);
    expect(result.output).toContain('没有子 Agent');
  });

  it('列出登记的子 Agent（含状态与描述）', async () => {
    const registry = new SubagentRegistry();
    seedRegistry(registry, 'sub-1');
    registry.update('sub-1', { status: 'completed' });
    seedRegistry(registry, 'sub-2');
    const tool = createListAgentsTool(registry);
    const result = await tool.execute({}, {} as never);
    expect(result.output).toContain('sub-1');
    expect(result.output).toContain('completed');
    expect(result.output).toContain('sub-2');
    expect(result.output).toContain('running');
  });

  it('可按 parentSessionId 过滤', async () => {
    const registry = new SubagentRegistry();
    seedRegistry(registry, 'sub-a', { parentSessionId: 'parent-x' });
    seedRegistry(registry, 'sub-b', { parentSessionId: 'parent-y' });
    const tool = createListAgentsTool(registry);
    const result = await tool.execute({ parentSessionId: 'parent-x' }, {} as never);
    expect(result.output).toContain('sub-a');
    expect(result.output).not.toContain('sub-b');
  });
});

describe('B-05B stop_agent', () => {
  it('停止运行中的子 Agent：状态变为 aborted 且 abort 生效', async () => {
    const registry = new SubagentRegistry();
    const controller = seedRegistryWithController(registry, 'sub-run');
    const tool = createStopAgentTool(registry);
    const result = await tool.execute({ agentId: 'sub-run' }, {} as never);
    expect(result.success).toBe(true);
    expect(result.output).toContain('已请求停止');
    expect(controller.signal.aborted).toBe(true);
    expect(registry.get('sub-run')!.status).toBe('aborted');
  });

  it('对已完成的子 Agent 返回不在运行说明（不误报）', async () => {
    const registry = new SubagentRegistry();
    seedRegistry(registry, 'sub-done');
    registry.update('sub-done', { status: 'completed' });
    const tool = createStopAgentTool(registry);
    const result = await tool.execute({ agentId: 'sub-done' }, {} as never);
    expect(result.output).toContain('已不在运行');
  });

  it('未知 agentId 返回未找到说明', async () => {
    const registry = new SubagentRegistry();
    const tool = createStopAgentTool(registry);
    const result = await tool.execute({ agentId: 'sub-ghost' }, {} as never);
    expect(result.output).toContain('未找到');
  });

  it('缺少 agentId 时校验失败', async () => {
    const registry = new SubagentRegistry();
    const tool = createStopAgentTool(registry);
    const result = await tool.execute({}, {} as never);
    expect(result.success).toBe(false);
  });
});

function seedRegistryWithController(registry: SubagentRegistry, id: string) {
  return registry.register({
    childSessionId: id,
    parentSessionId: 'parent-1',
    description: `任务 ${id}`,
    subagentType: 'explore',
    status: 'running',
  });
}

describe('B-11 子会话生命周期审计订阅', () => {
  it('register/update/stop 都触发监听器，且退订后不再通知', () => {
    const events: string[] = [];
    const registry = new SubagentRegistry();
    const unsubscribe = registry.subscribe((rec) => events.push(`${rec.childSessionId}:${rec.status}`));
    const controller = registry.register({
      childSessionId: 'sub-audit',
      parentSessionId: 'p1',
      description: '审计任务',
      subagentType: 'explore',
      status: 'running',
    });
    registry.update('sub-audit', { status: 'completed' });
    registry.register({
      childSessionId: 'sub-b',
      parentSessionId: 'p1',
      description: '任务 b',
      subagentType: 'implement',
      status: 'running',
    });
    unsubscribe();
    registry.stop('sub-b');
    expect(events).toEqual(['sub-audit:running', 'sub-audit:completed', 'sub-b:running']);
    // 退订后 stop 不再通知
    expect(events).not.toContain('sub-b:aborted');
    void controller;
  });

  it('监听器抛错不阻断登记（fail-open）', () => {
    const registry = new SubagentRegistry();
    registry.subscribe(() => { throw new Error('listener boom'); });
    expect(() => registry.register({
      childSessionId: 'sub-x',
      description: 'x',
      subagentType: 'explore',
      status: 'running',
    })).not.toThrow();
    expect(registry.get('sub-x')?.status).toBe('running');
  });
});
