// tests/skills/skill-flow-engine.test.ts
// SkillFlow 引擎单元测试（Phase 49 Task 1.6）
//
// 测试策略：
//   - mock runReact / llmJudge / evaluateLoopCondition / waitForUserConfirmation / evaluateBranch
//   - 不调用真实 LLM
//   - 收集 AsyncGenerator yield 的事件做断言

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillFlowEngine } from '../../src/skills/skill-flow-engine.js';
import type {
  FlowEvent,
  SkillFlow,
  SkillFlowRunParams,
} from '../../src/skills/skill-flow-types.js';
import type { ReActRunParams } from '../../src/agent/loop.js';
import type { ReActEvent } from '../../src/agent/loop-config.js';

// ============================================================
// mock 工厂
// ============================================================

/** 构造最小的 ReActRunParams mock */
function makeBaseParams(overrides: Partial<ReActRunParams> = {}): ReActRunParams {
  return {
    userMessage: '执行部署',
    llmClient: { complete: async () => ({ content: '', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }), stream: async function* () {} } as unknown as ReActRunParams['llmClient'],
    routeDecision: {
      model: {
        id: 'test-model',
        name: 'Test Model',
        provider: 'test',
        tier: 'coding' as never,
        contextWindow: 8000,
        capabilities: [],
        latencyMs: 0,
        available: true,
      },
      providerId: 'test',
      fallbackUsed: false,
      originalTier: 'coding' as never,
      degraded: false,
    },
    conversationHistory: [],
    ...overrides,
  } as ReActRunParams;
}

