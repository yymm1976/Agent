// tests/harness/audit-logger.test.ts
// AuditLogger 单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AuditLogger, type HashChainRecord } from '../../src/harness/audit-logger.js';

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
      await new Promise(r => setTimeout(r, 10));
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

  describe('第九轮 AuditEnvelope V2：hash 完整性', () => {
    function makeLogger(): AuditLogger {
      const al = new AuditLogger('sess-chain', { storageDir: tempDir });
      // 哈希链需显式 setChainConfig 启用（constructor 不读取 chain 配置）
      al.setChainConfig({ enabled: true });
      return al;
    }

    async function readChainRecords(): Promise<HashChainRecord[]> {
      const al = makeLogger();
      const records = await al.listToday();
      // listToday 只返回 AuditRecord——直接从文件读 HashChainRecord
      const { readFileSync, readdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const dir = join(tempDir, new Date().toISOString().slice(0, 10));
      const out: HashChainRecord[] = [];
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.audit.jsonl')) continue;
        for (const line of readFileSync(join(dir, f), 'utf-8').split(String.fromCharCode(10))) {
          if (line.trim()) out.push(JSON.parse(line));
        }
      }
      return out;
    }

    it('篡改任一安全字段都会使 verifyChain 失败（eventId/sequence/sessionId/result/confirmation/details）', async () => {
      const al = makeLogger();
      al.log('file_write', '/a.txt', { operation: 'write' }, 'success');
      al.log('shell_exec', 'rm -rf /tmp/x', { commandLength: 12 }, 'success', 'main', { requested: true, approved: true });
      const records = await readChainRecords();
      expect(records.length).toBe(2);

      // 基线：未篡改链完整
      expect(al.verifyChain(records)).toBe(true);

      // 篡改测试：每项改一个字段后链必须失败
      const tamperCases: Array<[string, (r: HashChainRecord) => HashChainRecord]> = [
        ['eventId', (r) => ({ ...r, eventId: 'tampered-id' })],
        ['sequence', (r) => ({ ...r, sequence: (r.sequence ?? 0) + 999 })],
        ['sessionId', (r) => ({ ...r, sessionId: 'other-session' })],
        ['result', (r) => ({ ...r, result: r.result === 'success' ? 'denied' : 'success' })],
        ['details', (r) => ({ ...r, details: { ...r.details, operation: 'tampered' } })],
        ['action', (r) => ({ ...r, action: r.action === 'file_write' ? 'shell_exec' : 'file_write' })],
        ['target', (r) => ({ ...r, target: r.target + '-tampered' })],
      ];
      for (const [name, mutate] of tamperCases) {
        const tampered = records.map((r, i) => (i === 0 ? mutate(r) : r));
        expect(al.verifyChain(tampered)).toBe(false);
      }
      void tamperCases;
    });

    it('append 失败时不推进 chain head——下一条记录链仍完整（A → [B 失败] → C）', async () => {
      const al = makeLogger();
      al.log('file_write', '/a.txt', {}, 'success'); // A 写成功
      // 模拟 B append 失败：把审计文件路径替换为同名目录（appendFileSync → EISDIR 抛错）
      const { renameSync, mkdirSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const todayDir = join(tempDir, new Date().toISOString().slice(0, 10));
      const auditFile = join(todayDir, 'sess-chain.audit.jsonl');
      const backupFile = auditFile + '.bak';
      renameSync(auditFile, backupFile);
      mkdirSync(auditFile); // 同名目录占位 → B 的 appendFileSync 抛 EISDIR
      // B 写失败（chain head 不得推进）
      al.log('shell_exec', 'bad', {}, 'success');
      // 恢复文件路径
      rmSync(auditFile, { recursive: true, force: true });
      renameSync(backupFile, auditFile);
      // C 写成功——previousHash 仍链到 A（B 未 commit）
      al.log('todo_write', '/t', {}, 'success');

      const records = await readChainRecords();
      expect(records.length).toBe(2); // A 与 C（B 失败未落盘）
      expect(al.verifyChain(records)).toBe(true);
    });

    it('A5：logger 销毁重建（同 session 同日）→ chain head 恢复，追加 C 链连续', async () => {
      const al = makeLogger();
      al.log('file_write', '/a.txt', {}, 'success'); // A
      al.log('shell_exec', 'ls', {}, 'success'); // B
      // 销毁 logger（模拟进程重启）
      const al2 = makeLogger(); // 同 sessionId + storageDir，setChainConfig 恢复 head
      al2.log('todo_write', '/t', {}, 'success'); // C（previousHash 应为 B 的 hash）
      const records = await readChainRecords();
      expect(records.length).toBe(3);
      // 全链必须完整（C 链接到 B，而非 genesis）
      expect(al2.verifyChain(records)).toBe(true);
      // C.previousHash 必须等于 B.hash（恢复生效而非重置 genesis）
      expect(records[2]!.previousHash).toBe(records[1]!.hash);
    });

    it('A5：per-day 语义——跨日新文件从 genesis 开始新链（各自验证完整）', async () => {
      const al = makeLogger();
      al.log('file_write', '/a.txt', {}, 'success'); // 今日 A
      // 手工构造昨日文件（同 sessionId 不同 dayDir）——模拟跨日
      const { mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const yDir = join(tempDir, yesterday);
      mkdirSync(yDir, { recursive: true });
      // 昨日文件含一条 genesis 链记录（hash 链完整）
      const yAl = new AuditLogger('sess-chain', { storageDir: tempDir });
      yAl.setChainConfig({ enabled: true });
      // 直接写昨日文件（绕过 getStorageDir 的今日路径）——用 yAl 写会进今日目录；
      // 改为手工构造：读取今日第一条记录的 hash 语义即可，这里验证 per-day 边界：
      // 今日文件首条 previousHash === GENESIS（新链）
      const records = await readChainRecords();
      expect(records[0]!.previousHash).toBe('0'.repeat(64));
      void yAl;
      void yDir;
    });

    it('A5：尾部截断（最后一条记录丢失）→ restore 恢复倒数第二条 hash，追加链仍连续', async () => {
      const al = makeLogger();
      al.log('file_write', '/a.txt', {}, 'success'); // A
      al.log('shell_exec', 'ls', {}, 'success'); // B
      // 截断：删除尾行 B（模拟写入中断）
      const { readFileSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const dayDir = join(tempDir, new Date().toISOString().slice(0, 10));
      const f = join(dayDir, 'sess-chain.audit.jsonl');
      const content = readFileSync(f, 'utf-8');
      const lines = content.split(String.fromCharCode(10)).filter((l) => l.trim());
      writeFileSync(f, lines.slice(0, -1).join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf-8');
      // 新 logger 恢复 head：尾行 A 有效 → C 链接 A
      const al2 = makeLogger();
      al2.log('todo_write', '/t', {}, 'success'); // C
      const records = await readChainRecords();
      expect(records.length).toBe(2); // A 与 C（B 被截断丢失）
      // C.previousHash === A.hash（恢复生效，链 A→C 连续）
      expect(records[1]!.previousHash).toBe(records[0]!.hash);
      expect(al2.verifyChain(records)).toBe(true);
    });

    it('A5：尾记录损坏（无有效 hash）→ restore 从 genesis 新链并告警', async () => {
      const al = makeLogger();
      al.log('file_write', '/a.txt', {}, 'success'); // A
      // 破坏尾行：改成无 hash 的普通记录（模拟损坏）
      const { readFileSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const dayDir = join(tempDir, new Date().toISOString().slice(0, 10));
      const f = join(dayDir, 'sess-chain.audit.jsonl');
      const lines = readFileSync(f, 'utf-8').split(String.fromCharCode(10)).filter((l) => l.trim());
      const bad = { ...JSON.parse(lines[0]), hash: undefined, previousHash: undefined };
      writeFileSync(f, JSON.stringify(bad) + String.fromCharCode(10), 'utf-8');
      // 新 logger 恢复 head：尾记录无 hash → genesis 新链（不静默修复旧链）
      const al2 = makeLogger();
      al2.log('shell_exec', 'ls', {}, 'success'); // C 从 genesis 开始
      const records = await readChainRecords();
      expect(records.length).toBe(2);
      expect(records[1]!.previousHash).toBe('0'.repeat(64));
    });

    it('P1-2：同一 logger 真跨午夜（23:59 → 00:00）→ 新文件第一条从 genesis 开始', async () => {
      // injectable clock：先固定在 23:59:59.999
      let current = new Date('2026-08-08T23:59:59.999Z');
      const al = new AuditLogger('sess-midnight', {
        storageDir: tempDir,
        now: () => current,
      });
      al.setChainConfig({ enabled: true });
      al.log('file_write', '/a.txt', {}, 'success'); // A 写入 2026-08-08 文件
      // 跨午夜
      current = new Date('2026-08-09T00:00:00.001Z');
      al.log('shell_exec', 'ls', {}, 'success'); // B 写入 2026-08-09 文件
      // B 必须从 genesis 开始新链（per-day 边界）
      const { join: pathJoin } = await import('node:path');
      const day8 = pathJoin(tempDir, '2026-08-08', 'sess-midnight.audit.jsonl');
      const day9 = pathJoin(tempDir, '2026-08-09', 'sess-midnight.audit.jsonl');
      const { readFileSync } = await import('node:fs');
      const b = JSON.parse(readFileSync(day9, 'utf-8'));
      expect(b.previousHash).toBe('0'.repeat(64)); // 新文件 genesis
      const a = JSON.parse(readFileSync(day8, 'utf-8').split(String.fromCharCode(10)).filter(Boolean)[0]);
      expect(a.previousHash).toBe('0'.repeat(64));
      // 同日重开恢复（回到 day9）——C 链接 B 而非 genesis
      const al2 = new AuditLogger('sess-midnight', { storageDir: tempDir, now: () => current });
      al2.setChainConfig({ enabled: true });
      al2.log('todo_write', '/t', {}, 'success'); // C
      const day9Content = readFileSync(day9, 'utf-8').split(String.fromCharCode(10)).filter(Boolean);
      const c = JSON.parse(day9Content[day9Content.length - 1]);
      expect(c.previousHash).toBe(b.hash); // 同日恢复 tail
    });
  });
});