// tests/agent/token-profiler.test.ts
// Phase 30 Task 1：TokenProfiler 单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TokenProfiler } from '../../src/agent/token-profiler.js';
import type { LLMMessage } from '../../src/router/types.js';

describe('TokenProfiler', () => {
  let profiler: TokenProfiler;

  beforeEach(() => {
    profiler = new TokenProfiler();
  });

  // ============================================================
  // profile() 五组件估算
  // ============================================================

  describe('profile()', () => {
    it('应正确估算五个组件的 token 数', () => {
      const snapshot = profiler.profile({
        systemPrompt: 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: 'Hello world' },
          { role: 'assistant', content: 'Hi there' },
        ],
        tools: [{ name: 'tool1', parameters: {} }],
        userMessage: 'What is 1+1?',
        iterationIndex: 0,
        modelId: 'test-model',
        routeDecision: 'simple',
      });

      expect(snapshot.systemPrompt).toBeGreaterThan(0);
      expect(snapshot.conversationHistory).toBeGreaterThan(0);
      expect(snapshot.toolDefinitions).toBeGreaterThan(0);
      expect(snapshot.userMessage).toBeGreaterThan(0);
      expect(snapshot.toolResults).toBe(0); // 无工具返回
      expect(snapshot.totalEstimated).toBe(
        snapshot.systemPrompt +
        snapshot.conversationHistory +
        snapshot.toolDefinitions +
        snapshot.toolResults +
        snapshot.userMessage,
      );
    });

    it('应正确估算含工具返回的消息', () => {
      const messages: LLMMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: '1', content: 'Tool output result text' },
          ],
        },
      ];
      const snapshot = profiler.profile({
        messages,
        userMessage: 'test',
        iterationIndex: 0,
        modelId: 'm',
        routeDecision: 'simple',
      });
      expect(snapshot.toolResults).toBeGreaterThan(0);
    });

    it('应正确记录元信息', () => {
      const snapshot = profiler.profile({
        systemPrompt: 'test',
        messages: [],
        userMessage: 'hello',
        iterationIndex: 2,
        modelId: 'gpt-4',
        routeDecision: 'complex',
      });
      expect(snapshot.iterationIndex).toBe(2);
      expect(snapshot.modelId).toBe('gpt-4');
      expect(snapshot.routeDecision).toBe('complex');
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });

    it('无 systemPrompt 时该组件为 0', () => {
      const snapshot = profiler.profile({
        messages: [],
        userMessage: 'test',
        iterationIndex: 0,
        modelId: 'm',
        routeDecision: 'simple',
      });
      expect(snapshot.systemPrompt).toBe(0);
    });

    it('无 tools 时该组件为 0', () => {
      const snapshot = profiler.profile({
        messages: [],
        userMessage: 'test',
        iterationIndex: 0,
        modelId: 'm',
        routeDecision: 'simple',
      });
      expect(snapshot.toolDefinitions).toBe(0);
    });

    it('中文内容应被正确估算（CJK 感知）', () => {
      const snapshot = profiler.profile({
        systemPrompt: '你好世界',
        messages: [],
        userMessage: '这是一个测试',
        iterationIndex: 0,
        modelId: 'm',
        routeDecision: 'simple',
      });
      // 4 个中文字符约 6 tokens（1.5/字）
      expect(snapshot.systemPrompt).toBeGreaterThanOrEqual(6);
      // 6 个中文字符约 9 tokens
      expect(snapshot.userMessage).toBeGreaterThanOrEqual(9);
    });
  });

  // ============================================================
  // persistSession()
  // ============================================================

  describe('persistSession()', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-tp-'));
    });

    afterEach(async () => {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    });

    it('应写入 JSONL 文件', async () => {
      profiler.profile({
        systemPrompt: 'test',
        messages: [],
        userMessage: 'hello',
        iterationIndex: 0,
        modelId: 'm',
        routeDecision: 'simple',
      });
      const filePath = await profiler.persistSession(tmpDir, 'test-session');
      expect(filePath).toBeTruthy();
      expect(filePath).toContain('test-session');
      expect(filePath).toContain('.jsonl');

      const content = await fsPromises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.systemPrompt).toBeGreaterThan(0);
    });

    it('空日志应返回空字符串', async () => {
      const filePath = await profiler.persistSession(tmpDir, 'empty');
      expect(filePath).toBe('');
    });

    it('应创建不存在的目录', async () => {
      profiler.profile({
        messages: [], userMessage: 't', iterationIndex: 0, modelId: 'm', routeDecision: 's',
      });
      const nestedDir = path.join(tmpDir, 'nested', 'dir');
      const filePath = await profiler.persistSession(nestedDir, 'test');
      expect(filePath).toBeTruthy();
    });
  });
});
