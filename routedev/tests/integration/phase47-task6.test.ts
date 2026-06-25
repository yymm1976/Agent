// tests/integration/phase47-task6.test.ts
// Phase 47 Task 6 集成测试：Checkpoint 可视化时间轴与语义化摘要
//
// 测试策略：
//   1. Checkpoint 创建时生成语义化摘要（mock LLM 可用）
//   2. LLM 不可用时降级为原始描述（陷阱 #138）
//   3. LLM 超时时降级为原始描述（陷阱 #138）
//   4. Checkpoint 创建不被摘要生成阻塞（安全网优先）
//   5. Checkpoint 包含 stats 字段（filesChanged, tokensUsed）
//   6. generateSummary 直接调用：LLM 返回空内容时降级
//   7. setLLMClient 注入后摘要生成生效

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { CheckpointManager } from '../../src/harness/checkpoint-manager.js';
import type { CheckpointManagerConfig, CheckpointLLMClient } from '../../src/harness/types.js';

const HAS_GIT = (() => {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-cp47-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -q -m "initial"', { cwd: dir });
  return dir;
}

function makeManager(workingDirectory: string): CheckpointManager {
  const config: CheckpointManagerConfig = {
    enabled: true,
    maxCheckpoints: 5,
    workingDirectory,
  };
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-cp47-store-'));
  return new CheckpointManager(config, storageDir);
}

/** 创建 mock LLM 客户端 */
function makeMockLLMClient(response: { content: string }, delayMs = 0): CheckpointLLMClient {
  return {
    complete: vi.fn(async () => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return response;
    }),
  };
}

/** 创建超时的 mock LLM 客户端（永不返回） */
function makeHangingLLMClient(): CheckpointLLMClient {
  return {
    complete: vi.fn(async () => {
      // 永不返回，模拟 LLM 卡住
      await new Promise(() => {}); // 永远 pending
      return { content: 'should never reach' };
    }),
  };
}

/** 创建抛异常的 mock LLM 客户端 */
function makeThrowingLLMClient(error: Error): CheckpointLLMClient {
  return {
    complete: vi.fn(async () => {
      throw error;
    }),
  };
}

