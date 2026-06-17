// tests/memory/project-memory.test.ts
// ProjectMemoryManager 单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectMemoryManager } from '../../src/memory/project-memory.js';

let tempDir: string;
let projectPath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-test-'));
  projectPath = path.join(tempDir, 'myproject');
  await fs.mkdir(projectPath, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const defaultConfig = {
  enabled: true,
  maxMemorySize: 10000,
  maxDecisions: 100,
  autoInject: true,
};

describe('ProjectMemoryManager', () => {
  describe('getStatus', () => {
    it('should report no files when .routedev does not exist', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      const status = await pm.getStatus();
      expect(status.hasRoutedevDir).toBe(false);
      expect(status.files.rules.exists).toBe(false);
    });

    it('should report file existence', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      await pm.writeRules('# Test Rules');
      const status = await pm.getStatus();
      expect(status.files.rules.exists).toBe(true);
      expect(status.files.rules.size).toBeGreaterThan(0);
    });
  });

  describe('rules', () => {
    it('should write and read rules', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      await pm.writeRules('# Project Rules\n\n- Use TypeScript');
      const rules = await pm.readRules();
      expect(rules).toContain('Use TypeScript');
    });

    it('should return null when rules do not exist', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      const rules = await pm.readRules();
      expect(rules).toBeNull();
    });
  });

  describe('MEMORY.md', () => {
    it('should append entries', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      await pm.appendMemory('Entry 1');
      await pm.appendMemory('Entry 2');
      const memory = await pm.readMemory();
      expect(memory).toContain('Entry 1');
      expect(memory).toContain('Entry 2');
    });

    it('should clear memory', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      await pm.appendMemory('Test');
      await pm.clearMemory();
      const memory = await pm.readMemory();
      expect(memory).toBeNull();
    });

    it('should truncate when exceeding max size', async () => {
      const pm = new ProjectMemoryManager(projectPath, { ...defaultConfig, maxMemorySize: 100 });
      await pm.appendMemory('x'.repeat(60));
      await pm.appendMemory('y'.repeat(60));
      const memory = await pm.readMemory();
      // 第二次 append 时已超 max，触发了截断
      expect(memory).not.toBeNull();
      expect(memory!.length).toBeLessThan(200);
    });

    it('should not write when disabled', async () => {
      const pm = new ProjectMemoryManager(projectPath, { ...defaultConfig, enabled: false });
      await pm.appendMemory('Test');
      const memory = await pm.readMemory();
      expect(memory).toBeNull();
    });
  });

  describe('decisions', () => {
    it('should append and read decisions', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      await pm.appendDecision('s1', 'architecture', 'Use React', 'Type-safe');
      await pm.appendDecision('s1', 'convention', 'Use 2-space indent', 'Matches existing code');
      const decisions = await pm.readDecisions();
      expect(decisions.length).toBe(2);
      expect(decisions[0].type).toBe('architecture');
    });

    it('should respect limit parameter', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      for (let i = 0; i < 10; i++) {
        await pm.appendDecision('s1', 'other', `Decision ${i}`, 'reason');
      }
      const last3 = await pm.readDecisions(3);
      expect(last3.length).toBe(3);
      expect(last3[2].decision).toBe('Decision 9');
    });

    it('should return empty array when no decisions', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      const decisions = await pm.readDecisions();
      expect(decisions).toEqual([]);
    });
  });

  describe('context', () => {
    it('should write and read context', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      await pm.writeContext('# Project Context\n\nImportant info');
      const ctx = await pm.readContext();
      expect(ctx).toContain('Important info');
    });

    it('should return null when context does not exist', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      expect(await pm.readContext()).toBeNull();
    });
  });

  describe('getSummary', () => {
    it('should return placeholder when empty', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      const summary = await pm.getSummary();
      expect(summary).toContain('暂无');
    });

    it('should include rules section', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      await pm.writeRules('# Rules\n- Use TypeScript');
      const summary = await pm.getSummary();
      expect(summary).toContain('项目规则');
      expect(summary).toContain('Use TypeScript');
    });

    it('should include decisions section', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      await pm.appendDecision('s1', 'architecture', 'Use React', 'Better DX');
      const summary = await pm.getSummary();
      expect(summary).toContain('最近决策');
      expect(summary).toContain('Use React');
    });
  });

  describe('resetAll', () => {
    it('should remove .routedev directory', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      await pm.writeRules('# Test');
      await pm.appendMemory('Test');
      await pm.resetAll();
      const status = await pm.getStatus();
      expect(status.hasRoutedevDir).toBe(false);
    });
  });

  describe('generateSessionId', () => {
    it('should return 8-character ID', () => {
      const id = ProjectMemoryManager.generateSessionId();
      expect(id.length).toBe(8);
    });
  });

  describe('decision record', () => {
    it('should include related files', async () => {
      const pm = new ProjectMemoryManager(projectPath, defaultConfig);
      await pm.appendDecision('s1', 'bug_fix', 'Fixed null check', 'Found in PR review', ['src/foo.ts']);
      const decisions = await pm.readDecisions();
      expect(decisions[0].relatedFiles).toEqual(['src/foo.ts']);
    });
  });
});