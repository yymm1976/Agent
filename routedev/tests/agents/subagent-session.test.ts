// tests/agents/subagent-session.test.ts
// Phase 51 Task 4：子 Agent 独立会话作用域 subagent-session.ts 单元测试
//
// 覆盖关键能力：
//   1. createSubAgentSession 生成独立 sessionId / storageKey 三元组 / 不继承父 systemPrompt
//   2. extractFinalAnswer 提取最后一条 assistant 消息文本
//   3. isSessionExpired 超时判定
//
// 全部为纯函数测试，不依赖 LLM 或文件系统。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createSubAgentSession,
  extractFinalAnswer,
  isSessionExpired,
  type SubAgentSessionScope,
} from '../../src/agents/subagent-session.js';
import type { AgentProfile, AgentRole } from '../../src/agents/profiles/types.js';

// 测试用的 profile 工厂
function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test-profile',
    name: 'Test Profile',
    type: 'agent-profile',
    version: '1.0.0',
    role: 'researcher' as AgentRole,
    modelId: 'default',
    description: 'test',
    systemPrompt: 'You are a researcher subagent.',
    allowedTools: ['file_read', 'code_search'],
    forbiddenTools: [],
    canChallenge: false,
    challengeSeverity: 'warning',
    outputFormat: 'research_report',
    boundSkills: [],
    maxTokens: 8000,
    maxSteps: 20,
    isBuiltin: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('Phase 51 Task 4: subagent-session 单元测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1.1 createSubAgentSession: 生成独立 sessionId 和 storageKey 三元组', () => {
    const profile = makeProfile({ systemPrompt: '独立 prompt' });
    const scope = createSubAgentSession('parent-123', 'researcher', profile, 1);

    // sessionId 应以 'sub-' 开头，且包含时间戳与随机后缀
    expect(scope.sessionId).toMatch(/^sub-\d+-[a-z0-9]+$/);
    expect(scope.sessionId).not.toBe('parent-123');

    // storageKey 三元组应包含 instanceId / harnessName / sessionName
    expect(scope.storageKey).toHaveProperty('instanceId');
    expect(scope.storageKey).toHaveProperty('harnessName');
    expect(scope.storageKey).toHaveProperty('sessionName');
    // sessionName 形如 `task:<parentSessionId>:<sessionId>`
    expect(scope.storageKey.sessionName).toContain('parent-123');
    expect(scope.storageKey.sessionName).toContain(scope.sessionId);
  });

  it('1.2 createSubAgentSession: systemPrompt 来自 profile，不从父继承', () => {
    const profile = makeProfile({ systemPrompt: '子 Agent 专属 prompt' });
    const scope = createSubAgentSession('parent-456', 'researcher', profile, 1);

    // systemPrompt 必须严格等于 profile.systemPrompt（而非父会话的 prompt）
    expect(scope.systemPrompt).toBe('子 Agent 专属 prompt');
    expect(scope.systemPrompt).not.toBe('parent-456');

    // 不同 profile 应产生不同 systemPrompt
    const profile2 = makeProfile({ systemPrompt: '另一个不同的 prompt' });
    const scope2 = createSubAgentSession('parent-456', 'researcher', profile2, 1);
    expect(scope2.systemPrompt).toBe('另一个不同的 prompt');
    expect(scope2.systemPrompt).not.toBe(scope.systemPrompt);
  });

  it('1.3 createSubAgentSession: messageHistory 初始为空数组', () => {
    const profile = makeProfile();
    const scope = createSubAgentSession('parent-789', 'executor', profile, 1);

    expect(Array.isArray(scope.messageHistory)).toBe(true);
    expect(scope.messageHistory).toHaveLength(0);
  });

  it('1.4 createSubAgentSession: 父 storageKey 缺省时填 "default"', () => {
    const profile = makeProfile();
    // 不传 parentStorageKey
    const scope = createSubAgentSession('parent-1', 'researcher', profile, 1);
    expect(scope.storageKey.instanceId).toBe('default');
    expect(scope.storageKey.harnessName).toBe('default');

    // 传入自定义 parentStorageKey
    const scope2 = createSubAgentSession('parent-2', 'researcher', profile, 1, {
      instanceId: 'inst-xyz',
      harnessName: 'harness-abc',
    });
    expect(scope2.storageKey.instanceId).toBe('inst-xyz');
    expect(scope2.storageKey.harnessName).toBe('harness-abc');
  });

  it('1.5 extractFinalAnswer: 返回最后一条 assistant 消息的文本内容', () => {
    const profile = makeProfile();
    const scope = createSubAgentSession('parent-1', 'researcher', profile, 1);

    // 注入若干条消息（含 user 与 assistant）
    scope.messageHistory = [
      { role: 'user', content: '问题1' },
      { role: 'assistant', content: '回答1' },
      { role: 'user', content: '问题2' },
      { role: 'assistant', content: '最终答案文本' },
    ];

    expect(extractFinalAnswer(scope)).toBe('最终答案文本');
  });

  it('1.6 extractFinalAnswer: 兼容数组形式的 content', () => {
    const profile = makeProfile();
    const scope = createSubAgentSession('parent-1', 'researcher', profile, 1);
    scope.messageHistory = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '数组形式的答案' }],
      },
    ];
    expect(extractFinalAnswer(scope)).toBe('数组形式的答案');
  });

  it('1.7 extractFinalAnswer: 无 assistant 消息时返回空字符串', () => {
    const profile = makeProfile();
    const scope = createSubAgentSession('parent-1', 'researcher', profile, 1);

    // 空历史
    expect(extractFinalAnswer(scope)).toBe('');

    // 仅 user 消息
    scope.messageHistory = [{ role: 'user', content: '只有用户消息' }];
    expect(extractFinalAnswer(scope)).toBe('');
  });

  it('1.8 isSessionExpired: 超时返回 true，未超时返回 false', () => {
    const profile = makeProfile();
    const scope = createSubAgentSession('parent-1', 'researcher', profile, 1);

    // 刚创建，未超时
    expect(isSessionExpired(scope, 60_000)).toBe(false);

    // 模拟过期：将 createdAt 设为很久以前
    const expiredScope: SubAgentSessionScope = {
      ...scope,
      createdAt: Date.now() - 120_000, // 2 分钟前
    };
    expect(isSessionExpired(expiredScope, 60_000)).toBe(true); // 1 分钟超时
    expect(isSessionExpired(expiredScope, 180_000)).toBe(false); // 3 分钟未超时
  });
});
