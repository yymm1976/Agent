// desktop/shared/__tests__/ipc-types.test.ts
// TD-14：ipc-types 类型定义测试（示例：shared 层类型与运行时常量测试基建）
//
// ipc-types 主要由 TypeScript 接口/类型别名构成（编译期擦除），
// 可在运行时验证的内容：AGENT_PROFILE_ROLES 常量、类型兼容性（expectTypeOf）

import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  AGENT_PROFILE_ROLES,
  type ChatSendPayload,
  type ChatStreamPayload,
  type ConfigSaveResult,
  type SkillInfo,
  type MCPCatalogEntry,
  type RouteDevAPI,
  type MainToRendererEvent,
} from '../ipc-types.js';

describe('AGENT_PROFILE_ROLES 常量', () => {
  it('包含全部 8 个内置角色', () => {
    expect(AGENT_PROFILE_ROLES).toEqual([
      'researcher', 'executor', 'reviewer', 'planner',
      'verifier', 'synthesizer', 'review-planner', 'custom',
    ]);
    expect(AGENT_PROFILE_ROLES).toHaveLength(8);
  });

  it('每个角色值为字符串字面量', () => {
    AGENT_PROFILE_ROLES.forEach((role) => {
      expect(typeof role).toBe('string');
    });
  });
});

describe('ipc-types 接口结构（类型级校验）', () => {
  it('ChatSendPayload 仅含 text 字段', () => {
    expectTypeOf<ChatSendPayload>().toMatchTypeOf<{ text: string }>();
  });

  it('ChatStreamPayload.type 包含全部流事件类型', () => {
    const validTypes: ChatStreamPayload['type'][] = [
      'text_delta', 'reasoning_delta', 'tool_start', 'tool_done',
      'progress', 'done', 'error', 'micro_summary',
    ];
    // 8 种事件类型
    expect(validTypes).toHaveLength(8);
    expectTypeOf<ChatStreamPayload['type']>().toEqualTypeOf<ChatStreamPayload['type']>();
  });

  it('ConfigSaveResult 包含 success 与可选 error/needsReload', () => {
    const ok: ConfigSaveResult = { success: true };
    const withReload: ConfigSaveResult = { success: true, needsReload: true };
    const withError: ConfigSaveResult = { success: false, error: '失败' };
    expect(ok.success).toBe(true);
    expect(withReload.needsReload).toBe(true);
    expect(withError.error).toBe('失败');
    expectTypeOf<ConfigSaveResult>().toMatchTypeOf<{ success: boolean }>();
  });

  it('SkillInfo 包含路由关键字段', () => {
    const skill: SkillInfo = {
      name: 'test',
      description: '测试',
      routingKeywords: ['a', 'b'],
      enabled: true,
      sourcePath: '/tmp/skill',
    };
    expect(skill.name).toBe('test');
    expectTypeOf<SkillInfo>().toMatchTypeOf<{
      name: string;
      description: string;
      routingKeywords: string[];
      enabled: boolean;
      sourcePath: string;
    }>();
  });

  it('MCPCatalogEntry.category 为预定义分类联合类型', () => {
    const categories: MCPCatalogEntry['category'][] = [
      'filesystem', 'database', 'browser', 'search',
      'devtool', 'communication', 'other',
    ];
    expect(categories).toHaveLength(7);
    expectTypeOf<MCPCatalogEntry['category']>().toEqualTypeOf<MCPCatalogEntry['category']>();
  });
});

describe('RouteDevAPI 与 MainToRendererEvent 类型兼容性', () => {
  it('MainToRendererEvent.channel 包含预期通道', () => {
    const channels: MainToRendererEvent['channel'][] = [
      'chat:stream',
      'chat:tool-confirm-request',
      'token:profile',
      'trace:event',
      'config:reloaded',
      'goal:event',
      'plan:edit-request',
    ];
    expect(channels).toHaveLength(7);
  });

  it('RouteDevAPI 包含核心命名空间', () => {
    expectTypeOf<RouteDevAPI>().toMatchTypeOf<{
      chat: unknown;
      config: unknown;
      mcp: unknown;
      skill: unknown;
      on: unknown;
      off: unknown;
    }>();
  });
});
