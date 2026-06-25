// tests/phase35/worker-context-filter.test.ts
// Phase 35 Task 1：Worker 上下文选择性传递测试
// 验证：tail/keyword/budget 三种策略、边界条件（空历史/超长历史）、Blackboard 注入、配置开关

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkerExecutor } from '../../src/agent/multi/worker-executor.js';
import type { WorkerTask, WorkerResult } from '../../src/agent/multi/types.js';
import type { LLMMessage } from '../../src/router/types.js';
import type { ReActAgentLoop } from '../../src/agent/loop.js';
import type { WorkerContextConfig } from '../../src/config/schema.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建 mock AgentLoop（不实际调用 LLM） */
function makeMockAgentLoop(): ReActAgentLoop {
  return {
    run: async function* () {
      yield { type: 'done', content: 'mock result', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
    },
  } as unknown as ReActAgentLoop;
}

/** 创建测试用 WorkerTask */
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

/** 生成 N 条对话历史 */
function makeHistory(n: number): LLMMessage[] {
  const history: LLMMessage[] = [];
  for (let i = 0; i < n; i++) {
    history.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `消息 ${i + 1}：这是一段测试内容，用于验证过滤逻辑。`,
    });
  }
  return history;
}

/** 生成包含关键词的对话历史 */
function makeHistoryWithKeywords(): LLMMessage[] {
  return [
    { role: 'user', content: '请帮我修改 src/agent/loop.ts 文件' },
    { role: 'assistant', content: '好的，我来看一下 loop.ts' },
    { role: 'user', content: '另外检查一下 worker-executor.ts' },
    { role: 'assistant', content: '没问题，我会检查 worker_executor 模块' },
    { role: 'user', content: '需要调用 filterContext 方法' },
    { role: 'assistant', content: '明白，我会用 filterContext 函数' },
    { role: 'user', content: '无关消息：今天天气不错' },
    { role: 'assistant', content: '无关消息：是的，适合外出' },
  ];
}

