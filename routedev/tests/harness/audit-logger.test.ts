// tests/harness/audit-logger.test.ts
// AuditLogger 单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AuditLogger } from '../../src/harness/audit-logger.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('AuditLogger', () => {
  describe('log', () => {
    it('should write JSONL record', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.log('file_write', '/tmp/test.ts', { size: 100 });
      await new Promise(r => setTimeout(r, 50));
      const today = new Date().toISOString().slice(0, 10);
      const files = await fs.readdir(path.join(tempDir, today));
      const jsonl = files.find(f => f.endsWith('.audit.jsonl'));
      expect(jsonl).toBeDefined();
      const content = await fs.readFile(path.join(tempDir, today, jsonl!), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      expect(lines.length).toBe(1);
      const record = JSON.parse(lines[0]);
      expect(record.action).toBe('file_write');
      expect(record.target).toBe('/tmp/test.ts');
    });

    it('should default agentId to main', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.log('shell_exec', 'ls -la', {});
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records[0].agentId).toBe('main');
    });
  });

  describe('shortcut methods', () => {
    it('logFileWrite should set action file_write', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.logFileWrite('/tmp/x.ts');
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records[0].action).toBe('file_write');
      expect(records[0].target).toBe('/tmp/x.ts');
    });

    it('logShellExec should set action shell_exec', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.logShellExec('rm -rf /');
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records[0].action).toBe('shell_exec');
      expect(records[0].target).toBe('rm -rf /');
    });

    it('logUserConfirm with approved=true', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.logUserConfirm('shell_exec', true, 'looks good');
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records[0].action).toBe('user_confirm');
      expect(records[0].confirmation?.approved).toBe(true);
      expect(records[0].result).toBe('success');
    });

    it('logUserConfirm with approved=false', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.logUserConfirm('file_delete', false, 'too risky');
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records[0].action).toBe('user_deny');
      expect(records[0].result).toBe('denied');
    });

    it('logRouteDecision', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.logRouteDecision('gpt-4', 'complex', false);
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records[0].action).toBe('route_decision');
      expect(records[0].details.tier).toBe('complex');
    });

    it('logGoalStart / logGoalComplete', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.logGoalStart('plan-1', 'build todo app', 3);
      al.logGoalComplete('plan-1', true);
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      // listToday 按时间倒序，[0] 是最新的 goal_complete
      expect(records[0].action).toBe('goal_complete');
      expect(records[1].action).toBe('goal_start');
    });

    it('logGoalComplete with success=false should use goal_fail', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.logGoalComplete('plan-1', false);
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records[0].action).toBe('goal_fail');
    });

    it('logRollback', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.logRollback('cp-1', 'abc1234');
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records[0].action).toBe('rollback');
      expect(records[0].details.commitHash).toBe('abc1234');
    });

    it('logBlackboardWrite', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.logBlackboardWrite('step-1', 'coder', 1);
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records[0].action).toBe('blackboard_write');
      expect(records[0].details.sourceRole).toBe('coder');
    });

    it('logChannelMessage in/out', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.logChannelMessage('in', 'wechat-work', 'user-1', 42);
      al.logChannelMessage('out', 'wechat-work', 'user-1', 100);
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records[0].action).toBe('channel_message_out');
      expect(records[1].action).toBe('channel_message_in');
    });
  });

  describe('listToday', () => {
    it('should return records sorted by time desc', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.log('file_write', '/a', {});
      await new Promise(r => setTimeout(r, 10));
      al.log('file_write', '/b', {});
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records.length).toBe(2);
      expect(records[0].target).toBe('/b'); // newer first
      expect(records[1].target).toBe('/a');
    });

    it('should return empty when no records', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      const records = await al.listToday();
      expect(records).toEqual([]);
    });

    it('should respect limit', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      for (let i = 0; i < 10; i++) al.log('file_write', `/f${i}`, {});
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday(3);
      expect(records.length).toBe(3);
    });
  });

  describe('listByAction', () => {
    it('should filter by action type', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir });
      al.logFileWrite('/a.ts');
      al.logShellExec('ls');
      al.logFileWrite('/b.ts');
      await new Promise(r => setTimeout(r, 50));
      const fileRecords = await al.listByAction('file_write');
      expect(fileRecords.length).toBe(2);
      expect(fileRecords.every(r => r.action === 'file_write')).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should remove directories older than retentionDays', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir, retentionDays: 30 });
      const oldDate = '2020-01-01';
      const oldDir = path.join(tempDir, oldDate);
      await fs.mkdir(oldDir, { recursive: true });
      await fs.writeFile(path.join(oldDir, 'test.jsonl'), 'data');
      const removed = await al.cleanup();
      expect(removed).toBe(1);
      const exists = await fs.stat(oldDir).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('should not remove recent directories', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir, retentionDays: 30 });
      const today = new Date().toISOString().slice(0, 10);
      const todayDir = path.join(tempDir, today);
      await fs.mkdir(todayDir, { recursive: true });
      const removed = await al.cleanup();
      expect(removed).toBe(0);
      const exists = await fs.stat(todayDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should be safe when storage dir does not exist', async () => {
      const al = new AuditLogger('sess-1', { storageDir: path.join(tempDir, 'nonexistent') });
      const removed = await al.cleanup();
      expect(removed).toBe(0);
    });
  });

  describe('disabled mode', () => {
    it('should not write records when disabled', async () => {
      const al = new AuditLogger('sess-1', { storageDir: tempDir, enabled: false });
      al.logFileWrite('/x');
      await new Promise(r => setTimeout(r, 50));
      const records = await al.listToday();
      expect(records.length).toBe(0);
    });
  });
});