// tests/memory/codebase-memory-semantic.test.ts
// Phase 71 Task D5 测试：CodebaseMemory 语义检索升级
//
// 覆盖点：
//   1. 语义检索正常路径返回结果
//   2. 语义检索失败时降级到关键词检索（fail-open）
//   3. 空查询不报错
//   4. embeddingProvider 配置被正确读取
//   5. 检索结果按相似度排序
//   6. CodebaseMemory 调用方存在（grep 验证写入注释）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodebaseMemory } from '../../src/memory/codebase-memory.js';
import { HashEmbedder, type Embedder } from '../../src/skills/embedder.js';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

/** 创建临时目录用于测试 */
function makeTmpDir(prefix = 'routedev-cb-sem-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 故意抛错的 embedder：用于测试 fail-open 降级路径
 * embed() / embedBatch() 都抛异常，触发 HybridRetriever 向 keyword 降级
 */
class FailingEmbedder implements Embedder {
  async embed(): Promise<number[]> {
    throw new Error('failing embedder: forced error');
  }
  async embedBatch(): Promise<number[][]> {
    throw new Error('failing embedder: forced error');
  }
}

describe('Phase 71 Task D5: CodebaseMemory 语义检索', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  it('1. 语义检索正常路径返回结果', async () => {
    // 准备：一个明显与查询相关的文件 + 一个无关文件
    writeFileSync(
      join(tmpDir, 'auth.ts'),
      '// 用户认证模块\nexport class AuthService { login() {} logout() {} }\n',
      'utf-8',
    );
    writeFileSync(
      join(tmpDir, 'utils.ts'),
      '// 通用工具函数\nexport function formatDate(d: Date) { return d.toISOString(); }\n',
      'utf-8',
    );

    const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
    await memory.scan();

    // 用 HashEmbedder 默认即可（无外部依赖），查询命中 auth.ts
    const results = await memory.query('auth login logout');
    expect(results.length).toBeGreaterThan(0);
    // auth.ts 应排在最前（BM25 + 哈希向量都命中）
    expect(results[0].filePath).toBe('auth.ts');
  });

  it('2. 语义检索失败时降级到关键词检索（fail-open）', async () => {
    // 准备：注入 FailingEmbedder，让 HybridRetriever 的向量计算抛错
    writeFileSync(
      join(tmpDir, 'cache.ts'),
      '// 缓存层\nexport class CacheService { get() {} set() {} }\n',
      'utf-8',
    );

    const memory = new CodebaseMemory(tmpDir, {
      persistPath: join(tmpDir, 'index.json'),
      embedder: new FailingEmbedder(),
    });
    await memory.scan();

    // 即使 embedder 抛错，query 也不应抛异常，应降级到关键词检索
    const results = await memory.query('cache');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filePath).toBe('cache.ts');
  });

  it('3. 空查询不报错', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '// a\nexport const a = 1;', 'utf-8');
    const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
    await memory.scan();

    // 空字符串、纯空白都应返回空数组，不触发检索、不抛异常
    expect(await memory.query('')).toEqual([]);
    expect(await memory.query('   ')).toEqual([]);
    expect(await memory.query('\t\n')).toEqual([]);
  });

  it('4. embeddingProvider 配置被正确读取', async () => {
    // 验证默认配置已从 'hash' 升级为真实语义 provider 'bi-encoder'
    expect(DEFAULT_CONFIG.memorySystem?.store?.embeddingProvider).toBe('bi-encoder');

    // 验证消费链：MemoryStore 构造时读取该字段（非僵尸配置）
    const store = new MemoryStore({
      enabled: true,
      dbPath: ':memory:',
      backend: 'sqlite',
      embeddingProvider: DEFAULT_CONFIG.memorySystem!.store!.embeddingProvider as
        'bi-encoder' | 'hash' | 'none',
    });
    expect(store).toBeDefined();
    // bi-encoder 模式默认 embedder 为 null（需外部 setEmbedder 注入）
    expect(store.getEmbedder()).toBeNull();
    // 但通过 setEmbedder 可注入，证明该配置是真实消费的
    store.setEmbedder(new HashEmbedder());
    expect(store.getEmbedder()).not.toBeNull();
  });

  it('5. 检索结果按相似度排序', async () => {
    // 准备：3 个文件，相关度递减
    // - auth.ts：完整命中 'auth login'
    // - auth-utils.ts：部分命中 'auth'
    // - utils.ts：无关
    writeFileSync(
      join(tmpDir, 'auth.ts'),
      '// auth login module\nexport class AuthService { login() {} }\n',
      'utf-8',
    );
    writeFileSync(
      join(tmpDir, 'auth-utils.ts'),
      '// auth helper\nexport function helper() {}\n',
      'utf-8',
    );
    writeFileSync(
      join(tmpDir, 'utils.ts'),
      '// format utilities\nexport function formatDate() {}\n',
      'utf-8',
    );

    const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
    await memory.scan();

    const results = await memory.query('auth login');
    expect(results.length).toBeGreaterThan(0);
    // 最相关的 auth.ts 必须排在首位
    expect(results[0].filePath).toBe('auth.ts');
    // 如果返回多条，auth-utils.ts（部分命中）应排在 utils.ts（无命中）之前
    if (results.length >= 2) {
      const authUtilsIdx = results.findIndex((r) => r.filePath === 'auth-utils.ts');
      const utilsIdx = results.findIndex((r) => r.filePath === 'utils.ts');
      // utils.ts 不应出现在结果中（无匹配）；若出现，auth-utils.ts 应更靠前
      if (utilsIdx !== -1 && authUtilsIdx !== -1) {
        expect(authUtilsIdx).toBeLessThan(utilsIdx);
      }
    }
  });

  it('6. CodebaseMemory 调用方存在（grep 验证写入注释）', () => {
    // 通过 grep 验证至少一个调用点。本测试用 readFileSync 直接读取源文件断言。
    // 已验证的调用方（grep "new CodebaseMemory" / "CodebaseMemory" 结果）：
    //   - src/cli/app-init.ts:174  import { CodebaseMemory } from '../memory/codebase-memory.js';
    //   - src/cli/app-init.ts:482  const memory = new CodebaseMemory(cwd, { maxFiles });
    //   - src/cli/app-init.ts:346  codebaseMemory?: CodebaseMemory;  (AppDependencies 字段)
    //   - src/cli/service-context.ts:27   import type { CodebaseMemory } ...
    //   - src/cli/service-context.ts:112  codebaseMemory?: CodebaseMemory;  (ServiceContext 字段)
    //   - src/cli/service-context.ts:212  codebaseMemory?: CodebaseMemory;  (ServiceContextDeps 字段)
    // 结论：CodebaseMemory 非孤立模块，被 app-init 装配并暴露到 ServiceContext

    const appInitPath = join(process.cwd(), 'src', 'cli', 'app-init.ts');
    const appInitSrc = readFileSync(appInitPath, 'utf-8');
    // 至少存在一处 new CodebaseMemory( 实例化调用
    expect(appInitSrc).toMatch(/new\s+CodebaseMemory\s*\(/);
    // 至少存在一处 import 引用
    expect(appInitSrc).toMatch(/import\s+\{[^}]*CodebaseMemory[^}]*\}\s+from/);

    const serviceContextPath = join(process.cwd(), 'src', 'cli', 'service-context.ts');
    const serviceContextSrc = readFileSync(serviceContextPath, 'utf-8');
    // ServiceContext 暴露 codebaseMemory 字段，证明有真实消费点
    expect(serviceContextSrc).toMatch(/codebaseMemory\?:\s*CodebaseMemory/);
  });
});
