// tests/agent/loop-memory.test.ts
// Phase 49 Task 2.6：LoopMemory 记忆模块测试
//
// 覆盖：
//   - recordFailure / buildPrompt / buildResuggestion 基本功能
//   - 持久化到 .routedev/loop-memory/<goal-id>.md
//   - load 重新加载已持久化的失败记录
//   - archive 归档到 archived/ 目录
//   - 陷阱 #147：超过 MAX_KEPT_FAILURES 时截断
//   - 多种字段组合（missingItems / gateFailures / reviewIssues）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LoopMemory,
  LOOP_MEMORY_DIR,
  LOOP_MEMORY_ARCHIVE_DIR,
  MAX_KEPT_FAILURES,
} from '../../src/agent/loop-memory.js';
import type { LoopFailure } from '../../src/agent/dual-loop-types.js';

function makeFailure(overrides: Partial<LoopFailure> = {}): LoopFailure {
  return {
    iteration: 1,
    reason: '测试失败原因',
    missingItems: [],
    gateFailures: [],
    reviewIssues: [],
    ...overrides,
  };
}

describe('LoopMemory (Phase 49 Task 2.4)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rd-loop-memory-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('常量', () => {
    it('LOOP_MEMORY_DIR 为 .routedev/loop-memory', () => {
      expect(LOOP_MEMORY_DIR).toBe('.routedev/loop-memory');
    });

    it('LOOP_MEMORY_ARCHIVE_DIR 为 archived 子目录', () => {
      expect(LOOP_MEMORY_ARCHIVE_DIR).toBe(`${LOOP_MEMORY_DIR}/archived`);
    });

    it('MAX_KEPT_FAILURES 为 5（陷阱 #147）', () => {
      expect(MAX_KEPT_FAILURES).toBe(5);
    });
  });

  describe('recordFailure / getHistory', () => {
    it('记录失败后可通过 getHistory 获取', () => {
      const mem = new LoopMemory(tempDir);
      const failure = makeFailure({ iteration: 1, reason: '失败 A' });
      mem.recordFailure(failure);
      const history = mem.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].reason).toBe('失败 A');
    });

    it('getHistory 返回副本，外部修改不影响内部状态', () => {
      const mem = new LoopMemory(tempDir);
      mem.recordFailure(makeFailure({ iteration: 1, reason: '失败 A' }));
      const history = mem.getHistory();
      history.push(makeFailure({ iteration: 99, reason: 'fake' }));
      expect(mem.size).toBe(1);
    });

    it('size 属性反映当前记录数', () => {
      const mem = new LoopMemory(tempDir);
      expect(mem.size).toBe(0);
      mem.recordFailure(makeFailure({ iteration: 1 }));
      expect(mem.size).toBe(1);
      mem.recordFailure(makeFailure({ iteration: 2 }));
      expect(mem.size).toBe(2);
    });
  });

  describe('buildPrompt', () => {
    it('无失败记录时返回空字符串', () => {
      const mem = new LoopMemory(tempDir);
      expect(mem.buildPrompt()).toBe('');
    });

    it('包含"=== 历史失败记录（请避免重复犯错）==="标识', () => {
      const mem = new LoopMemory(tempDir);
      mem.recordFailure(makeFailure({ iteration: 1, reason: '失败 A' }));
      const prompt = mem.buildPrompt();
      expect(prompt).toContain('=== 历史失败记录');
      expect(prompt).toContain('请避免重复犯错');
      expect(prompt).toContain('=== 失败记录结束 ===');
    });

    it('包含迭代序号和失败原因', () => {
      const mem = new LoopMemory(tempDir);
      mem.recordFailure(makeFailure({ iteration: 3, reason: '测试原因 XYZ' }));
      const prompt = mem.buildPrompt();
      expect(prompt).toContain('第 3 次尝试失败');
      expect(prompt).toContain('测试原因 XYZ');
    });

    it('包含缺失项（missingItems）', () => {
      const mem = new LoopMemory(tempDir);
      mem.recordFailure(makeFailure({
        iteration: 1,
        missingItems: ['功能 A', '功能 B'],
      }));
      const prompt = mem.buildPrompt();
      expect(prompt).toContain('功能 A');
      expect(prompt).toContain('功能 B');
    });

    it('包含工程验证失败项（gateFailures）', () => {
      const mem = new LoopMemory(tempDir);
      mem.recordFailure(makeFailure({
        iteration: 1,
        gateFailures: [
          { name: 'typecheck', ok: false, output: '类型错误', duration: 100 },
          { name: 'tests', ok: false, output: '测试失败', duration: 200 },
        ],
      }));
      const prompt = mem.buildPrompt();
      expect(prompt).toContain('typecheck');
      expect(prompt).toContain('tests');
    });

    it('包含审查问题（reviewIssues），带 severity/file/description', () => {
      const mem = new LoopMemory(tempDir);
      mem.recordFailure(makeFailure({
        iteration: 1,
        reviewIssues: [
          { severity: 'critical', file: 'src/a.ts', line: 42, description: 'SQL 注入' },
          { severity: 'warning', file: 'src/b.ts', description: '空值未处理' },
        ],
      }));
      const prompt = mem.buildPrompt();
      expect(prompt).toContain('critical');
      expect(prompt).toContain('src/a.ts:42');
      expect(prompt).toContain('SQL 注入');
      expect(prompt).toContain('warning');
      expect(prompt).toContain('src/b.ts');
    });

    it('多条失败记录按顺序列出', () => {
      const mem = new LoopMemory(tempDir);
      mem.recordFailure(makeFailure({ iteration: 1, reason: '第一次失败' }));
      mem.recordFailure(makeFailure({ iteration: 2, reason: '第二次失败' }));
      const prompt = mem.buildPrompt();
      expect(prompt).toContain('第 1 次尝试失败');
      expect(prompt).toContain('第 2 次尝试失败');
      expect(prompt).toContain('第一次失败');
      expect(prompt).toContain('第二次失败');
    });
  });

  describe('buildResuggestion', () => {
    it('无失败记录时返回空字符串', () => {
      const mem = new LoopMemory(tempDir);
      expect(mem.buildResuggestion()).toBe('');
    });

    it('基于最近一次失败返回建议', () => {
      const mem = new LoopMemory(tempDir);
      mem.recordFailure(makeFailure({
        iteration: 1,
        reason: '工程验证失败',
        missingItems: ['功能 X'],
      }));
      mem.recordFailure(makeFailure({
        iteration: 2,
        reason: '目标未完成',
        missingItems: ['功能 Y', '功能 Z'],
      }));
      const suggestion = mem.buildResuggestion();
      // 应该基于最近一次失败（iteration 2）
      expect(suggestion).toContain('目标未完成');
      expect(suggestion).toContain('功能 Y');
      expect(suggestion).toContain('功能 Z');
    });

    it('无 missingItems 时回退到 gateFailures', () => {
      const mem = new LoopMemory(tempDir);
      mem.recordFailure(makeFailure({
        iteration: 1,
        reason: '工程验证失败',
        missingItems: [],
        gateFailures: [
          { name: 'typecheck', ok: false, output: '错误', duration: 1 },
        ],
      }));
      const suggestion = mem.buildResuggestion();
      expect(suggestion).toContain('typecheck');
    });
  });

  describe('持久化与加载', () => {
    it('recordFailure 后写入 .routedev/loop-memory/<goal-id>.md', async () => {
      const mem = new LoopMemory(tempDir);
      await mem.load('goal-1');
      mem.recordFailure(makeFailure({ iteration: 1, reason: '失败 A' }));

      // 等待异步写入完成
      await new Promise(r => setTimeout(r, 100));

      const filePath = join(tempDir, LOOP_MEMORY_DIR, 'goal-1.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('Loop Memory');
      expect(content).toContain('失败 A');
    });

    it('load 重新加载已持久化的失败记录', async () => {
      // 先写入
      const mem1 = new LoopMemory(tempDir);
      await mem1.load('goal-2');
      mem1.recordFailure(makeFailure({
        iteration: 1,
        reason: '测试失败原因 ABC',
        missingItems: ['功能 M'],
      }));
      await new Promise(r => setTimeout(r, 100));

      // 重新加载
      const mem2 = new LoopMemory(tempDir);
      await mem2.load('goal-2');
      expect(mem2.size).toBe(1);
      const history = mem2.getHistory();
      expect(history[0].reason).toBe('测试失败原因 ABC');
      expect(history[0].missingItems).toContain('功能 M');
    });

    it('load 不存在的文件时静默返回（首次运行）', async () => {
      const mem = new LoopMemory(tempDir);
      await mem.load('non-existent-goal');
      expect(mem.size).toBe(0);
      expect(mem.getHistory()).toEqual([]);
    });

    it('未设置 goalId 时不持久化', () => {
      const mem = new LoopMemory(tempDir);
      // 不调用 load()，goalId 为 null
      mem.recordFailure(makeFailure({ iteration: 1, reason: '失败 A' }));
      // 不应抛错（已在 recordFailure 内部静默处理）
      expect(mem.size).toBe(1);
    });

    it('加载后 buildPrompt 包含历史失败记录', async () => {
      const mem1 = new LoopMemory(tempDir);
      await mem1.load('goal-3');
      mem1.recordFailure(makeFailure({
        iteration: 1,
        reason: '持久化失败原因',
        missingItems: ['功能 P'],
      }));
      await new Promise(r => setTimeout(r, 100));

      const mem2 = new LoopMemory(tempDir);
      await mem2.load('goal-3');
      const prompt = mem2.buildPrompt();
      expect(prompt).toContain('持久化失败原因');
      expect(prompt).toContain('功能 P');
    });
  });

  describe('归档', () => {
    it('archive 把记忆文件移到 archived/ 目录', async () => {
      const mem = new LoopMemory(tempDir);
      await mem.load('goal-archive-1');
      mem.recordFailure(makeFailure({ iteration: 1, reason: '失败 A' }));
      await new Promise(r => setTimeout(r, 100));

      const srcPath = join(tempDir, LOOP_MEMORY_DIR, 'goal-archive-1.md');
      expect(existsSync(srcPath)).toBe(true);

      await mem.archive('goal-archive-1');

      const archivePath = join(tempDir, LOOP_MEMORY_ARCHIVE_DIR, 'goal-archive-1.md');
      expect(existsSync(archivePath)).toBe(true);
      expect(existsSync(srcPath)).toBe(false);

      // archive 后内存清空
      expect(mem.size).toBe(0);
    });

    it('archive 不存在的文件时静默处理', async () => {
      const mem = new LoopMemory(tempDir);
      // 不应抛错
      await mem.archive('non-existent-goal');
    });
  });

  describe('陷阱 #147：保留最近 5 次失败记录', () => {
    it('超过 MAX_KEPT_FAILURES 时只保留最近 5 条', async () => {
      const mem = new LoopMemory(tempDir);
      await mem.load('goal-trim-test');

      // 记录 8 次失败
      for (let i = 1; i <= 8; i++) {
        mem.recordFailure(makeFailure({ iteration: i, reason: `失败 ${i}` }));
      }

      // 应该只保留最近 5 条
      expect(mem.size).toBe(MAX_KEPT_FAILURES);
      const history = mem.getHistory();
      expect(history[0].iteration).toBe(4); // 1-3 被丢弃
      expect(history[history.length - 1].iteration).toBe(8);
    });
  });

  describe('setGoalId', () => {
    it('设置 goalId 后 recordFailure 会持久化', async () => {
      const mem = new LoopMemory(tempDir);
      mem.setGoalId('goal-set-id');
      mem.recordFailure(makeFailure({ iteration: 1, reason: '失败 A' }));
      await new Promise(r => setTimeout(r, 100));

      const filePath = join(tempDir, LOOP_MEMORY_DIR, 'goal-set-id.md');
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe('序列化与反序列化往返', () => {
    it('复杂失败记录往返保持字段完整', async () => {
      const original: LoopFailure = {
        iteration: 5,
        reason: '复杂失败：多个原因',
        missingItems: ['功能 A', '功能 B', '功能 C'],
        gateFailures: [
          { name: 'typecheck', ok: false, output: 'TS2307', duration: 150 },
          { name: 'tests', ok: false, output: '2 failed', duration: 300 },
        ],
        reviewIssues: [
          { severity: 'critical', file: 'src/x.ts', line: 100, description: '严重问题' },
          { severity: 'warning', file: 'src/y.ts', description: '警告' },
          { severity: 'info', file: 'src/z.ts', description: '建议' },
        ],
      };

      const mem1 = new LoopMemory(tempDir);
      await mem1.load('goal-roundtrip');
      mem1.recordFailure(original);
      await new Promise(r => setTimeout(r, 100));

      const mem2 = new LoopMemory(tempDir);
      await mem2.load('goal-roundtrip');
      const history = mem2.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].iteration).toBe(5);
      expect(history[0].reason).toBe('复杂失败：多个原因');
      expect(history[0].missingItems).toEqual(['功能 A', '功能 B', '功能 C']);
      // gateFailures 应该至少有 2 项，且 name 字段完整
      expect(history[0].gateFailures.length).toBeGreaterThanOrEqual(2);
      expect(history[0].gateFailures.map(g => g.name)).toEqual(
        expect.arrayContaining(['typecheck', 'tests']),
      );
      // reviewIssues 应该至少有 3 项
      expect(history[0].reviewIssues.length).toBeGreaterThanOrEqual(3);
      const criticalIssue = history[0].reviewIssues.find(i => i.severity === 'critical');
      expect(criticalIssue).toBeDefined();
      expect(criticalIssue!.file).toBe('src/x.ts');
      expect(criticalIssue!.description).toBe('严重问题');
    });
  });
});
