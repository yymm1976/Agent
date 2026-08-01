// tests/agent/execution-context.test.ts
// Phase 97 Part A：AgentExecutionContext 单元测试
//
// 覆盖验收标准：
//   1. 显式构造的执行上下文保留 triggerSource / sessionId / 权限模式
//   2. createDefaultExecutionContext 兜底：user 触发来源 + semi 权限模式

import { describe, it, expect } from 'vitest';
import { createDefaultExecutionContext, type AgentExecutionContext } from '../../src/agent/execution-context.js';

describe('execution-context（统一 Agent 执行上下文）', () => {
  it('显式构造的上下文保留全部字段', () => {
    const ctx: AgentExecutionContext = {
      triggerSource: 'automation',
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      model: 'deepseek-v4',
      permissionMode: 'auto',
      attachedResources: ['C:/docs/api'],
      notificationTarget: { kind: 'sse', id: 'dev-1' },
    };
    expect(ctx.triggerSource).toBe('automation');
    expect(ctx.sessionId).toBe('sess-1');
    expect(ctx.permissionMode).toBe('auto');
    expect(ctx.attachedResources).toContain('C:/docs/api');
  });

  it('默认兜底上下文：user 触发来源 + semi 权限模式 + 空附加资源', () => {
    const ctx = createDefaultExecutionContext('sess-2');
    expect(ctx.triggerSource).toBe('user');
    expect(ctx.sessionId).toBe('sess-2');
    expect(ctx.permissionMode).toBe('semi');
    expect(ctx.attachedResources).toEqual([]);
    expect(ctx.workspaceId).toBeUndefined();
    expect(ctx.notificationTarget).toBeUndefined();
  });
});
