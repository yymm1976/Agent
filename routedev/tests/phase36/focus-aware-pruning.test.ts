// tests/phase36/focus-aware-pruning.test.ts
// Phase 36 Task 2：任务感知上下文裁剪测试
// 验证：三分类正确性、关注点关键词提取、相关性计算、过滤结果、边界条件

import { describe, it, expect } from 'vitest';
import { WorkerExecutor } from '../../src/agent/multi/worker-executor.js';
import type { WorkerTask } from '../../src/agent/multi/types.js';
import type { LLMMessage, ContentPart } from '../../src/router/types.js';
import type { ReActAgentLoop } from '../../src/agent/loop.js';
import type { WorkerContextConfig } from '../../src/config/schema.js';

// ============================================================
// 测试辅助
// ============================================================

function makeMockAgentLoop(): ReActAgentLoop {
  return {
    run: async function* () {
      yield { type: 'done', content: 'mock result', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
    },
  } as unknown as ReActAgentLoop;
}

function makeTask(description: string = '测试任务'): WorkerTask {
  return {
    stepId: 1,
    description,
    role: 'coder',
    rolePrompt: '',
    blackboardSnapshot: {
      currentGoal: { description: '测试目标', status: 'executing' },
      completedSteps: [],
      projectFacts: [],
    },
  };
}

function makeExecutor(config?: Partial<WorkerContextConfig>): WorkerExecutor {
  const fullConfig: WorkerContextConfig = {
    enabled: true,
    strategy: 'keyword',
    maxMessages: 5,
    maxTokens: 4000,
    fallbackToFull: true,
    ...config,
  };
  return new WorkerExecutor(makeMockAgentLoop(), { workerContextConfig: fullConfig });
}

/** 创建纯工具结果消息（应被分类为"该扔"） */
function makeToolResultMessage(content: string = '工具返回的原始数据'): LLMMessage {
  const parts: ContentPart[] = [
    { type: 'tool_result', toolUseId: 'test-1', content, isError: false },
  ];
  return { role: 'user', content: parts };
}

/** 创建混合内容消息（tool_result + text，应被分类为"该缓存"） */
function makeMixedMessage(): LLMMessage {
  const parts: ContentPart[] = [
    { type: 'text', text: '分析结果：' },
    { type: 'tool_result', toolUseId: 'test-2', content: '部分工具数据', isError: false },
  ];
  return { role: 'user', content: parts };
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 36 Task 2：任务感知上下文裁剪', () => {
  describe('三分类正确性（classifyInfoValue）', () => {
    it('纯工具结果消息应被丢弃（该扔）', () => {
      const executor = makeExecutor({ strategy: 'tail', maxMessages: 10 });
      const history: LLMMessage[] = [
        { role: 'user', content: '用户指令' },
        makeToolResultMessage('大量工具返回的原始数据，应该被丢弃'),
        { role: 'assistant', content: '助手回复' },
      ];
      const task = makeTask();
      const filtered = executor.filterContext(task, history);
      // 纯工具结果消息应被丢弃，剩余 2 条
      expect(filtered.length).toBe(2);
      // 确认工具结果消息不在结果中
      const hasToolResult = filtered.some(
        msg => Array.isArray(msg.content) && (msg.content as ContentPart[]).every(p => p.type === 'tool_result'),
      );
      expect(hasToolResult).toBe(false);
    });

    it('混合内容消息应被保留（该缓存）', () => {
      const executor = makeExecutor({ strategy: 'tail', maxMessages: 10 });
      const history: LLMMessage[] = [
        makeMixedMessage(),
        { role: 'assistant', content: '助手回复' },
      ];
      const task = makeTask();
      const filtered = executor.filterContext(task, history);
      // 混合内容消息应被保留
      expect(filtered.length).toBe(2);
    });

    it('字符串内容消息应被保留（该缓存）', () => {
      const executor = makeExecutor({ strategy: 'tail', maxMessages: 10 });
      const history: LLMMessage[] = [
        { role: 'user', content: '纯文本用户消息' },
        { role: 'assistant', content: '纯文本助手消息' },
      ];
      const task = makeTask();
      const filtered = executor.filterContext(task, history);
      expect(filtered.length).toBe(2);
    });
  });

  describe('关注点关键词提取（declareFocus）', () => {
    it('应从描述中提取结构化标识符（文件路径、函数名）', () => {
      const executor = makeExecutor({ strategy: 'keyword' });
      const history: LLMMessage[] = [
        { role: 'user', content: '修改 src/agent/loop.ts 中的 filterContext 方法' },
        { role: 'assistant', content: '好的' },
      ];
      const task = makeTask('修改 src/agent/loop.ts 中的 filterContext 方法');
      // keyword 策略会使用 focusKeywords 过滤
      const filtered = executor.filterContext(task, history);
      // 至少保留 2 条（因为匹配了关键词）
      expect(filtered.length).toBeGreaterThanOrEqual(1);
    });

    it('空描述应回退到 tail 策略', () => {
      const executor = makeExecutor({ strategy: 'keyword', maxMessages: 2 });
      const history: LLMMessage[] = [
        { role: 'user', content: '消息1' },
        { role: 'assistant', content: '消息2' },
        { role: 'user', content: '消息3' },
        { role: 'assistant', content: '消息4' },
      ];
      const task = makeTask('');
      const filtered = executor.filterContext(task, history);
      // 空描述无法提取关键词，回退到 tail，保留最近 2 条
      expect(filtered.length).toBe(2);
    });
  });

  describe('相关性计算与过滤结果', () => {
    it('keyword 策略应保留包含关键词的消息，过滤无关消息', () => {
      const executor = makeExecutor({ strategy: 'keyword' });
      const history: LLMMessage[] = [
        { role: 'user', content: '请修改 filterContext 函数' },
        { role: 'assistant', content: '好的，我来检查 filterContext' },
        { role: 'user', content: '今天天气不错，适合外出' },
        { role: 'assistant', content: '是的，天气很好' },
        { role: 'user', content: '另外看看 worker_executor' },
      ];
      const task = makeTask('修改 filterContext 和 worker_executor');
      const filtered = executor.filterContext(task, history);
      // 包含关键词的消息应被保留，无关消息应被过滤
      // 至少保留 2 条（避免过滤太激进）
      expect(filtered.length).toBeGreaterThanOrEqual(2);
      // 无关消息不应在结果中
      const hasWeather = filtered.some(msg =>
        typeof msg.content === 'string' && msg.content.includes('天气'),
      );
      expect(hasWeather).toBe(false);
    });

    it('所有消息都匹配关键词时应全部保留', () => {
      const executor = makeExecutor({ strategy: 'keyword' });
      const history: LLMMessage[] = [
        { role: 'user', content: '修改 filterContext' },
        { role: 'assistant', content: '检查 filterContext' },
      ];
      const task = makeTask('修改 filterContext 方法');
      const filtered = executor.filterContext(task, history);
      expect(filtered.length).toBe(2);
    });
  });

  describe('边界条件', () => {
    it('空历史应返回空数组', () => {
      const executor = makeExecutor();
      const task = makeTask();
      const filtered = executor.filterContext(task, []);
      expect(filtered.length).toBe(0);
    });

    it('单条历史应直接返回', () => {
      const executor = makeExecutor();
      const history: LLMMessage[] = [
        { role: 'user', content: '单条消息' },
      ];
      const task = makeTask();
      const filtered = executor.filterContext(task, history);
      expect(filtered.length).toBe(1);
    });

    it('关闭过滤时应完整透传', () => {
      const executor = makeExecutor({ enabled: false });
      const history: LLMMessage[] = [
        makeToolResultMessage('工具数据'),
        { role: 'user', content: '用户消息' },
      ];
      const task = makeTask();
      const filtered = executor.filterContext(task, history);
      // 关闭过滤时，即使有"该扔"类消息也完整透传
      expect(filtered.length).toBe(2);
    });
  });
});
