// tests/agent/patterns/prompt-chain.test.ts
// Phase 49 Task 6.5：提示链模式单元测试
//
// 覆盖蓝图 6.5 节测试要求：
//   1. PromptChain 串行执行步骤
//   2. 每步输出传递给下一步（appendContext=true）
//   3. appendContext=false 时不传递前一步输出（额外覆盖）
//   4. 空步骤列表直接完成（额外覆盖）

import { describe, it, expect, vi } from 'vitest';
import { PromptChain, type ChainStep, type ChainEvent } from '../../../src/agent/patterns/prompt-chain.js';

// ============================================================
// 辅助函数
// ============================================================

/** 收集所有 ChainEvent */
async function collectEvents(gen: AsyncGenerator<ChainEvent>): Promise<ChainEvent[]> {
  const events: ChainEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ============================================================
// 测试套件
// ============================================================

describe('PromptChain (Phase 49 Task 6.5)', () => {
  // ============================================================
  // 测试 1：串行执行步骤且每步输出传递给下一步
  // ============================================================
  it('1. PromptChain 串行执行步骤且每步输出传递给下一步', async () => {
    // 记录每步实际收到的输入，便于断言上下文传递
    const actualInputs: { stepId: string; input: string }[] = [];
    const executeStep = vi.fn(async (step: ChainStep, actualInput: string) => {
      actualInputs.push({ stepId: step.id, input: actualInput });
      // 每步返回一个标识符，便于追踪
      return `output-${step.id}`;
    });

    const chain = new PromptChain(executeStep);
    const steps: ChainStep[] = [
      { id: 'analyze', input: '分析这段代码', appendContext: false },
      { id: 'summarize', input: '总结分析结果', appendContext: true },
      { id: 'translate', input: '翻译为英文', appendContext: true },
    ];

    const events = await collectEvents(chain.execute(steps));

    // 应该有 3 个 chain-step-complete + 1 个 chain-complete
    const stepCompletes = events.filter(e => e.type === 'chain-step-complete');
    const completes = events.filter(e => e.type === 'chain-complete');
    expect(stepCompletes).toHaveLength(3);
    expect(completes).toHaveLength(1);

    // 第一步：appendContext=false，input 应该只是 step.input
    expect(actualInputs[0]).toEqual({
      stepId: 'analyze',
      input: '分析这段代码',
    });

    // 第二步：appendContext=true，input 应该包含前一步输出
    expect(actualInputs[1].stepId).toBe('summarize');
    expect(actualInputs[1].input).toContain('总结分析结果');
    expect(actualInputs[1].input).toContain('前一步结果：output-analyze');

    // 第三步：appendContext=true，input 应该包含第二步输出（不是第一步）
    expect(actualInputs[2].stepId).toBe('translate');
    expect(actualInputs[2].input).toContain('翻译为英文');
    expect(actualInputs[2].input).toContain('前一步结果：output-summarize');
    // 不应包含第一步的输出（context 只保留最近一步）
    expect(actualInputs[2].input).not.toContain('output-analyze');

    // 最终输出应该是最后一步的输出
    if (completes[0].type === 'chain-complete') {
      expect(completes[0].finalOutput).toBe('output-translate');
      expect(completes[0].results).toHaveLength(3);
      expect(completes[0].results[0].output).toBe('output-analyze');
      expect(completes[0].results[2].output).toBe('output-translate');
    }

    // executeStep 应该被调用 3 次
    expect(executeStep).toHaveBeenCalledTimes(3);
  });

  // ============================================================
  // 测试 2：appendContext=false 时不传递前一步输出
  // ============================================================
  it('2. appendContext=false 的步骤不接收前一步输出', async () => {
    const actualInputs: string[] = [];
    const executeStep = vi.fn(async (step: ChainStep, actualInput: string) => {
      actualInputs.push(actualInput);
      return `out-${step.id}`;
    });

    const chain = new PromptChain(executeStep);
    const steps: ChainStep[] = [
      { id: 'a', input: '步骤A', appendContext: false },
      { id: 'b', input: '步骤B', appendContext: false }, // 不接收 a 的输出
      { id: 'c', input: '步骤C', appendContext: false },
    ];

    await collectEvents(chain.execute(steps));

    // 每步的 input 都只是 step.input，不含前一步结果
    expect(actualInputs[0]).toBe('步骤A');
    expect(actualInputs[1]).toBe('步骤B');
    expect(actualInputs[2]).toBe('步骤C');
  });

  // ============================================================
  // 测试 3：步骤序号和总数正确
  // ============================================================
  it('3. chain-step-complete 事件携带正确的 index 和 total', async () => {
    const executeStep = vi.fn(async (step: ChainStep) => `out-${step.id}`);
    const chain = new PromptChain(executeStep);
    const steps: ChainStep[] = [
      { id: 'a', input: 'A', appendContext: false },
      { id: 'b', input: 'B', appendContext: true },
      { id: 'c', input: 'C', appendContext: true },
    ];

    const events = await collectEvents(chain.execute(steps));
    const stepCompletes = events.filter(e => e.type === 'chain-step-complete');

    expect(stepCompletes).toHaveLength(3);
    if (stepCompletes[0].type === 'chain-step-complete') {
      expect(stepCompletes[0].index).toBe(1);
      expect(stepCompletes[0].total).toBe(3);
      expect(stepCompletes[0].stepId).toBe('a');
    }
    if (stepCompletes[2].type === 'chain-step-complete') {
      expect(stepCompletes[2].index).toBe(3);
      expect(stepCompletes[2].total).toBe(3);
      expect(stepCompletes[2].stepId).toBe('c');
    }
  });

  // ============================================================
  // 测试 4：空步骤列表直接完成
  // ============================================================
  it('4. 空步骤列表直接产生 chain-complete 事件', async () => {
    const executeStep = vi.fn(async (step: ChainStep) => `out-${step.id}`);
    const chain = new PromptChain(executeStep);

    const events = await collectEvents(chain.execute([]));

    // 不应该有 chain-step-complete
    expect(events.filter(e => e.type === 'chain-step-complete')).toHaveLength(0);
    // 应该直接产生 chain-complete
    const completes = events.filter(e => e.type === 'chain-complete');
    expect(completes).toHaveLength(1);
    if (completes[0].type === 'chain-complete') {
      expect(completes[0].finalOutput).toBe('');
      expect(completes[0].results).toHaveLength(0);
    }
    // executeStep 不应被调用
    expect(executeStep).not.toHaveBeenCalled();
  });

  // ============================================================
  // 测试 5：单步执行失败时抛出异常
  // ============================================================
  it('5. 单步执行失败时抛出异常终止整条链', async () => {
    const executeStep = vi.fn(async (step: ChainStep) => {
      if (step.id === 'b') {
        throw new Error('step b failed');
      }
      return `out-${step.id}`;
    });

    const chain = new PromptChain(executeStep);
    const steps: ChainStep[] = [
      { id: 'a', input: 'A', appendContext: false },
      { id: 'b', input: 'B', appendContext: true },
      { id: 'c', input: 'C', appendContext: true }, // 不应执行
    ];

    await expect(collectEvents(chain.execute(steps))).rejects.toThrow('step b failed');
    expect(executeStep).toHaveBeenCalledTimes(2); // a 和 b 被调用，c 未被调用
  });
});
