// tests/harness/turn-snapshot.test.ts
// Phase 97 Part B：TurnSnapshot 联合快照测试
//
// 覆盖验收标准：
//   1. capture 记录文件 hash + content，越界文件不进入快照
//   2. restore 恢复文件内容（hash 校验通过时）
//   3. hash_changed 时跳过（不覆盖用户后续改动）
//   4. out_of_boundary 拒绝恢复
//   5. 持久化后 read/list 可读

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { TurnSnapshotManager, MAX_FILES_PER_TURN } from '../../src/harness/turn-snapshot.js';

describe('turn-snapshot（对话与文件联合快照）', () => {
  let manager: TurnSnapshotManager;
  let storageDir: string;
  let workDir: string;

  beforeEach(async () => {
    storageDir = path.join(os.tmpdir(), `rd-turn-snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    workDir = path.join(storageDir, 'work');
    await fs.mkdir(workDir, { recursive: true });
    manager = new TurnSnapshotManager({ storageDir });
  });

  afterEach(async () => {
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it('capture 记录文件 hash 与内容，越界文件不进入快照', async () => {
    const inFile = path.join(workDir, 'a.ts');
    const outFile = path.join(storageDir, 'secret.txt');
    await fs.writeFile(inFile, 'console.log(1)', 'utf-8');
    await fs.writeFile(outFile, 'top-secret', 'utf-8');

    const snap = await manager.capture({
      turnId: 't1',
      sessionId: 's1',
      userMessage: '改一下',
      agentOutput: '已修改',
      toolCalls: [],
      changedFiles: [inFile, outFile],
      workingDirectory: workDir,
    });
    expect(snap).not.toBeNull();
    expect(snap!.changedFiles).toHaveLength(1);
    expect(snap!.changedFiles[0].path).toBe('a.ts');
    expect(snap!.changedFiles[0].content).toBe('console.log(1)');
    expect(snap!.changedFiles[0].hash).toHaveLength(64);
  });

  it('restore 恢复文件内容', async () => {
    const inFile = path.join(workDir, 'a.ts');
    await fs.writeFile(inFile, 'v1', 'utf-8');
    await manager.capture({
      turnId: 't2', sessionId: 's1', userMessage: 'm', agentOutput: 'o',
      toolCalls: [], changedFiles: [inFile], workingDirectory: workDir,
    });
    // 模拟后续改动
    await fs.writeFile(inFile, 'v2', 'utf-8');

    const result = await manager.restore('t2', 's1');
    expect(result?.restored).toEqual(['a.ts']);
    expect(await fs.readFile(inFile, 'utf-8')).toBe('v1');
  });

  it('显式回滚覆盖后续改动（Agent 或用户后续写的内容被恢复为快照状态）', async () => {
    const inFile = path.join(workDir, 'a.ts');
    await fs.writeFile(inFile, 'v1', 'utf-8');
    await manager.capture({
      turnId: 't3', sessionId: 's1', userMessage: 'm', agentOutput: 'o',
      toolCalls: [], changedFiles: [inFile], workingDirectory: workDir,
    });
    // 后续（用户或 Agent）改成了 v1-user
    await fs.writeFile(inFile, 'v1-user', 'utf-8');
    // 用户显式回滚 → 以快照为准，写回 v1
    const result = await manager.restore('t3', 's1');
    expect(result?.restored).toEqual(['a.ts']);
    expect(await fs.readFile(inFile, 'utf-8')).toBe('v1');
  });

  it('out_of_boundary 拒绝恢复', async () => {
    const outFile = path.join(storageDir, 'secret.txt');
    await fs.writeFile(outFile, 'top-secret', 'utf-8');
    // 手工构造越界快照（绕过 capture 的边界过滤，直接写文件）
    const outside = path.join(storageDir, 's1');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(
      path.join(outside, 't4.json'),
      JSON.stringify({
        turnId: 't4', sessionId: 's1', userMessage: 'm', agentOutput: 'o',
        toolCalls: [],
        changedFiles: [{ path: 'secret.txt', absPath: outFile, size: 9, hash: 'x', content: 'hacked' }],
        workingDirectory: workDir,
        attachmentBoundary: [],
        createdAt: Date.now(),
      }),
      'utf-8',
    );
    const result = await manager.restore('t4', 's1');
    expect(result?.restored).toEqual([]);
    expect(result?.skipped.some(s => s.reason === 'out_of_boundary')).toBe(true);
    expect(await fs.readFile(outFile, 'utf-8')).toBe('top-secret');
  });

  it('read 与 list 可读回快照', async () => {
    const inFile = path.join(workDir, 'a.ts');
    await fs.writeFile(inFile, 'v1', 'utf-8');
    await manager.capture({
      turnId: 't5', sessionId: 's1', userMessage: 'm', agentOutput: 'o',
      toolCalls: [], changedFiles: [inFile], workingDirectory: workDir,
    });
    const read = await manager.read('t5', 's1');
    expect(read?.userMessage).toBe('m');
    const list = await manager.list('s1');
    expect(list.some(s => s.turnId === 't5')).toBe(true);
  });

  it('超过 MAX_FILES_PER_TURN 只快照前 N 个', async () => {
    const files: string[] = [];
    for (let i = 0; i < MAX_FILES_PER_TURN + 5; i++) {
      const f = path.join(workDir, `f${i}.txt`);
      await fs.writeFile(f, `c${i}`, 'utf-8');
      files.push(f);
    }
    const snap = await manager.capture({
      turnId: 't6', sessionId: 's1', userMessage: 'm', agentOutput: 'o',
      toolCalls: [], changedFiles: files, workingDirectory: workDir,
    });
    expect(snap!.changedFiles.length).toBe(MAX_FILES_PER_TURN);
  });
});