/** 构造 runReact mock：根据 systemPrompt 中的标记返回不同输出 */
function makeRunReact(
  outputMap: { prompt: string; output: string }[] | string[],
): (params: ReActRunParams, allowedTools?: string[]) => AsyncGenerator<ReActEvent> {
  return async function* (params: ReActRunParams, allowedTools?: string[]): AsyncGenerator<ReActEvent> {
    const sysPrompt = params.systemPrompt ?? '';

    let output = '';
    if (Array.isArray(outputMap)) {
      for (const item of outputMap) {
        if (typeof item === 'string') {
          // 简单字符串数组：按顺序匹配
          if (sysPrompt.includes(item) || item === outputMap[0]) {
            output = item;
            break;
          }
        } else {
          if (sysPrompt.includes(item.prompt)) {
            output = item.output;
            break;
          }
        }
      }
      // 兜底：返回第一个
      if (!output) {
        output = typeof outputMap[0] === 'string' ? outputMap[0] : outputMap[0].output;
      }
    }

    // 暴露 allowedTools 到 output 便于测试断言
    if (allowedTools && allowedTools.length > 0) {
      output = `${output}[ALLOWED_TOOLS:${allowedTools.join(',')}]`;
    }

    yield { type: 'done', content: output, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  };
}

/** 构造 SkillFlowRunParams */
function makeParams(
  overrides: Partial<SkillFlowRunParams> = {},
): SkillFlowRunParams {
  return {
    baseParams: makeBaseParams(),
    runReact: makeRunReact(['default-output']),
    llmJudge: async () => true,
    evaluateLoopCondition: async () => true,
    waitForUserConfirmation: async () => 'approve',
    evaluateBranch: async () => 'next',
    ...overrides,
  };
}

/** 收集 AsyncGenerator 的所有事件 */
async function collectEvents(gen: AsyncGenerator<FlowEvent>): Promise<FlowEvent[]> {
  const events: FlowEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

// ============================================================
// 测试用例
// ============================================================

describe('SkillFlowEngine（Phase 49 Task 1.3）', () => {
  let engine: SkillFlowEngine;

  beforeEach(() => {
    engine = new SkillFlowEngine();
  });

  // ------------------------------------------------------------
  // step 节点
  // ------------------------------------------------------------

  describe('step 节点', () => {
    it('正常执行 step 节点并发出完整事件流', async () => {
      const flow: SkillFlow = {
        nodes: [
          { id: 'step1', type: 'step', title: '第一步', prompt: '执行步骤1', onFailure: 'abort' },
        ],
        entryNodeId: 'step1',
        exitNodeId: 'exit',
        maxTotalIterations: 10,
      };

      const events = await collectEvents(engine.run(flow, makeParams({
        runReact: makeRunReact([{ prompt: '执行步骤1', output: '步骤1完成' }]),
      })));

      // 期望事件顺序：node-start → react-event(done) → node-complete → flow-complete
      expect(events.map((e) => e.type)).toEqual([
        'node-start', 'react-event', 'node-complete', 'flow-complete',
      ]);
      const startEvent = events[0];
      expect(startEvent.type).toBe('node-start');
      if (startEvent.type === 'node-start') {
        expect(startEvent.node.id).toBe('step1');
      }
      const completeEvent = events[2];
      if (completeEvent.type === 'node-complete') {
        expect(completeEvent.output).toBe('步骤1完成');
      }
    });

    it('只注入当前节点 prompt，不暴露后续节点（防跳步）', async () => {
      const flow: SkillFlow = {
        nodes: [
          { id: 'step1', type: 'step', title: '第一步', prompt: '第一步指令', onFailure: 'abort' },
          { id: 'step2', type: 'step', title: '第二步', prompt: '第二步指令', onFailure: 'abort' },
        ],
        entryNodeId: 'step1',
        exitNodeId: 'exit',
        maxTotalIterations: 10,
      };

      // 收集每次 runReact 调用时的 systemPrompt
      const capturedPrompts: string[] = [];
      const params = makeParams({
        runReact: async function* (p: ReActRunParams): AsyncGenerator<ReActEvent> {
          capturedPrompts.push(p.systemPrompt ?? '');
          yield { type: 'done', content: 'ok', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        },
      });

      await collectEvents(engine.run(flow, params));

      // 第一步的 systemPrompt 不应包含第二步的指令
      expect(capturedPrompts[0]).toContain('第一步指令');
      expect(capturedPrompts[0]).not.toContain('第二步指令');
      // 第二步的 systemPrompt 应包含第二步的指令
      expect(capturedPrompts[1]).toContain('第二步指令');
    });

    it('工具白名单被正确传递给 runReact', async () => {
      const flow: SkillFlow = {
        nodes: [
          {
            id: 'step1',
            type: 'step',
            title: '第一步',
            prompt: '执行',
            allowedTools: ['shell_exec', 'file_read'],
            onFailure: 'abort',
          },
        ],
        entryNodeId: 'step1',
        exitNodeId: 'exit',
        maxTotalIterations: 10,
      };

      let capturedTools: string[] | undefined;
      const params = makeParams({
        runReact: async function* (_p: ReActRunParams, allowedTools?: string[]): AsyncGenerator<ReActEvent> {
          capturedTools = allowedTools;
          yield { type: 'done', content: 'ok', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        },
      });

      await collectEvents(engine.run(flow, params));

      expect(capturedTools).toEqual(['shell_exec', 'file_read']);
    });
  });

  // ------------------------------------------------------------
  // checkpoint 节点
  // ------------------------------------------------------------

  describe('checkpoint 节点', () => {
    it('llm-judge 检查通过时发出 checkpoint-passed 事件', async () => {
      const flow: SkillFlow = {
        nodes: [
          { id: 'step1', type: 'step', title: '第一步', prompt: '执行', onFailure: 'abort' },
          {
            id: 'check1',
            type: 'checkpoint',
            title: '检查',
            prompt: '',
            checkCondition: { kind: 'llm-judge', judgePrompt: '是否完成？' },
            onFailure: 'abort',
          },
        ],
        entryNodeId: 'step1',
        exitNodeId: 'exit',
        maxTotalIterations: 10,
      };

      const events = await collectEvents(engine.run(flow, makeParams({
        runReact: makeRunReact([{ prompt: '执行', output: '产出内容' }]),
        llmJudge: async () => true,
      })));

      const types = events.map((e) => e.type);
      expect(types).toContain('checkpoint-passed');
      expect(types).not.toContain('checkpoint-failed');
    });

    it('llm-judge 检查不通过且 onFailure=abort 时终止流水线', async () => {
      const flow: SkillFlow = {
        nodes: [
          { id: 'step1', type: 'step', title: '第一步', prompt: '执行', onFailure: 'abort' },
          {
            id: 'check1',
            type: 'checkpoint',
            title: '检查',
            prompt: '',
            checkCondition: { kind: 'llm-judge', judgePrompt: '是否完成？' },
            onFailure: 'abort',
          },
        ],
        entryNodeId: 'step1',
        exitNodeId: 'exit',
        maxTotalIterations: 10,
      };

      const events = await collectEvents(engine.run(flow, makeParams({
        runReact: makeRunReact([{ prompt: '执行', output: '产出内容' }]),
        llmJudge: async () => false,
      })));

      const types = events.map((e) => e.type);
      expect(types).toContain('checkpoint-failed');
      expect(types).toContain('flow-aborted');
      expect(types).not.toContain('flow-complete');
    });

    it('regex-match 正确匹配通过', async () => {
      const flow: SkillFlow = {
        nodes: [
          { id: 'step1', type: 'step', title: '第一步', prompt: '执行', onFailure: 'abort' },
          {
            id: 'check1',
            type: 'checkpoint',
            title: '检查',
            prompt: '',
            checkCondition: { kind: 'regex-match', pattern: 'Build successful|构建成功' },
            onFailure: 'abort',
          },
        ],
        entryNodeId: 'step1',
        exitNodeId: 'exit',
        maxTotalIterations: 10,
      };

      const events = await collectEvents(engine.run(flow, makeParams({
        runReact: makeRunReact([{ prompt: '执行', output: '构建成功，产物在 dist/' }]),
      })));

      expect(events.map((e) => e.type)).toContain('checkpoint-passed');
    });

    it('regex-match 不通过且 onFailure=goto 时跳转到指定节点', async () => {
      const flow: SkillFlow = {
        nodes: [
          { id: 'step1', type: 'step', title: '第一步', prompt: '执行', onFailure: 'abort' },
          {
            id: 'check1',
            type: 'checkpoint',
            title: '检查',
            prompt: '',
            checkCondition: { kind: 'regex-match', pattern: '不可能匹配的pattern' },
            onFailure: 'goto',
            onFailureGoto: 'step1', // 回到 step1
          },
        ],
        entryNodeId: 'step1',
        exitNodeId: 'exit',
        maxTotalIterations: 10,
      };

      const events = await collectEvents(engine.run(flow, makeParams({
        runReact: makeRunReact([{ prompt: '执行', output: '构建成功' }]),
      })));

      const types = events.map((e) => e.type);
      expect(types).toContain('checkpoint-failed');
      // onFailure=goto 会回到 step1，step1 会再次执行，check1 再次失败
      // 但因为总迭代次数限制为 10，最终会因 goto 循环触发上限
      // 至少应看到至少 2 次 node-start（step1 被执行多次）
      const nodeStarts = events.filter((e) => e.type === 'node-start');
      expect(nodeStarts.length).toBeGreaterThanOrEqual(2);
    });

    it('tool-output-contains 检查通过', async () => {
      const flow: SkillFlow = {
        nodes: [
          {
            id: 'build',
            type: 'step',
            title: '构建',
            prompt: '执行构建',
            onFailure: 'abort',
          },
          {
            id: 'check',
            type: 'checkpoint',
            title: '检查工具输出',
            prompt: '',
            checkCondition: {
              kind: 'tool-output-contains',
              toolName: 'build',
              keyword: 'success',
            },
            onFailure: 'abort',
          },
        ],
        entryNodeId: 'build',
        exitNodeId: 'exit',
        maxTotalIterations: 10,
      };

      const events = await collectEvents(engine.run(flow, makeParams({
        runReact: makeRunReact([{ prompt: '执行构建', output: 'build success' }]),
      })));

      expect(events.map((e) => e.type)).toContain('checkpoint-passed');
    });

    it('onFailure=retry 在 maxRetries 内重试 checkpoint', async () => {
      const flow: SkillFlow = {
        nodes: [
          { id: 'step1', type: 'step', title: '第一步', prompt: '执行', onFailure: 'abort' },
          {
            id: 'check1',
            type: 'checkpoint',
            title: '检查',
            prompt: '',
            checkCondition: { kind: 'llm-judge', judgePrompt: '是否完成？' },
            onFailure: 'retry',
            maxRetries: 2,
          },
        ],
        entryNodeId: 'step1',
        exitNodeId: 'exit',
        maxTotalIterations: 20,
      };

      // llmJudge 第一次返回 false，第二次返回 true
      let judgeCallCount = 0;
      const events = await collectEvents(engine.run(flow, makeParams({
        runReact: makeRunReact([{ prompt: '执行', output: '产出内容' }]),
        llmJudge: async () => {
          judgeCallCount++;
          return judgeCallCount >= 2; // 第一次 false，第二次 true
        },
      })));

      const types = events.map((e) => e.type);
      expect(types).toContain('checkpoint-failed'); // 第一次失败
      expect(types).toContain('checkpoint-passed'); // 第二次通过
      expect(types).toContain('flow-complete');
    });
  });

  // ------------------------------------------------------------
  // user-gate 节点
  // ------------------------------------------------------------

  describe('user-gate 节点', () => {
    it('用户 approve 时继续执行', async () => {
      const flow: SkillFlow = {
        nodes: [
          {
            id: 'gate1',
            type: 'user-gate',
            title: '确认',
            prompt: '',
            gateMessage: '确认继续？',
            onFailure: 'abort',
          },
          { id: 'step1', type: 'step', title: '第一步', prompt: '执行', onFailure: 'abort' },
        ],
        entryNodeId: 'gate1',
        exitNodeId: 'exit',
        maxTotalIterations: 10,
      };

      const events = await collectEvents(engine.run(flow, makeParams({
        waitForUserConfirmation: async () => 'approve',
      })));

      const types = events.map((e) => e.type);
      expect(types).toContain('user-gate');
      expect(types).toContain('flow-complete');
    });

    it('用户 reject 时终止流水线', async () => {
      const flow: SkillFlow = {
        nodes: [
          {
            id: 'gate1',
            type: 'user-gate',
            title: '确认',
            prompt: '',
            gateMessage: '确认继续？',
            onFailure: 'abort',
          },
          { id: 'step1', type: 'step', title: '第一步', prompt: '执行', onFailure: 'abort' },
        ],
        entryNodeId: 'gate1',
        exitNodeId: 'exit',
        maxTotalIterations: 10,
      };

      const events = await collectEvents(engine.run(flow, makeParams({
        waitForUserConfirmation: async () => 'reject',
      })));

      const types = events.map((e) => e.type);
      expect(types).toContain('user-gate');
      expect(types).toContain('flow-aborted');
      expect(types).not.toContain('flow-complete');
    });
  });

  // ------------------------------------------------------------
  // loop 节点
  // ------------------------------------------------------------

  describe('loop 节点', () => {
    it('循环条件满足时退出循环', async () => {
      const flow: SkillFlow = {
        nodes: [
          {
            id: 'loop1',
            type: 'loop',
            title: '循环',
            prompt: '执行循环体',
            loopCondition: { while: '任务完成', maxIterations: 5 },
            onFailure: 'abort',
          },
        ],
        entryNodeId: 'loop1',
        exitNodeId: 'exit',
        maxTotalIterations: 20,
      };

      // 第一次 evaluateLoopCondition 返回 false（继续循环），第二次返回 true（退出）
      let evalCount = 0;
      const events = await collectEvents(engine.run(flow, makeParams({
        runReact: makeRunReact([{ prompt: '执行循环体', output: '循环产出' }]),
        evaluateLoopCondition: async () => {
          evalCount++;
          return evalCount >= 2; // 第一次 false，第二次 true
        },
      })));

      const types = events.map((e) => e.type);
      expect(types).toContain('loop-iteration');
      expect(types).toContain('flow-complete');

      // 应该有 2 次 loop-iteration 事件
      const loopIterations = events.filter((e) => e.type === 'loop-iteration');
      expect(loopIterations.length).toBe(2);
    });

    it('达到 maxIterations 时发出 loop-exhausted 事件', async () => {
      const flow: SkillFlow = {
        nodes: [
          {
            id: 'loop1',
            type: 'loop',
            title: '循环',
            prompt: '执行循环体',
            loopCondition: { while: '永不满足', maxIterations: 2 },
            onFailure: 'abort',
          },
        ],
        entryNodeId: 'loop1',
        exitNodeId: 'exit',
        maxTotalIterations: 20,
      };

      const events = await collectEvents(engine.run(flow, makeParams({
        runReact: makeRunReact([{ prompt: '执行循环体', output: '循环产出' }]),
        evaluateLoopCondition: async () => false, // 永不满足
      })));

      const types = events.map((e) => e.type);
      expect(types).toContain('loop-exhausted');
      expect(types).toContain('flow-aborted');
      expect(types).not.toContain('flow-complete');
    });
  });

  // ------------------------------------------------------------
  // 总迭代上限
  // ------------------------------------------------------------

  describe('总迭代上限保护', () => {
    it('达到 maxTotalIterations 时发出 flow-aborted', async () => {
      // 构造一个会无限 goto 回 step1 的 flow 来消耗迭代次数
      // 用 onFailure=goto 制造循环
      const flowWithGoto: SkillFlow = {
        nodes: [
          {
            id: 'step1',
            type: 'step',
            title: '第一步',
            prompt: '执行',
            onFailure: 'goto',
            onFailureGoto: 'step1', // 失败时 goto 自己，制造循环
            maxRetries: 0,
          },
        ],
        entryNodeId: 'step1',
        exitNodeId: 'exit',
        maxTotalIterations: 2,
      };

      // 让 runReact 抛异常触发 onFailure
      const events = await collectEvents(engine.run(flowWithGoto, makeParams({
        runReact: async function* (): AsyncGenerator<ReActEvent> {
          throw new Error('mock error');
        },
      })));

      const types = events.map((e) => e.type);
      // 因 maxTotalIterations=2，第二次进入循环时会被上限拦截
      expect(types).toContain('flow-aborted');
    });
  });

  // ------------------------------------------------------------
  // branch 节点
  // ------------------------------------------------------------

  describe('branch 节点', () => {
    it('根据 evaluateBranch 结果跳转到目标节点', async () => {
      const flow: SkillFlow = {
        nodes: [
          { id: 'step1', type: 'step', title: '第一步', prompt: '执行', onFailure: 'abort' },
          {
            id: 'branch1',
            type: 'branch',
            title: '分支',
            prompt: '',
            branches: [
              { condition: '条件A', targetNodeId: 'stepA' },
              { condition: '条件B', targetNodeId: 'stepB' },
            ],
            onFailure: 'abort',
          },
          { id: 'stepA', type: 'step', title: '分支A', prompt: '执行A', onFailure: 'abort' },
          { id: 'stepB', type: 'step', title: '分支B', prompt: '执行B', onFailure: 'abort' },
        ],
        entryNodeId: 'step1',
        exitNodeId: 'exit',
        maxTotalIterations: 20,
      };

      const events = await collectEvents(engine.run(flow, makeParams({
        runReact: makeRunReact([
          { prompt: '执行', output: '原始产出' },
          { prompt: '执行A', output: 'A 产出' },
          { prompt: '执行B', output: 'B 产出' },
        ]),
        // 选择 stepB（位于 nodes 数组末尾），这样 stepA 会被跳过
        evaluateBranch: async () => 'stepB',
      })));

      const types = events.map((e) => e.type);
      expect(types).toContain('flow-complete');

      // 应该执行了 step1 → branch1 → stepB（stepA 被跳过）
      const nodeStarts = events.filter(
        (e) => e.type === 'node-start',
      );
      const startedNodeIds = nodeStarts.map((e) => {
        if (e.type === 'node-start') return e.node.id;
        return '';
      });
      expect(startedNodeIds).toContain('step1');
      expect(startedNodeIds).toContain('branch1');
      expect(startedNodeIds).toContain('stepB');
      // stepA 位于 stepB 之前，branch 直接跳到 stepB 后线性推进到 exit，
      // stepA 不应被执行
      expect(startedNodeIds).not.toContain('stepA');
    });
  });
});
