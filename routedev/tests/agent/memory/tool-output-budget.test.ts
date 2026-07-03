import { describe, it, expect, beforeEach } from 'vitest';
import {
  ToolOutputBudgetManager,
  DEFAULT_BUDGET_CONFIG,
  type ToolOutputBudgetConfig,
} from '../../../src/agent/memory/tool-output-budget.js';

interface TestMessage {
  role: string;
  content: string;
}

function makeConfig(overrides?: Partial<ToolOutputBudgetConfig>): ToolOutputBudgetConfig {
  return { ...DEFAULT_BUDGET_CONFIG, enabled: true, ...overrides };
}

function makeLongText(length: number): string {
  return 'A'.repeat(length);
}

describe('ToolOutputBudgetManager', () => {
  let manager: ToolOutputBudgetManager;

  beforeEach(() => {
    manager = new ToolOutputBudgetManager(makeConfig());
  });

  it('短输出不修改', async () => {
    const messages: TestMessage[] = [
      { role: 'assistant', content: 'short output' },
    ];
    const result = await manager.processMessages(
      messages,
      (m) => m.content,
      (m, t) => ({ ...m, content: t }),
    );
    expect(result.messages[0].content).toBe('short output');
    expect(result.offloadedCount).toBe(0);
  });

  it('长输出替换为 preview', async () => {
    const longText = makeLongText(3000);
    const messages: TestMessage[] = [
      { role: 'assistant', content: longText },
    ];
    const result = await manager.processMessages(
      messages,
      (m) => m.content,
      (m, t) => ({ ...m, content: t }),
    );
    expect(result.messages[0].content).toContain('<persisted-output');
    expect(result.messages[0].content).toContain('3000 chars total');
    expect(result.offloadedCount).toBe(1);
  });

  it('相同内容哈希去重', async () => {
    const longText = makeLongText(3000);
    const messages: TestMessage[] = [
      { role: 'assistant', content: longText },
      { role: 'assistant', content: longText },
    ];
    const result = await manager.processMessages(
      messages,
      (m) => m.content,
      (m, t) => ({ ...m, content: t }),
    );
    expect(result.messages[0].content).toContain('<persisted-output');
    expect(result.messages[1].content).toContain('<persisted-output');
    expect(result.messages[0].content).toBe(result.messages[1].content);
    expect(manager.getProcessedCount()).toBe(1);
  });

  it('错误时回退到截断', async () => {
    const longText = makeLongText(3000);
    const messages: TestMessage[] = [
      { role: 'assistant', content: longText },
    ];
    const offloadDir = 'Z:\\nonexistent\\path\\that\\does\\not\\exist';
    const brokenManager = new ToolOutputBudgetManager(
      makeConfig({ offloadDir }),
    );
    const originalDate = Date.now;
    let callCount = 0;
    Date.now = () => {
      callCount++;
      if (callCount === 1) throw new Error('Date.now failed');
      return originalDate();
    };
    try {
      const result = await brokenManager.processMessages(
        messages,
        (m) => m.content,
        (m, t) => ({ ...m, content: t }),
      );
      expect(result.messages[0].content).toContain('[...truncated...]');
      expect(result.offloadedCount).toBe(1);
    } finally {
      Date.now = originalDate;
    }
  });

  it('配置禁用时跳过所有处理', async () => {
    const disabledManager = new ToolOutputBudgetManager(makeConfig({ enabled: false }));
    const longText = makeLongText(3000);
    const messages: TestMessage[] = [
      { role: 'assistant', content: longText },
    ];
    const result = await disabledManager.processMessages(
      messages,
      (m) => m.content,
      (m, t) => ({ ...m, content: t }),
    );
    expect(result.messages[0].content).toBe(longText);
    expect(result.offloadedCount).toBe(0);
  });

  it('preview 包含 head 和 tail', async () => {
    const headChars = 100;
    const tailChars = 100;
    const manager = new ToolOutputBudgetManager(
      makeConfig({ previewHeadChars: headChars, previewTailChars: tailChars }),
    );
    const content = 'H'.repeat(headChars) + 'M'.repeat(3000) + 'T'.repeat(tailChars);
    const messages: TestMessage[] = [
      { role: 'assistant', content },
    ];
    const result = await manager.processMessages(
      messages,
      (m) => m.content,
      (m, t) => ({ ...m, content: t }),
    );
    const preview = result.messages[0].content;
    expect(preview).toContain('H'.repeat(headChars));
    expect(preview).toContain('T'.repeat(tailChars));
    expect(preview).toContain('<persisted-output');
    expect(preview).toContain('</persisted-output>');
  });

  it('getProcessedCount 追踪已处理项', async () => {
    expect(manager.getProcessedCount()).toBe(0);
    const longText1 = 'A'.repeat(1500) + 'B'.repeat(1500);
    const longText2 = 'C'.repeat(1500) + 'D'.repeat(1500);
    const messages: TestMessage[] = [
      { role: 'assistant', content: longText1 },
      { role: 'assistant', content: longText2 },
    ];
    await manager.processMessages(
      messages,
      (m) => m.content,
      (m, t) => ({ ...m, content: t }),
    );
    expect(manager.getProcessedCount()).toBe(2);
  });
});
