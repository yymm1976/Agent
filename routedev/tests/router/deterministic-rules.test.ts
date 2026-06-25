// tests/router/deterministic-rules.test.ts
// Phase 40 Task 2：确定性路由规则单元测试
// 覆盖：exact/startsWith/regex 匹配、无匹配、loadCustomRules、mergeRules、classifier 集成

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  matchDeterministicRule,
  loadCustomRules,
  mergeRules,
  BUILTIN_DETERMINISTIC_RULES,
  type DeterministicRule,
} from '../../src/router/deterministic-rules.js';
import { ScenarioClassifier } from '../../src/router/classifier.js';
import { ModelRouter } from '../../src/router/router.js';
import { TokenTracker } from '../../src/router/tracker.js';
import type { RouterConfig, TokenBudget } from '../../src/router/types.js';

describe('Deterministic Rules', () => {
  describe('matchDeterministicRule - exact matching', () => {
    it('should match /cost exactly → cmd-cost', () => {
      const rule = matchDeterministicRule('/cost');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('cmd-cost');
      expect(rule!.matchType).toBe('exact');
      expect(rule!.handler).toBe('command-dispatch');
      expect(rule!.targetCommand).toBe('cost');
    });

    it('should match /history exactly → cmd-history', () => {
      const rule = matchDeterministicRule('/history');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('cmd-history');
    });

    it('should match /help exactly → cmd-help', () => {
      const rule = matchDeterministicRule('/help');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('cmd-help');
    });

    it('should not match /cost with extra text (exact match)', () => {
      const rule = matchDeterministicRule('/cost extra');
      expect(rule).toBeNull();
    });
  });

  describe('matchDeterministicRule - startsWith matching', () => {
    it('should match /trust status via startsWith → cmd-trust', () => {
      const rule = matchDeterministicRule('/trust status');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('cmd-trust');
      expect(rule!.matchType).toBe('startsWith');
      expect(rule!.targetCommand).toBe('trust');
    });

    it('should match /trust (exact prefix) via startsWith → cmd-trust', () => {
      const rule = matchDeterministicRule('/trust');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('cmd-trust');
    });
  });

  describe('matchDeterministicRule - regex matching', () => {
    it('should match "现在几点" via regex → time-query', () => {
      const rule = matchDeterministicRule('现在几点');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('time-query');
      expect(rule!.matchType).toBe('regex');
      expect(rule!.handler).toBe('direct-response');
      expect(rule!.responseTemplate).toContain('{{now}}');
    });

    it('should match "当前时间" via regex → time-query', () => {
      const rule = matchDeterministicRule('当前时间');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('time-query');
    });

    it('should match "今天几号" via regex → date-query', () => {
      const rule = matchDeterministicRule('今天几号');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('date-query');
    });

    it('should match "读取 src/index.ts" via regex → read-file', () => {
      const rule = matchDeterministicRule('读取 src/index.ts');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('read-file');
      expect(rule!.matchType).toBe('regex');
      expect(rule!.handler).toBe('tool-direct');
      expect(rule!.targetTool).toBe('file_read');
    });

    it('should match "列出 src 目录" via regex → list-dir', () => {
      const rule = matchDeterministicRule('列出 src 目录');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('list-dir');
      expect(rule!.targetTool).toBe('list_directory');
    });

    it('should match "列出 src 目" via regex → list-dir (录 optional)', () => {
      // 正则 目录? 中 ? 仅作用于 录，所以 "目" 是必需的，"录" 可选
      const rule = matchDeterministicRule('列出 src 目');
      expect(rule).not.toBeNull();
      expect(rule!.id).toBe('list-dir');
    });
  });

  describe('matchDeterministicRule - no match', () => {
    it('should return null for unmatched input', () => {
      expect(matchDeterministicRule('hello world')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(matchDeterministicRule('')).toBeNull();
    });

    it('should return null for whitespace-only string', () => {
      expect(matchDeterministicRule('   ')).toBeNull();
    });

    it('should return null for complex query', () => {
      expect(matchDeterministicRule('请帮我重构这个模块的架构设计')).toBeNull();
    });
  });

  describe('loadCustomRules', () => {
    let tmpDir: string;
    let rulesPath: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routedev-test-'));
      rulesPath = path.join(tmpDir, 'deterministic-rules.json');
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should load custom rules from JSON file', async () => {
      const customRules: DeterministicRule[] = [
        {
          id: 'custom-greeting',
          pattern: '你好',
          matchType: 'exact',
          handler: 'direct-response',
          responseTemplate: '你好！',
        },
        {
          id: 'custom-weather',
          pattern: '天气',
          matchType: 'startsWith',
          handler: 'tool-direct',
          targetTool: 'weather_query',
        },
      ];
      await fs.writeFile(rulesPath, JSON.stringify(customRules), 'utf-8');

      const loaded = await loadCustomRules(rulesPath);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe('custom-greeting');
      expect(loaded[1].id).toBe('custom-weather');
    });

    it('should return empty array when file does not exist', async () => {
      const loaded = await loadCustomRules(path.join(tmpDir, 'nonexistent.json'));
      expect(loaded).toEqual([]);
    });

    it('should return empty array when file is not valid JSON', async () => {
      await fs.writeFile(rulesPath, 'not a json', 'utf-8');
      const loaded = await loadCustomRules(rulesPath);
      expect(loaded).toEqual([]);
    });

    it('should return empty array when JSON is not an array', async () => {
      await fs.writeFile(rulesPath, JSON.stringify({ id: 'not-array' }), 'utf-8');
      const loaded = await loadCustomRules(rulesPath);
      expect(loaded).toEqual([]);
    });

    it('should skip invalid rules in the array', async () => {
      const customRules = [
        { id: 'valid-rule', pattern: 'test', matchType: 'exact', handler: 'direct-response' },
        { id: 123, pattern: 'invalid' }, // 缺少 matchType/handler，id 类型错误
        { pattern: 'no-id', matchType: 'exact', handler: 'direct-response' }, // 缺少 id
      ];
      await fs.writeFile(rulesPath, JSON.stringify(customRules), 'utf-8');

      const loaded = await loadCustomRules(rulesPath);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('valid-rule');
    });
  });

  describe('mergeRules', () => {
    it('should append custom rules after builtin rules', () => {
      const custom: DeterministicRule[] = [
        {
          id: 'custom-1',
          pattern: '自定义',
          matchType: 'exact',
          handler: 'direct-response',
          responseTemplate: '自定义响应',
        },
      ];

      const merged = mergeRules(BUILTIN_DETERMINISTIC_RULES, custom);
      expect(merged.length).toBe(BUILTIN_DETERMINISTIC_RULES.length + 1);
      // 内置规则在前
      expect(merged[0].id).toBe(BUILTIN_DETERMINISTIC_RULES[0].id);
      // 自定义规则在后
      expect(merged[merged.length - 1].id).toBe('custom-1');
    });

    it('should deduplicate custom rules with same id as builtin', () => {
      const custom: DeterministicRule[] = [
        {
          id: 'cmd-cost', // 与内置规则 id 重复
          pattern: '/cost-override',
          matchType: 'exact',
          handler: 'direct-response',
          responseTemplate: 'override',
        },
        {
          id: 'custom-new',
          pattern: '新规则',
          matchType: 'exact',
          handler: 'direct-response',
        },
      ];

      const merged = mergeRules(BUILTIN_DETERMINISTIC_RULES, custom);
      // 重复 id 被跳过，只保留自定义中的新规则
      expect(merged.length).toBe(BUILTIN_DETERMINISTIC_RULES.length + 1);
      // 内置 cmd-cost 保留（不被覆盖）
      const cmdCostRule = merged.find((r) => r.id === 'cmd-cost');
      expect(cmdCostRule).toBeDefined();
      expect(cmdCostRule!.pattern).toBe('/cost');
      // 新规则被追加
      expect(merged.some((r) => r.id === 'custom-new')).toBe(true);
    });

    it('should handle empty custom rules', () => {
      const merged = mergeRules(BUILTIN_DETERMINISTIC_RULES, []);
      expect(merged.length).toBe(BUILTIN_DETERMINISTIC_RULES.length);
    });

    it('should handle empty builtin rules', () => {
      const custom: DeterministicRule[] = [
        { id: 'custom-1', pattern: 'test', matchType: 'exact', handler: 'direct-response' },
      ];
      const merged = mergeRules([], custom);
      expect(merged.length).toBe(1);
      expect(merged[0].id).toBe('custom-1');
    });
  });

  describe('Classifier integration', () => {
    const classifier = new ScenarioClassifier({
      classifierModel: 'gpt-4o-mini',
      // 不传 llmClient，测试 deterministic 是否在不触发 LLM 的情况下命中
    });

    it('should classify /cost as deterministic (not triggering LLM)', async () => {
      const result = await classifier.classify({ query: '/cost' });
      expect(result.tier).toBe('deterministic');
      expect(result.source).toBe('deterministic');
      expect(result.confidence).toBe(1.0);
      expect(result.matchedRuleId).toBe('cmd-cost');
    });

    it('should classify /trust status as deterministic', async () => {
      const result = await classifier.classify({ query: '/trust status' });
      expect(result.tier).toBe('deterministic');
      expect(result.source).toBe('deterministic');
      expect(result.matchedRuleId).toBe('cmd-trust');
    });

    it('should classify "现在几点" as deterministic', async () => {
      const result = await classifier.classify({ query: '现在几点' });
      expect(result.tier).toBe('deterministic');
      expect(result.source).toBe('deterministic');
      expect(result.matchedRuleId).toBe('time-query');
    });

    it('should classify "读取 src/index.ts" as deterministic', async () => {
      const result = await classifier.classify({ query: '读取 src/index.ts' });
      expect(result.tier).toBe('deterministic');
      expect(result.matchedRuleId).toBe('read-file');
    });

    it('should not classify complex query as deterministic', async () => {
      const result = await classifier.classify({ query: '请帮我重构这个模块' });
      expect(result.tier).not.toBe('deterministic');
      expect(result.source).not.toBe('deterministic');
    });

    it('should prioritize command matching over deterministic rules', async () => {
      // /status 既匹配命令匹配（matchCommand）也匹配确定性规则（cmd-status）
      // 命令匹配优先级更高，应返回 source='rule'
      const result = await classifier.classify({ query: '/status' });
      // 命令匹配在前，应命中 source='rule'
      expect(result.source).toBe('rule');
    });
  });

  describe('Router integration', () => {
    let router: ModelRouter;
    let tracker: TokenTracker;

    const budget: TokenBudget = {
      mode: 'enforce',
      dailyLimit: 1000000,
      degradationThreshold: 0.8,
    };

    const config: RouterConfig = {
      rules: [
        { tier: 'simple', modelId: 'gpt-4o-mini', fallbackModelId: 'gpt-4o' },
        { tier: 'medium', modelId: 'gpt-4o', fallbackModelId: 'gpt-4o-mini' },
        { tier: 'complex', modelId: 'o3-mini', fallbackModelId: 'gpt-4o' },
        { tier: 'reasoning', modelId: 'o3', fallbackModelId: 'o3-mini' },
      ],
      budget,
      classifierModel: 'gpt-4o-mini',
      userPreference: 'balanced',
    };

    beforeEach(() => {
      tracker = new TokenTracker(budget);
      router = new ModelRouter(config, tracker);
    });

    afterEach(() => {
      tracker.destroy();
    });

    it('should return deterministic=true for deterministic classification', async () => {
      const classification = {
        tier: 'deterministic' as const,
        confidence: 1.0,
        reasoning: 'Deterministic rule matched: cmd-cost',
        source: 'deterministic' as const,
        matchedRuleId: 'cmd-cost',
      };
      const result = await router.route(classification);
      expect(result.deterministic).toBe(true);
      expect(result.matchedRuleId).toBe('cmd-cost');
      expect(result.enableCache).toBe(false);
      // 使用最低成本模型（simple tier）
      expect(result.model.id).toBe('gpt-4o-mini');
    });

    it('should not set deterministic for normal classification', async () => {
      const classification = {
        tier: 'simple' as const,
        confidence: 0.9,
        reasoning: 'Simple command',
        source: 'rule' as const,
      };
      const result = await router.route(classification);
      expect(result.deterministic).toBeUndefined();
      expect(result.matchedRuleId).toBeUndefined();
    });
  });
});
