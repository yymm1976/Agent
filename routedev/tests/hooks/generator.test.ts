// tests/hooks/generator.test.ts
// Phase 39 Task 2：HookGenerator 单元测试
// 覆盖：模板匹配、安全审查、LLM 生成（mock LLM）

import { describe, it, expect, vi } from 'vitest';
import {
  HookGenerator,
  type HookGenerationRequest,
  type GeneratedHook,
} from '../../src/hooks/generator.js';
import type { ILLMClient, LLMResponse } from '../../src/router/types.js';

// ============================================================
// Mock 工厂
// ============================================================

/** 构造 mock ILLMClient，返回指定的 responseContent */
function makeLlmClient(responseContent: string): ILLMClient {
  const response: LLMResponse = {
    content: responseContent,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
    model: 'test-model',
  };
  return {
    protocol: 'openai',
    providerId: 'test',
    complete: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
  };
}

/** 构造 LLM 返回的 Hook JSON */
function makeHookJson(opts: {
  name: string;
  event: string;
  condition?: string;
  command: string;
  failBehavior: string;
}): string {
  return JSON.stringify(opts);
}

// ============================================================
// 测试用例
// ============================================================

describe('HookGenerator (Phase 39 Task 2)', () => {
  // ============================================================
  // 模板匹配
  // ============================================================
  describe('模板匹配', () => {
    it('"格式化" 应匹配 auto-format 模板', async () => {
      const generator = new HookGenerator(); // 无 LLM
      const request: HookGenerationRequest = {
        description: '保存文件后自动格式化',
      };

      const hook = await generator.generate(request);

      expect(hook.name).toBe('auto-format');
      expect(hook.event).toBe('post-tool-call');
      expect(hook.command).toContain('prettier');
      expect(hook.command).toContain('{{filePath}}');
      expect(hook.failBehavior).toBe('warn');
      // 模板命令 prettier 不含危险操作，安全审查应通过
      expect(hook.securityReview.passed).toBe(true);
      expect(hook.securityReview.warnings).toHaveLength(0);
    });

    it('"prettier" 关键词应匹配 auto-format 模板', async () => {
      const generator = new HookGenerator();
      const hook = await generator.generate({ description: '我想用 prettier 格式化代码' });

      expect(hook.name).toBe('auto-format');
    });

    it('"测试" 关键词应匹配 pre-commit-test 模板', async () => {
      const generator = new HookGenerator();
      const hook = await generator.generate({ description: '提交前运行测试' });

      expect(hook.name).toBe('pre-commit-test');
      expect(hook.event).toBe('pre-step');
      expect(hook.command).toContain('npm test');
      expect(hook.failBehavior).toBe('block');
    });

    it('"敏感信息" 关键词应匹配 secret-detect 模板', async () => {
      const generator = new HookGenerator();
      const hook = await generator.generate({ description: '检测代码中的敏感信息' });

      expect(hook.name).toBe('secret-detect');
      expect(hook.event).toBe('post-tool-call');
      expect(hook.failBehavior).toBe('block');
    });

    it('matchTemplate 直接调用应返回模板对象', () => {
      const generator = new HookGenerator();

      const matched = generator.matchTemplate('保存后格式化代码');
      expect(matched).not.toBeNull();
      expect(matched!.id).toBe('auto-format');

      const unmatched = generator.matchTemplate('这是一个完全无关的描述 xyz123');
      expect(unmatched).toBeNull();
    });

    it('listTemplates 应返回所有 10 个模板', () => {
      const generator = new HookGenerator();
      const templates = generator.listTemplates();

      expect(templates.length).toBe(10);
      const ids = templates.map((t) => t.id).sort();
      expect(ids).toContain('auto-format');
      expect(ids).toContain('pre-commit-test');
      expect(ids).toContain('secret-detect');
      expect(ids).toContain('no-console');
      expect(ids).toContain('import-check');
      expect(ids).toContain('type-check');
      expect(ids).toContain('danger-cmd-confirm');
      expect(ids).toContain('auto-comment');
      expect(ids).toContain('session-notify');
      expect(ids).toContain('token-alert');
    });
  });

  // ============================================================
  // 安全审查
  // ============================================================
  describe('安全审查', () => {
    it('rm -rf 命令应被标记为危险', () => {
      const generator = new HookGenerator();
      const review = generator.reviewSecurity('rm -rf /tmp/test');

      expect(review.passed).toBe(false);
      expect(review.warnings.length).toBeGreaterThan(0);
      expect(review.warnings.some((w) => w.includes('rm -rf'))).toBe(true);
    });

    it('git push --force 命令应被标记为危险', () => {
      const generator = new HookGenerator();
      const review = generator.reviewSecurity('git push --force origin main');

      expect(review.passed).toBe(false);
      expect(review.warnings.some((w) => w.includes('git push --force'))).toBe(true);
    });

    it('format 命令应被标记为危险', () => {
      const generator = new HookGenerator();
      const review = generator.reviewSecurity('format C:');

      expect(review.passed).toBe(false);
      expect(review.warnings.some((w) => w.includes('format'))).toBe(true);
    });

    it('fork bomb 模式应被标记为危险', () => {
      const generator = new HookGenerator();
      const review = generator.reviewSecurity(':(){ :|:& };:');

      expect(review.passed).toBe(false);
      expect(review.warnings.some((w) => w.includes('fork bomb'))).toBe(true);
    });

    it('安全命令应通过审查', () => {
      const generator = new HookGenerator();
      const review = generator.reviewSecurity('npx prettier --write {{filePath}}');

      expect(review.passed).toBe(true);
      expect(review.warnings).toHaveLength(0);
    });

    it('LLM 生成含 rm -rf 时安全审查应标记并附在 GeneratedHook 上', async () => {
      const llmJson = makeHookJson({
        name: 'dangerous-cleanup',
        event: 'post-tool-call',
        command: 'rm -rf node_modules',
        failBehavior: 'warn',
      });
      const client = makeLlmClient(llmJson);
      const generator = new HookGenerator(client, 'test-model');

      // 使用一个不会匹配任何模板的描述
      const hook = await generator.generate({ description: '清理项目临时文件的独特描述 xyz789' });

      expect(hook.name).toBe('dangerous-cleanup');
      expect(hook.command).toBe('rm -rf node_modules');
      expect(hook.securityReview.passed).toBe(false);
      expect(hook.securityReview.warnings.some((w) => w.includes('rm -rf'))).toBe(true);
    });
  });

  // ============================================================
  // LLM 生成
  // ============================================================
  describe('LLM 生成', () => {
    it('模板不匹配时应调用 LLM 生成 Hook', async () => {
      const llmJson = makeHookJson({
        name: 'custom-hook',
        event: 'post-step',
        condition: 'always',
        command: 'echo "step done"',
        failBehavior: 'silent',
      });
      const client = makeLlmClient(llmJson);
      const generator = new HookGenerator(client, 'test-model');

      const hook = await generator.generate({ description: '一个完全独特的描述 xyz999' });

      expect(hook.name).toBe('custom-hook');
      expect(hook.event).toBe('post-step');
      expect(hook.condition).toBe('always');
      expect(hook.command).toBe('echo "step done"');
      expect(hook.failBehavior).toBe('silent');
      // echo 命令安全
      expect(hook.securityReview.passed).toBe(true);

      // 验证 LLM 被调用
      expect(client.complete).toHaveBeenCalledTimes(1);
    });

    it('应能解析带 ```json 代码块的 LLM 响应', async () => {
      const llmJson = '```json\n' + makeHookJson({
        name: 'code-block-hook',
        event: 'pre-step',
        command: 'echo "pre"',
        failBehavior: 'warn',
      }) + '\n```';
      const client = makeLlmClient(llmJson);
      const generator = new HookGenerator(client, 'test-model');

      const hook = await generator.generate({ description: '独特描述 abc888' });

      expect(hook.name).toBe('code-block-hook');
      expect(hook.event).toBe('pre-step');
    });

    it('模板不匹配且无 LLM 时应抛出错误', async () => {
      const generator = new HookGenerator(); // 无 LLM

      await expect(
        generator.generate({ description: '完全独特的描述 xyz12345' }),
      ).rejects.toThrow('无法生成 Hook');
    });

    it('空描述应抛出错误', async () => {
      const client = makeLlmClient('{}');
      const generator = new HookGenerator(client, 'test-model');

      await expect(generator.generate({ description: '' })).rejects.toThrow('不能为空');
      await expect(generator.generate({ description: '   ' })).rejects.toThrow('不能为空');
    });

    it('LLM 返回非法 event 应抛出错误', async () => {
      const llmJson = makeHookJson({
        name: 'bad-event',
        event: 'invalid-event',
        command: 'echo test',
        failBehavior: 'warn',
      });
      const client = makeLlmClient(llmJson);
      const generator = new HookGenerator(client, 'test-model');

      await expect(
        generator.generate({ description: '独特描述 def777' }),
      ).rejects.toThrow('event 不合法');
    });

    it('LLM 返回 on-model-call 事件应被接受（扩展事件类型）', async () => {
      const llmJson = makeHookJson({
        name: 'token-watcher',
        event: 'on-model-call',
        command: 'echo "check tokens"',
        failBehavior: 'warn',
      });
      const client = makeLlmClient(llmJson);
      const generator = new HookGenerator(client, 'test-model');

      const hook = await generator.generate({ description: '独特描述 ghi555' });

      expect(hook.event).toBe('on-model-call');
    });
  });
});