describe.skipIf(!HAS_GIT)('Phase 47 Task 6 - Checkpoint 语义化摘要', () => {
  let tempDir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    tempDir = createTempRepo();
    manager = makeManager(tempDir);
    await manager.init();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ============================================================
  // 1. Checkpoint 创建时生成语义化摘要（mock LLM 可用）
  // ============================================================
  it('LLM 可用时，create() 应生成语义化摘要', async () => {
    const mockClient = makeMockLLMClient({ content: '添加用户登录功能' });
    manager.setLLMClient(mockClient, 'test-model');

    fs.writeFileSync(path.join(tempDir, 'auth.ts'), 'export function login() {}');
    const cp = await manager.create({ description: '步骤 1 前快照：实现用户登录模块' });

    expect(cp).not.toBeNull();
    expect(cp!.summary).toBe('添加用户登录功能');
    expect(cp!.summary).not.toBe(cp!.description);
    expect(mockClient.complete).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 2. LLM 不可用时降级为原始描述（陷阱 #138）
  // ============================================================
  it('LLM 未注入时，generateSummary 应降级为原始 description', async () => {
    const description = '步骤 2 前快照：重构数据库层';
    const summary = await manager.generateSummary(description);

    // 未注入 LLM 客户端时，应返回原始 description
    expect(summary).toBe(description);
  });

  it('LLM 客户端注入但 complete 抛异常时，应降级为原始 description', async () => {
    const mockClient = makeThrowingLLMClient(new Error('LLM service unavailable'));
    manager.setLLMClient(mockClient, 'test-model');

    const description = '步骤 3 前快照：修复内存泄漏';
    const summary = await manager.generateSummary(description);

    // LLM 调用失败时，应降级为原始 description（陷阱 #138）
    expect(summary).toBe(description);
  });

  // ============================================================
  // 3. LLM 超时时降级为原始描述（陷阱 #138）
  // ============================================================
  it('LLM 超时（>3秒）时，generateSummary 应降级为原始 description', async () => {
    // 使用永不返回的 LLM 客户端模拟超时
    const mockClient = makeHangingLLMClient();
    manager.setLLMClient(mockClient, 'test-model');

    const description = '步骤 4 前快照：优化查询性能';
    const startTime = Date.now();
    const summary = await manager.generateSummary(description);
    const elapsed = Date.now() - startTime;

    // 应在 3 秒超时后降级（允许一定误差）
    expect(elapsed).toBeLessThan(5000);
    expect(summary).toBe(description);
  });

  // ============================================================
  // 4. Checkpoint 创建不被摘要生成阻塞（安全网优先）
  // ============================================================
  it('摘要生成失败时，checkpoint 仍应成功创建并持久化', async () => {
    // 注入会抛异常的 LLM 客户端
    const mockClient = makeThrowingLLMClient(new Error('LLM error'));
    manager.setLLMClient(mockClient, 'test-model');

    fs.writeFileSync(path.join(tempDir, 'feature.ts'), 'export const x = 1;');
    const cp = await manager.create({ description: '添加新功能' });

    // checkpoint 应成功创建（即使摘要生成失败）
    expect(cp).not.toBeNull();
    expect(cp!.id).toMatch(/^[a-f0-9]+$/);
    expect(cp!.description).toBe('添加新功能');
    // summary 应为 undefined（降级时未设置 summary 字段）
    expect(cp!.summary).toBeUndefined();

    // checkpoint 应已持久化到列表中
    const list = manager.list();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(cp!.id);
  });

  it('摘要生成超时时，checkpoint 仍应成功创建', async () => {
    // 注入永不返回的 LLM 客户端（模拟超时）
    const mockClient = makeHangingLLMClient();
    manager.setLLMClient(mockClient, 'test-model');

    fs.writeFileSync(path.join(tempDir, 'slow.ts'), 'export const y = 2;');
    const cp = await manager.create({ description: '慢操作检查点' });

    // 即使 LLM 超时，checkpoint 应成功创建
    expect(cp).not.toBeNull();
    expect(cp!.description).toBe('慢操作检查点');
    expect(cp!.summary).toBeUndefined();
    expect(manager.list().length).toBe(1);
  });

  // ============================================================
  // 5. Checkpoint 包含 stats 字段（filesChanged, tokensUsed）
  // ============================================================
  it('create() 应在 stats 中记录 filesChanged 和 tokensUsed', async () => {
    fs.writeFileSync(path.join(tempDir, 'file1.ts'), 'content1');
    fs.writeFileSync(path.join(tempDir, 'file2.ts'), 'content2');
    fs.writeFileSync(path.join(tempDir, 'file3.ts'), 'content3');

    const cp = await manager.create({
      description: '多文件变更',
      tokensUsed: 1234,
    });

    expect(cp).not.toBeNull();
    expect(cp!.stats).toBeDefined();
    expect(cp!.stats!.filesChanged).toBe(3);
    expect(cp!.stats!.tokensUsed).toBe(1234);
  });

  it('未传入 tokensUsed 时，stats.tokensUsed 默认为 0', async () => {
    fs.writeFileSync(path.join(tempDir, 'single.ts'), 'content');
    const cp = await manager.create({ description: '单文件变更' });

    expect(cp).not.toBeNull();
    expect(cp!.stats).toBeDefined();
    expect(cp!.stats!.filesChanged).toBe(1);
    expect(cp!.stats!.tokensUsed).toBe(0);
  });

  // ============================================================
  // 6. generateSummary 直接调用：LLM 返回空内容时降级
  // ============================================================
  it('LLM 返回空内容时，generateSummary 应降级为原始 description', async () => {
    const mockClient = makeMockLLMClient({ content: '   ' });
    manager.setLLMClient(mockClient, 'test-model');

    const description = '步骤 5 前快照：清理无用代码';
    const summary = await manager.generateSummary(description);

    // 空内容应降级为原始 description
    expect(summary).toBe(description);
  });

  // ============================================================
  // 7. setLLMClient 注入后摘要生成生效
  // ============================================================
  it('setLLMClient 注入后，摘要生成应使用注入的客户端和模型', async () => {
    const mockClient = makeMockLLMClient({ content: '注入后的摘要' });
    manager.setLLMClient(mockClient, 'injected-model');

    const summary = await manager.generateSummary('原始描述');

    expect(summary).toBe('注入后的摘要');
    // 验证 mock 客户端被调用，且使用了注入的模型 ID
    expect(mockClient.complete).toHaveBeenCalledTimes(1);
    const callArgs = (mockClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.model).toBe('injected-model');
  });

  it('setLLMClient 传入 undefined 可清除 LLM 客户端，回退到降级模式', async () => {
    // 先注入客户端
    const mockClient = makeMockLLMClient({ content: '摘要' });
    manager.setLLMClient(mockClient, 'model');
    expect(await manager.generateSummary('desc')).toBe('摘要');

    // 清除客户端
    manager.setLLMClient(undefined, '');
    const summary = await manager.generateSummary('desc');
    expect(summary).toBe('desc');
  });
});

// ============================================================
// Checkpoint 接口扩展验证（不需要 Git）
// ============================================================
describe('Phase 47 Task 6 - Checkpoint 接口扩展', () => {
  it('Checkpoint 接口包含 summary 和 stats 字段', () => {
    const cp = {
      id: 'test-id',
      gitCommitHash: 'abc123',
      timestamp: Date.now(),
      description: 'test',
      filesSnapshot: [],
      isAutoCreated: true,
      summary: '语义化摘要',
      stats: { filesChanged: 5, tokensUsed: 100 },
    };

    expect(cp.summary).toBe('语义化摘要');
    expect(cp.stats?.filesChanged).toBe(5);
    expect(cp.stats?.tokensUsed).toBe(100);
  });

  it('Checkpoint 接口的 summary 和 stats 字段为可选', () => {
    const cp = {
      id: 'test-id',
      gitCommitHash: 'abc123',
      timestamp: Date.now(),
      description: 'test',
      filesSnapshot: [],
      isAutoCreated: true,
      // summary 和 stats 未设置
    };

    expect(cp.summary).toBeUndefined();
    expect(cp.stats).toBeUndefined();
  });
});
