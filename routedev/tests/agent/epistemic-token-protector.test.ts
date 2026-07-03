// tests/agent/epistemic-token-protector.test.ts
// Phase 67 Task 3：认知不确定性 token 保护器单元测试
//
// 覆盖蓝图 Task 3 测试要求：
//   1. scanTokens 命中所有 10 个 epistemic token
//   2. 大小写不敏感
//   3. hasEpistemicToken 正确性
//   4. computeProtectedLineRanges 保护 [i-N, i+N] 范围
//   5. protectMessage shouldKeep=true 时原样返回
//   6. protectMessage shouldKeep=false 且无 epistemic token 时返回空
//   7. protectMessage shouldKeep=false 且有 epistemic token 时保留邻域行

import { describe, it, expect, beforeEach } from 'vitest';
import {
  EpistemicTokenProtector,
  EPISTEMIC_TOKENS,
  DEFAULT_EPISTEMIC_TOKEN_PROTECTOR_CONFIG,
} from '../../src/agent/epistemic-token-protector.js';

// ============================================================
// 测试套件
// ============================================================

describe('EpistemicTokenProtector (Phase 67 Task 3)', () => {
  let protector: EpistemicTokenProtector;

  beforeEach(() => {
    protector = new EpistemicTokenProtector({
      enabled: true,
      neighborhoodLines: 3,
    });
  });

  // ============================================================
  // 测试 1：scanTokens 命中所有 10 个 epistemic token
  // ============================================================
  it('1. scanTokens 应命中所有 10 个 epistemic token', () => {
    // 构造包含所有 10 个 token 的内容（每个 token 独立成行）
    const content = [
      'wait let me think',
      'hmm this is tricky',
      'actually that is wrong',
      'let me reconsider the approach',
      'on second thought maybe not',
      'but this could fail',
      'however the alternative works',
      'perhaps we should try',
      'maybe tomorrow',
      'not sure about this',
    ].join('\n');

    const hits = protector.scanTokens(content);

    // 应至少命中 10 次（每个 token 至少 1 次，有些行可能有多次匹配）
    expect(hits.length).toBeGreaterThanOrEqual(10);

    // 验证所有 10 个内置 token 都被命中
    const hitTokensLower = new Set(hits.map(h => h.token.toLowerCase()));
    for (const token of EPISTEMIC_TOKENS) {
      expect(hitTokensLower.has(token.toLowerCase())).toBe(true);
    }

    // 验证 EPISTEMIC_TOKENS 常量正好包含 10 个 token
    expect(EPISTEMIC_TOKENS.length).toBe(10);
  });

  // ============================================================
  // 测试 2：大小写不敏感
  // ============================================================
  it('2. scanTokens 应大小写不敏感匹配', () => {
    const content = 'WAIT this is important\nHmm let me think\nBUT we need to try';
    const hits = protector.scanTokens(content);

    // 应命中 3 次（WAIT, Hmm, BUT）
    expect(hits.length).toBe(3);

    // 验证命中的 token 保留原始大小写
    const tokens = hits.map(h => h.token);
    expect(tokens).toContain('WAIT');
    expect(tokens).toContain('Hmm');
    expect(tokens).toContain('BUT');

    // 验证行号正确（0-based）
    expect(hits[0].lineIndex).toBe(0); // WAIT 在第 1 行
    expect(hits[1].lineIndex).toBe(1); // Hmm 在第 2 行
    expect(hits[2].lineIndex).toBe(2); // BUT 在第 3 行
  });

  // ============================================================
  // 测试 3：hasEpistemicToken 正确性
  // ============================================================
  it('3. hasEpistemicToken 应正确判断是否包含 epistemic token', () => {
    // 包含 epistemic token
    expect(protector.hasEpistemicToken('wait, this is important')).toBe(true);
    expect(protector.hasEpistemicToken('the answer is correct')).toBe(false);
    expect(protector.hasEpistemicToken('PERHAPS we should reconsider')).toBe(true);

    // 空内容
    expect(protector.hasEpistemicToken('')).toBe(false);

    // 包含子串但非独立词的情况
    // "butter" 包含 "but"，但 should not match as standalone token
    // 但 hasEpistemicToken 使用简单 includes，所以 "butter" 会被误判
    // 这是设计权衡（性能优先），scanTokens 才用 word boundary
    expect(protector.hasEpistemicToken('butter is good')).toBe(true); // 简单 includes
  });

  // ============================================================
  // 测试 4：computeProtectedLineRanges 保护 [i-N, i+N] 范围
  // ============================================================
  it('4. computeProtectedLineRanges 应保护 [i-N, i+N] 范围', () => {
    // neighborhoodLines=3，构造 10 行内容，命中在第 5 行（索引 4）
    const lines = [
      'line 0',
      'line 1',
      'line 2',
      'line 3',
      'wait, this needs reconsideration', // 命中行，索引 4
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'line 9',
    ];
    const content = lines.join('\n');

    const ranges = protector.computeProtectedLineRanges(content);

    // 应有 1 个范围
    expect(ranges.length).toBe(1);
    // 范围应是 [4-3, 4+3] = [1, 7]
    expect(ranges[0].start).toBe(1);
    expect(ranges[0].end).toBe(7);
  });

  // ============================================================
  // 测试 4.1：computeProtectedLineRanges 合并重叠范围
  // ============================================================
  it('4.1. computeProtectedLineRanges 应合并重叠或相邻范围', () => {
    // neighborhoodLines=3，两个命中行间隔小于 2N=6 时范围重叠
    const lines = [
      'line 0',
      'wait here', // 命中行 1，索引 1，保护 [0, 4]
      'line 2',
      'line 3',
      'line 4',
      'but this fails', // 命中行 2，索引 5，保护 [2, 8]
      'line 6',
      'line 7',
      'line 8',
      'line 9',
    ];
    const content = lines.join('\n');

    const ranges = protector.computeProtectedLineRanges(content);

    // 两个范围 [0,4] 和 [2,8] 重叠，应合并为 [0, 8]
    expect(ranges.length).toBe(1);
    expect(ranges[0].start).toBe(0);
    expect(ranges[0].end).toBe(8);
  });

  // ============================================================
  // 测试 5：protectMessage shouldKeep=true 时原样返回
  // ============================================================
  it('5. protectMessage shouldKeep=true 时应原样返回', () => {
    const content = 'wait, this is important\nhmm let me think';
    const result = protector.protectMessage(content, true);

    expect(result).toBe(content);
  });

  // ============================================================
  // 测试 6：protectMessage shouldKeep=false 且无 epistemic token 时返回空
  // ============================================================
  it('6. protectMessage shouldKeep=false 且无 epistemic token 时应返回空', () => {
    const content = 'the answer is 42\nthis is a fact';
    const result = protector.protectMessage(content, false);

    expect(result).toBe('');
  });

  // ============================================================
  // 测试 7：protectMessage shouldKeep=false 且有 epistemic token 时保留邻域行
  // ============================================================
  it('7. protectMessage shouldKeep=false 且有 epistemic token 时应保留邻域行（标注 [epistemic-protected]）', () => {
    // neighborhoodLines=1（缩小范围便于测试）
    const protectorN1 = new EpistemicTokenProtector({
      enabled: true,
      neighborhoodLines: 1,
    });

    const lines = [
      'line 0',                                  // 索引 0，不在保护范围
      'wait, this needs reconsideration',        // 索引 1，命中行，保护 [0, 2]
      'line 2',                                  // 索引 2，在保护范围
      'line 3',                                  // 索引 3，不在保护范围
      'line 4',                                  // 索引 4，不在保护范围
    ];
    const content = lines.join('\n');
    const result = protectorN1.protectMessage(content, false);

    // 应包含 [epistemic-protected] 标注
    expect(result).toContain('[epistemic-protected]');
    // 应保留命中行
    expect(result).toContain('wait, this needs reconsideration');
    // 应保留邻域行（line 0 和 line 2）
    expect(result).toContain('line 0');
    expect(result).toContain('line 2');
    // 不应包含未被保护的行
    expect(result).not.toContain('line 3');
    expect(result).not.toContain('line 4');
  });

  // ============================================================
  // 额外测试 8：countEpistemicTokens 正确性
  // ============================================================
  it('8. countEpistemicTokens 应正确统计 token 出现次数', () => {
    // 包含 3 次 epistemic token
    const content = 'wait\nhmm\nbut';
    expect(protector.countEpistemicTokens(content)).toBe(3);

    // 不包含
    expect(protector.countEpistemicTokens('the answer is 42')).toBe(0);

    // 同一 token 多次出现
    const content2 = 'wait\nwait\nwait';
    expect(protector.countEpistemicTokens(content2)).toBe(3);
  });

  // ============================================================
  // 额外测试 9：自定义 token 合并
  // ============================================================
  it('9. 应支持自定义 token 与内置 token 合并', () => {
    const protectorCustom = new EpistemicTokenProtector({
      enabled: true,
      neighborhoodLines: 3,
      customTokens: ['lemme see', 'arguably'],
    });

    // 内置 token 仍可命中
    expect(protectorCustom.hasEpistemicToken('wait a moment')).toBe(true);
    // 自定义 token 也可命中
    expect(protectorCustom.hasEpistemicToken('lemme see what we have')).toBe(true);
    expect(protectorCustom.hasEpistemicToken('arguably this is correct')).toBe(true);
  });

  // ============================================================
  // 额外测试 10：配置关闭时仍可工作（fail-open）
  // ============================================================
  it('10. 配置关闭时 protectMessage shouldKeep=true 仍原样返回', () => {
    const disabledProtector = new EpistemicTokenProtector({
      ...DEFAULT_EPISTEMIC_TOKEN_PROTECTOR_CONFIG,
      enabled: false,
    });
    const content = 'wait, this is important';
    const result = disabledProtector.protectMessage(content, true);
    expect(result).toBe(content);
  });
});
