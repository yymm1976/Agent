// tests/agent/context-usage-panel.test.ts
// 上下文占用率面板单元测试（Phase 49 Task 4.2）
//
// 覆盖（蓝图 4.6）：
//   1. 50% 时显示黄色建议（suggestion = consider-compaction）
//   2. 80% 时显示橙色警告（suggestion = should-compact）
//   3. 90% 时显示红色强制（suggestion = must-compact）
//   4. <50% 时显示 ok
//   5. 分项统计正确（systemPrompt / 历史 / 工具结果 / 引用 / Skill）
//   6. token 缓存命中（陷阱 #144）
//   7. 面板更新频率限制为每 3 轮一次（陷阱 #144）
//   8. formatStatusBar 格式正确（含进度条 + 百分比 + 提示）

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ContextUsagePanel,
  estimateTokensSimple,
  type ContextUsageParams,
} from '../../src/agent/context-usage-panel.js';
import type { LLMMessage } from '../../src/router/types.js';

// ============================================================
// 工具函数
// ============================================================

/** 构造一个英文文本（每 4 字符约 1 token） */
function makeEnglishText(tokens: number): string {
  return 'a'.repeat(tokens * 4);
}

/** 构造一个中文文本（每 2 字符约 1 token） */
function makeChineseText(tokens: number): string {
  return '中'.repeat(tokens * 2);
}

/** 构造 calculate 入参，控制 currentTokens 接近 maxTokens 的某个比例 */
function makeParams(percent: number, maxTokens: number = 10000): ContextUsageParams {
  const targetTokens = Math.floor(maxTokens * percent);
  // 用 systemPrompt 占满目标 token 数
  const systemPrompt = makeEnglishText(targetTokens);
  return {
    systemPrompt,
    conversationHistory: [],
    toolResults: [],
    references: [],
    skillPrompts: [],
    maxTokens,
  };
}

/** 构造一条 LLMMessage（字符串内容） */
function makeMessage(role: 'system' | 'user' | 'assistant', content: string): LLMMessage {
  return { role, content };
}

// ============================================================
// 测试
// ============================================================

