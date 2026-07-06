// tests/agent/message-types.test.ts
// Phase 73 Part A：AgentMessage 消息抽象层单元测试
//
// 覆盖验收标准：
//   1. defaultConvertToLlm 过滤掉未知 role 的消息
//   2. defaultConvertToLlm 保留 user/assistant/system 标准消息
//   3. declaration merging 扩展自定义消息类型后，自定义消息可流入 AgentMessage 管线

import { describe, it, expect } from 'vitest';
import { defaultConvertToLlm, type AgentMessage } from '../../src/agent/message-types.js';
import type { LLMMessage } from '../../src/router/types.js';

// 模拟插件通过 declaration merging 扩展自定义消息类型
// 编译通过即验证 declaration merging 生效：customMsg 可直接赋值给 AgentMessage[]
declare module '../../src/agent/message-types.js' {
  interface CustomAgentMessages {
    planStatus: { role: 'plan_status'; plan: string; currentStep: number };
  }
}

describe('message-types（AgentMessage 消息抽象层）', () => {
  // ============================================================
  // defaultConvertToLlm：保留标准消息
  // ============================================================
  describe('defaultConvertToLlm 保留标准消息', () => {
    it('保留 user/assistant/system 消息', () => {
      const messages: AgentMessage[] = [
        { role: 'system', content: '你是一个助手' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，有什么可以帮你？' },
      ];
      const result = defaultConvertToLlm(messages);
      expect(result).toHaveLength(3);
      expect(result.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    });

    it('保留含 ContentPart[] 的标准消息', () => {
      const messages: AgentMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我来调用工具' },
            { type: 'tool_use', id: 'tc-1', name: 'file_read', arguments: { path: '/a' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'tc-1', content: '文件内容', isError: false },
          ],
        },
      ];
      const result = defaultConvertToLlm(messages);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('assistant');
      expect(result[1].role).toBe('user');
    });

    it('空数组返回空数组', () => {
      const result = defaultConvertToLlm([]);
      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // defaultConvertToLlm：过滤未知 role
  // ============================================================
  describe('defaultConvertToLlm 过滤未知 role', () => {
    it('过滤掉 plan_status 自定义消息，保留标准消息', () => {
      // declaration merging 扩展的 planStatus 类型，可直接作为 AgentMessage
      const customMsg: { role: 'plan_status'; plan: string; currentStep: number } = {
        role: 'plan_status',
        plan: '实现功能 A',
        currentStep: 2,
      };
      const messages: AgentMessage[] = [
        { role: 'user', content: '开始任务' },
        customMsg,
        { role: 'assistant', content: '收到' },
      ];
      const result = defaultConvertToLlm(messages);
      // plan_status 被过滤，只剩 user + assistant
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    it('全部为自定义消息时返回空数组', () => {
      const messages: AgentMessage[] = [
        { role: 'plan_status', plan: '步骤 1', currentStep: 1 },
        { role: 'plan_status', plan: '步骤 2', currentStep: 2 },
      ];
      const result = defaultConvertToLlm(messages);
      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // declaration merging 扩展自定义消息类型
  // ============================================================
  describe('declaration merging 扩展自定义消息类型', () => {
    it('自定义 planStatus 消息可赋值给 AgentMessage[]（编译期验证）', () => {
      // 此测试编译通过即验证 declaration merging 生效：
      // CustomAgentMessages 被 augment 后，planStatus 进入 AgentMessage 联合类型
      const messages: AgentMessage[] = [
        { role: 'user', content: '开始' },
        { role: 'plan_status', plan: '任务 A', currentStep: 1 },
      ];
      expect(messages).toHaveLength(2);
    });

    it('自定义 convertToLlm 可将 plan_status 转为 system 消息注入 LLM', () => {
      // 演示插件注册自定义 convertToLlm 处理自定义消息类型
      const messages: AgentMessage[] = [
        { role: 'user', content: '继续执行' },
        { role: 'plan_status', plan: '任务 A', currentStep: 3 },
      ];
      const customConvert = (msgs: AgentMessage[]): LLMMessage[] =>
        msgs.map((m) => {
          if (m.role === 'plan_status') {
            // 把 plan 状态转为 system 消息，让 LLM 感知当前计划进度
            return {
              role: 'system',
              content: `当前计划: ${m.plan}（步骤 ${m.currentStep}）`,
            };
          }
          return m;
        });
      const result = customConvert(messages);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[0].content).toBe('继续执行');
      expect(result[1].role).toBe('system');
      expect(result[1].content).toContain('当前计划');
      expect(result[1].content).toContain('任务 A');
    });
  });
});