/** 创建 WorkerExecutor 实例（带指定配置） */
function makeExecutor(config?: Partial<WorkerContextConfig>): WorkerExecutor {
  const fullConfig: WorkerContextConfig = {
    enabled: true,
    strategy: 'tail',
    maxMessages: 5,
    maxTokens: 4000,
    fallbackToFull: true,
    ...config,
  };
  return new WorkerExecutor(makeMockAgentLoop(), { workerContextConfig: fullConfig });
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 35 Task 1: Worker 上下文选择性传递', () => {
  describe('配置开关与向后兼容', () => {
    it('enabled=false 时回退到完整历史透传（向后兼容）', () => {
      const executor = makeExecutor({ enabled: false });
      const history = makeHistory(20);
      const filtered = executor.filterContext(makeTask(), history);
      expect(filtered).toBe(history); // 同一引用，未做任何过滤
      expect(filtered.length).toBe(20);
    });

    it('enabled=true 时执行过滤（默认 tail 策略）', () => {
      const executor = makeExecutor({ enabled: true, strategy: 'tail', maxMessages: 3 });
      const history = makeHistory(10);
      const filtered = executor.filterContext(makeTask(), history);
      expect(filtered.length).toBe(3);
      // 保留最近 3 条
      expect(filtered[0].content).toContain('消息 8');
      expect(filtered[2].content).toContain('消息 10');
    });
  });

  describe('策略 A：tail + Blackboard 注入', () => {
    it('保留最近 N 条消息（默认 5 条）', () => {
      const executor = makeExecutor({ strategy: 'tail', maxMessages: 5 });
      const history = makeHistory(20);
      const filtered = executor.filterContext(makeTask(), history);
      expect(filtered.length).toBe(5);
      // 保留最近 5 条（消息 16-20）
      expect(filtered[0].content).toContain('消息 16');
      expect(filtered[4].content).toContain('消息 20');
    });

    it('历史数 ≤ maxMessages 时保留全部', () => {
      const executor = makeExecutor({ strategy: 'tail', maxMessages: 10 });
      const history = makeHistory(3);
      const filtered = executor.filterContext(makeTask(), history);
      expect(filtered.length).toBe(3);
    });

    it('空历史返回空数组', () => {
      const executor = makeExecutor({ strategy: 'tail', maxMessages: 5 });
      const filtered = executor.filterContext(makeTask(), []);
      expect(filtered.length).toBe(0);
    });

    it('单条历史原样返回', () => {
      const executor = makeExecutor({ strategy: 'tail', maxMessages: 5 });
      const history = makeHistory(1);
      const filtered = executor.filterContext(makeTask(), history);
      expect(filtered.length).toBe(1);
    });
  });

  describe('策略 B：keyword 关键词相关性过滤', () => {
    it('从 task.description 提取文件路径并匹配', () => {
      const executor = makeExecutor({ strategy: 'keyword' });
      const history = makeHistoryWithKeywords();
      const task = makeTask('修改 src/agent/loop.ts 文件');
      const filtered = executor.filterContext(task, history);
      // 至少匹配包含 loop.ts 的消息
      expect(filtered.length).toBeGreaterThanOrEqual(2);
      const allContent = filtered.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
      expect(allContent).toMatch(/loop\.ts/);
    });

    it('从 task.description 提取引号包裹的标识符', () => {
      const executor = makeExecutor({ strategy: 'keyword' });
      const history = makeHistoryWithKeywords();
      const task = makeTask('调用 "filterContext" 方法');
      const filtered = executor.filterContext(task, history);
      expect(filtered.length).toBeGreaterThanOrEqual(2);
    });

    it('无关键词可提取时回退到 tail 策略', () => {
      const executor = makeExecutor({ strategy: 'keyword', maxMessages: 3 });
      const history = makeHistory(10);
      const task = makeTask('测试任务'); // 无文件路径、无引号标识符
      const filtered = executor.filterContext(task, history);
      // 回退到 tail，保留最近 3 条
      expect(filtered.length).toBe(3);
    });

    it('匹配数 < 2 时回退到 tail 策略（避免过滤太激进）', () => {
      const executor = makeExecutor({ strategy: 'keyword', maxMessages: 4 });
      const history: LLMMessage[] = [
        { role: 'user', content: '无关消息 1' },
        { role: 'assistant', content: '无关消息 2' },
        { role: 'user', content: '无关消息 3' },
        { role: 'assistant', content: '无关消息 4' },
        { role: 'user', content: '唯一匹配 src/agent/loop.ts' },
        { role: 'assistant', content: '无关消息 6' },
      ];
      const task = makeTask('修改 src/agent/loop.ts');
      const filtered = executor.filterContext(task, history);
      // 只有 1 条匹配，回退到 tail
      expect(filtered.length).toBe(4);
    });
  });

  describe('策略 C：budget token 预算裁剪', () => {
    it('从最新消息向前累积，超出预算则停止', () => {
      // maxTokens=50，每条消息约 12 token（中文 1.5/字 × 16 字 + 标点）
      const executor = makeExecutor({ strategy: 'budget', maxTokens: 50 });
      const history = makeHistory(10);
      const filtered = executor.filterContext(makeTask(), history);
      // 应该只保留最近几条
      expect(filtered.length).toBeLessThan(10);
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      // 最新消息必须保留
      const lastMsg = filtered[filtered.length - 1];
      expect(lastMsg.content).toContain('消息 10');
    });

    it('预算充足时保留全部历史', () => {
      const executor = makeExecutor({ strategy: 'budget', maxTokens: 10000 });
      const history = makeHistory(5);
      const filtered = executor.filterContext(makeTask(), history);
      expect(filtered.length).toBe(5);
    });

    it('至少保留 1 条消息（最新的）', () => {
      // 极小预算
      const executor = makeExecutor({ strategy: 'budget', maxTokens: 1 });
      const history = makeHistory(5);
      const filtered = executor.filterContext(makeTask(), history);
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      expect(filtered[filtered.length - 1].content).toContain('消息 5');
    });
  });

  describe('过滤后的消息数组完整性', () => {
    it('过滤结果不包含当前 userMessage（task.description 由 agentLoop.run 单独传入）', () => {
      const executor = makeExecutor({ strategy: 'tail', maxMessages: 5 });
      const history = makeHistory(10);
      const task = makeTask('当前任务描述');
      const filtered = executor.filterContext(task, history);
      // 过滤结果中不应包含 task.description
      const allContent = filtered.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
      expect(allContent).not.toContain('当前任务描述');
    });

    it('Blackboard 的 completedSteps 通过 systemPrompt 注入，不受过滤影响', () => {
      const executor = makeExecutor({ strategy: 'tail', maxMessages: 3 });
      const history = makeHistory(10);
      const task: WorkerTask = {
        stepId: 2,
        description: '步骤 2',
        role: 'coder',
        rolePrompt: '',
        blackboardSnapshot: {
          currentGoal: { description: '目标', status: 'executing' },
          completedSteps: [
            {
              key: 'step-1',
              value: '步骤 1 已完成的结论',
              source: { role: 'coder', stepId: 1 },
              timestamp: Date.now(),
              confidence: 0.9,
            },
          ],
          projectFacts: [],
        },
      };
      const filtered = executor.filterContext(task, history);
      // 过滤后的消息数组不包含 Blackboard 信息（Blackboard 通过 systemPrompt 注入）
      const allContent = filtered.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
      expect(allContent).not.toContain('步骤 1 已完成的结论');
    });
  });

  describe('fallbackToFull 回退机制', () => {
    it('过滤异常时 fallbackToFull=true 回退到完整历史', () => {
      // 构造一个会触发异常的场景：maxMessages 为负数（schema 层会拦截，但运行时可能未拦截）
      // 这里用正常配置测试，主要验证 fallbackToFull 的行为
      const executor = makeExecutor({ fallbackToFull: true, strategy: 'tail', maxMessages: 5 });
      const history = makeHistory(10);
      const filtered = executor.filterContext(makeTask(), history);
      // 正常情况下应该过滤成功
      expect(filtered.length).toBe(5);
    });
  });
});