describe('ContextUsagePanel（Phase 49 Task 4.2）', () => {
  let panel: ContextUsagePanel;

  beforeEach(() => {
    panel = new ContextUsagePanel();
  });

  // ------------------------------------------------------------
  // 1-4. 三级阈值 + ok 判定
  // ------------------------------------------------------------

  describe('三级阈值建议判定', () => {
    it('<50% 时 suggestion = ok', () => {
      const info = panel.calculate(makeParams(0.3));
      expect(info.usagePercent).toBeLessThan(0.5);
      expect(info.suggestion).toBe('ok');
    });

    it('50% 时 suggestion = consider-compaction（含 50% 边界）', () => {
      // 精确构造 50%
      const maxTokens = 10000;
      const systemPrompt = makeEnglishText(5000); // 5000 tokens
      const info = panel.calculate({
        systemPrompt,
        conversationHistory: [],
        toolResults: [],
        references: [],
        skillPrompts: [],
        maxTokens,
      });
      expect(info.usagePercent).toBeGreaterThanOrEqual(0.5);
      expect(info.usagePercent).toBeLessThan(0.8);
      expect(info.suggestion).toBe('consider-compaction');
    });

    it('80% 时 suggestion = should-compact（含 80% 边界）', () => {
      const maxTokens = 10000;
      const systemPrompt = makeEnglishText(8000); // 8000 tokens
      const info = panel.calculate({
        systemPrompt,
        conversationHistory: [],
        toolResults: [],
        references: [],
        skillPrompts: [],
        maxTokens,
      });
      expect(info.usagePercent).toBeGreaterThanOrEqual(0.8);
      expect(info.usagePercent).toBeLessThan(0.9);
      expect(info.suggestion).toBe('should-compact');
    });

    it('90% 时 suggestion = must-compact（含 90% 边界）', () => {
      const maxTokens = 10000;
      const systemPrompt = makeEnglishText(9000); // 9000 tokens
      const info = panel.calculate({
        systemPrompt,
        conversationHistory: [],
        toolResults: [],
        references: [],
        skillPrompts: [],
        maxTokens,
      });
      expect(info.usagePercent).toBeGreaterThanOrEqual(0.9);
      expect(info.suggestion).toBe('must-compact');
    });
  });

  // ------------------------------------------------------------
  // 5. 分项统计正确
  // ------------------------------------------------------------

  describe('分项统计', () => {
    it('各分项 token 数正确（systemPrompt / 历史 / 工具结果 / 引用 / Skill）', () => {
      const maxTokens = 100000;
      const systemPrompt = makeEnglishText(1000); // 1000 tokens
      const conversationHistory: LLMMessage[] = [
        makeMessage('user', makeEnglishText(500)), // 500 tokens
        makeMessage('assistant', makeEnglishText(500)), // 500 tokens
      ];
      const toolResults = [makeEnglishText(200)]; // 200 tokens
      const references = [makeChineseText(100)]; // 100 tokens（中文 2 字符/token）
      const skillPrompts = [makeEnglishText(300)]; // 300 tokens

      const info = panel.calculate({
        systemPrompt,
        conversationHistory,
        toolResults,
        references,
        skillPrompts,
        maxTokens,
      });

      expect(info.breakdown.systemPrompt).toBe(1000);
      expect(info.breakdown.conversationHistory).toBe(1000); // 500 + 500
      expect(info.breakdown.toolResults).toBe(200);
      expect(info.breakdown.references).toBe(100);
      expect(info.breakdown.skillPrompts).toBe(300);
      // 总和
      expect(info.currentTokens).toBe(2600);
    });

    it('ContentPart[] 类型消息的 token 正确统计', () => {
      const conversationHistory: LLMMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: makeEnglishText(100) },
            {
              type: 'tool_result',
              toolUseId: 't1',
              content: makeEnglishText(200),
              isError: false,
            },
          ],
        },
      ];
      const info = panel.calculate({
        systemPrompt: '',
        conversationHistory,
        toolResults: [],
        references: [],
        skillPrompts: [],
        maxTokens: 10000,
      });
      // text(100) + tool_result(200) = 300
      expect(info.breakdown.conversationHistory).toBe(300);
    });
  });

  // ------------------------------------------------------------
  // 6. token 缓存命中（陷阱 #144）
  // ------------------------------------------------------------

  describe('token 缓存（陷阱 #144）', () => {
    it('同一长字符串重复出现时复用缓存结果', () => {
      const longText = makeEnglishText(2000); // 2000 tokens，> 32 字符触发缓存
      const maxTokens = 100000;
      // systemPrompt 和 references 都用同样的长文本
      const info = panel.calculate({
        systemPrompt: longText,
        conversationHistory: [],
        toolResults: [],
        references: [longText],
        skillPrompts: [],
        maxTokens,
      });
      // 两次 2000 = 4000
      expect(info.currentTokens).toBe(4000);
      expect(info.breakdown.systemPrompt).toBe(2000);
      expect(info.breakdown.references).toBe(2000);
    });
  });

  // ------------------------------------------------------------
  // 7. 面板更新频率限制（陷阱 #144）
  // ------------------------------------------------------------

  describe('更新频率限制（陷阱 #144）', () => {
    it('未到更新轮时返回上一次结果（throttle）', () => {
      // 第 1 轮：30% 占用率（无缓存，强制计算）
      const info1 = panel.calculate(makeParams(0.3));
      expect(info1.usagePercent).toBeLessThan(0.5);

      // 第 2 轮：改成 80% 占用率，但应该返回第 1 轮的缓存（2%3≠0，throttle）
      const info2 = panel.calculate(makeParams(0.8));
      expect(info2).toBe(info1); // 同一引用，未重新计算

      // 第 3 轮：3%3===0，到达更新轮，重新计算（90%）
      const info3 = panel.calculate(makeParams(0.9));
      expect(info3).not.toBe(info1);
      expect(info3.usagePercent).toBeGreaterThanOrEqual(0.9);

      // 第 4 轮：4%3≠0，throttle，返回第 3 轮的结果
      const info4 = panel.calculate(makeParams(0.3));
      expect(info4).toBe(info3);
    });

    it('forceCalculate 绕过频率限制立即计算', () => {
      // 先 calculate 一次建立缓存
      const info1 = panel.calculate(makeParams(0.3));
      expect(info1.usagePercent).toBeLessThan(0.5);

      // forceCalculate 应该立即计算新的值
      const info2 = panel.forceCalculate(makeParams(0.9));
      expect(info2.usagePercent).toBeGreaterThanOrEqual(0.9);
      expect(info2).not.toBe(info1);
    });

    it('reset 清空计数器和缓存', () => {
      const info1 = panel.calculate(makeParams(0.3));
      panel.reset();

      // reset 后第 1 轮应该重新计算
      const info2 = panel.calculate(makeParams(0.9));
      expect(info2).not.toBe(info1);
      expect(info2.usagePercent).toBeGreaterThanOrEqual(0.9);
    });
  });

  // ------------------------------------------------------------
  // 8. formatStatusBar 格式正确
  // ------------------------------------------------------------

  describe('formatStatusBar', () => {
    it('格式包含进度条、百分比、提示文本', () => {
      const info = panel.calculate(makeParams(0.52, 10000));
      const bar = panel.formatStatusBar(info);
      // 应包含 [ 和 ] 包裹的进度条
      expect(bar).toMatch(/^\[.*\] \d+% ── .+$/);
      // 52% 应该显示在状态栏
      expect(bar).toContain('52%');
    });

    it('ok 时提示"上下文充足"', () => {
      const info = panel.calculate(makeParams(0.2, 10000));
      const bar = panel.formatStatusBar(info);
      expect(bar).toContain('上下文充足');
    });

    it('consider-compaction 时提示"建议压缩"', () => {
      const info = panel.calculate(makeParams(0.6, 10000));
      const bar = panel.formatStatusBar(info);
      expect(bar).toContain('建议压缩');
    });

    it('must-compact 时提示"即将强制压缩"', () => {
      const info = panel.calculate(makeParams(0.95, 10000));
      const bar = panel.formatStatusBar(info);
      expect(bar).toContain('即将强制压缩');
    });

    it('进度条用 ═ 和 ░ 字符', () => {
      const info = panel.calculate(makeParams(0.5, 10000));
      const bar = panel.formatStatusBar(info);
      // 50% = 10 个 ═ + 10 个 ░
      expect(bar).toContain('═');
      expect(bar).toContain('░');
    });
  });

  // ------------------------------------------------------------
  // 9. estimateTokensSimple 启发式
  // ------------------------------------------------------------

  describe('estimateTokensSimple 启发式', () => {
    it('英文约 4 字符/token', () => {
      const text = 'abcd'; // 4 字符
      expect(estimateTokensSimple(text)).toBe(1);
    });

    it('中文约 2 字符/token', () => {
      const text = '中文'; // 2 字符
      expect(estimateTokensSimple(text)).toBe(1);
    });

    it('混合中英文', () => {
      const text = '中文abcd'; // 2 中文 + 4 英文 = 1 + 1 = 2
      expect(estimateTokensSimple(text)).toBe(2);
    });

    it('空字符串返回 0', () => {
      expect(estimateTokensSimple('')).toBe(0);
    });
  });
});
