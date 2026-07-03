import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodebaseMemory } from '../../src/memory/codebase-memory.js';

/** 创建临时目录用于测试 */
function makeTmpDir(prefix = 'routedev-cb-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('CodebaseMemory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  describe('scan', () => {
    it('扫描空目录返回空数组', async () => {
      const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
      const entries = await memory.scan();
      expect(entries).toEqual([]);
    });

    it('扫描源码文件并建立索引', async () => {
      // 准备测试文件
      writeFileSync(
        join(tmpDir, 'auth.ts'),
        '// 用户认证模块\nexport class AuthService {\n  login(user: string): boolean { return true; }\n}\n',
        'utf-8',
      );
      writeFileSync(
        join(tmpDir, 'utils.js'),
        '// 工具函数\nexport function formatDate(d: Date): string { return d.toISOString(); }\n',
        'utf-8',
      );

      const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
      const entries = await memory.scan();

      expect(entries.length).toBe(2);
      const paths = entries.map((e) => e.filePath).sort();
      expect(paths).toEqual(['auth.ts', 'utils.js']);
    });

    it('跳过 ignorePatterns 中的目录', async () => {
      mkdirSync(join(tmpDir, 'node_modules'), { recursive: true });
      writeFileSync(join(tmpDir, 'node_modules', 'lib.js'), 'export const x = 1;', 'utf-8');
      mkdirSync(join(tmpDir, '.git'), { recursive: true });
      writeFileSync(join(tmpDir, '.git', 'config'), 'content', 'utf-8');
      writeFileSync(join(tmpDir, 'main.ts'), '// main\nexport const main = 1;', 'utf-8');

      const memory = new CodebaseMemory(tmpDir, {
        persistPath: join(tmpDir, 'index.json'),
      });
      const entries = await memory.scan();

      const paths = entries.map((e) => e.filePath);
      expect(paths).toContain('main.ts');
      expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
      expect(paths.some((p) => p.includes('.git'))).toBe(false);
    });

    it('支持自定义 ignorePatterns', async () => {
      mkdirSync(join(tmpDir, 'vendor'), { recursive: true });
      writeFileSync(join(tmpDir, 'vendor', 'lib.ts'), 'export const v = 1;', 'utf-8');
      writeFileSync(join(tmpDir, 'app.ts'), 'export const app = 1;', 'utf-8');

      const memory = new CodebaseMemory(tmpDir, {
        ignorePatterns: ['vendor', 'node_modules', '.git', 'dist', 'build', '.routedev'],
        persistPath: join(tmpDir, 'index.json'),
      });
      const entries = await memory.scan();

      const paths = entries.map((e) => e.filePath);
      expect(paths).toContain('app.ts');
      expect(paths.some((p) => p.includes('vendor'))).toBe(false);
    });

    it('遵守 maxFiles 上限', async () => {
      // 创建 5 个文件
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(tmpDir, `file${i}.ts`), `export const f${i} = ${i};`, 'utf-8');
      }

      const memory = new CodebaseMemory(tmpDir, {
        maxFiles: 3,
        persistPath: join(tmpDir, 'index.json'),
      });
      const entries = await memory.scan();

      expect(entries.length).toBe(3);
    });

    it('递归扫描子目录', async () => {
      mkdirSync(join(tmpDir, 'src', 'modules'), { recursive: true });
      writeFileSync(join(tmpDir, 'src', 'index.ts'), 'export const idx = 1;', 'utf-8');
      writeFileSync(join(tmpDir, 'src', 'modules', 'auth.ts'), '// auth module\nexport class Auth {}', 'utf-8');

      const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
      const entries = await memory.scan();

      const paths = entries.map((e) => e.filePath);
      expect(paths).toContain('src/index.ts');
      expect(paths).toContain('src/modules/auth.ts');
    });

    it('摘要提取首行注释和 export 关键字', async () => {
      writeFileSync(
        join(tmpDir, 'feature.ts'),
        '// 用户登录功能\nexport class LoginService {\n  authenticate() {}\n}\nexport function logout() {}\n',
        'utf-8',
      );

      const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
      const entries = await memory.scan();
      const entry = entries.find((e) => e.filePath === 'feature.ts');
      expect(entry).toBeDefined();
      expect(entry!.summary).toContain('用户登录功能');
      expect(entry!.summary).toContain('LoginService');
      expect(entry!.summary).toContain('logout');
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      writeFileSync(join(tmpDir, 'auth.ts'), '// auth module\nexport class AuthService {}', 'utf-8');
      writeFileSync(join(tmpDir, 'cache.ts'), '// cache layer\nexport class CacheService {}', 'utf-8');
      writeFileSync(join(tmpDir, 'router.ts'), '// request router\nexport function route() {}', 'utf-8');
    });

    it('按文件路径关键词查询', async () => {
      const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
      await memory.scan();

      const results = await memory.query('auth');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].filePath).toBe('auth.ts');
    });

    it('按摘要关键词查询', async () => {
      const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
      await memory.scan();

      const results = await memory.query('cache');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].filePath).toBe('cache.ts');
    });

    it('无匹配时返回空数组', async () => {
      const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
      await memory.scan();

      const results = await memory.query('nonexistent');
      expect(results).toEqual([]);
    });

    it('遵守 limit 参数', async () => {
      // 多个文件都包含 module 关键词
      writeFileSync(join(tmpDir, 'a.ts'), '// module a\nexport const a = 1;', 'utf-8');
      writeFileSync(join(tmpDir, 'b.ts'), '// module b\nexport const b = 1;', 'utf-8');
      writeFileSync(join(tmpDir, 'c.ts'), '// module c\nexport const c = 1;', 'utf-8');

      const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
      await memory.scan();

      const results = await memory.query('module', 2);
      expect(results.length).toBe(2);
    });
  });

  describe('get', () => {
    it('按文件路径精确获取条目', async () => {
      writeFileSync(join(tmpDir, 'target.ts'), '// target file\nexport const x = 1;', 'utf-8');

      const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
      await memory.scan();

      const entry = memory.get('target.ts');
      expect(entry).toBeDefined();
      expect(entry!.filePath).toBe('target.ts');
    });

    it('未命中时返回 undefined', async () => {
      const memory = new CodebaseMemory(tmpDir, { persistPath: join(tmpDir, 'index.json') });
      await memory.scan();
      expect(memory.get('nonexistent.ts')).toBeUndefined();
    });
  });

  describe('reload', () => {
    it('reload 重新扫描并更新索引', async () => {
      // 使用 .routedev 子目录作为持久化路径，避免 persist 文件本身被扫描到
      const persistPath = join(tmpDir, '.routedev', 'index.json');
      const memory = new CodebaseMemory(tmpDir, { persistPath });
      await memory.scan();
      expect(memory.size()).toBe(0);

      // 新增文件
      writeFileSync(join(tmpDir, 'new.ts'), 'export const n = 1;', 'utf-8');
      await memory.reload();
      expect(memory.size()).toBe(1);
      expect(memory.get('new.ts')).toBeDefined();
    });
  });

  describe('persistence', () => {
    it('scan 后持久化到 JSON 文件', async () => {
      writeFileSync(join(tmpDir, 'persist.ts'), '// persist test\nexport const p = 1;', 'utf-8');
      const persistPath = join(tmpDir, 'index.json');

      const memory = new CodebaseMemory(tmpDir, { persistPath });
      await memory.scan();

      expect(existsSync(persistPath)).toBe(true);
      const data = JSON.parse(readFileSync(persistPath, 'utf-8'));
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(1);
      expect(data[0].filePath).toBe('persist.ts');
    });

    it('构造时自动加载已持久化的索引', async () => {
      const persistPath = join(tmpDir, 'index.json');
      // 预写索引文件
      const preExisting = [
        {
          filePath: 'cached.ts',
          summary: 'cached entry from previous session',
          lastScanned: 1000,
        },
      ];
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(persistPath, JSON.stringify(preExisting, null, 2), 'utf-8');

      const memory = new CodebaseMemory(tmpDir, { persistPath });
      // 等待构造时的异步 loadFromFile 完成
      await new Promise((r) => setTimeout(r, 50));

      const entry = memory.get('cached.ts');
      expect(entry).toBeDefined();
      expect(entry!.summary).toBe('cached entry from previous session');
    });

    it('跨会话恢复：scan → 重新构造 → 索引仍在', async () => {
      const persistPath = join(tmpDir, 'index.json');
      writeFileSync(join(tmpDir, 'cross.ts'), '// cross session\nexport const c = 1;', 'utf-8');

      // 会话 1：扫描并持久化
      const mem1 = new CodebaseMemory(tmpDir, { persistPath });
      await mem1.scan();
      expect(mem1.size()).toBe(1);

      // 会话 2：重新构造，应自动加载
      const mem2 = new CodebaseMemory(tmpDir, { persistPath });
      await new Promise((r) => setTimeout(r, 50));
      expect(mem2.size()).toBe(1);
      expect(mem2.get('cross.ts')).toBeDefined();
    });

    it('文件不存在时构造不抛错（fail-open）', async () => {
      const persistPath = join(tmpDir, 'nonexistent', 'index.json');
      const memory = new CodebaseMemory(tmpDir, { persistPath });
      await new Promise((r) => setTimeout(r, 50));
      expect(memory.size()).toBe(0);
    });
  });

  describe('默认持久化路径', () => {
    it('未传 persistPath 时默认使用 .routedev/codebase-memory.json', async () => {
      // 创建 .routedev 目录并写入一个文件
      writeFileSync(join(tmpDir, 'test.ts'), 'export const t = 1;', 'utf-8');

      const memory = new CodebaseMemory(tmpDir);
      await memory.scan();

      const defaultPath = join(tmpDir, '.routedev', 'codebase-memory.json');
      expect(existsSync(defaultPath)).toBe(true);
    });
  });
});
