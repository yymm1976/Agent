// tests/cite/style-sample-injector.test.ts
// 打样注入器单元测试（Phase 49 Task 4.5）
//
// 覆盖（蓝图 4.6）：
//   1. 把样板代码标注为"风格样本"注入上下文（陷阱 #153）
//   2. 超过 maxTokens 时截断并标注 truncated
//   3. 自动识别项目入口文件作为打样候选（陷阱 #153）
//   4. 默认 maxTokens=1500
//   5. codeMap 提取结构概览
//   6. 未配置 listFiles 时 autoDetectSamples 返回空数组

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StyleSampleInjector,
  type ReadFileFn,
  type ListFilesFn,
  type StyleCodeMapInterface,
} from '../../src/cite/style-sample-injector.js';
import type { FileStructure } from '../../src/cite/structured-injector.js';

// ============================================================
// 工具函数
// ============================================================

/** 构造 mock readFile */
function makeReadFile(map: Record<string, string>): ReadFileFn & {
  calls: string[];
} {
  const calls: string[] = [];
  const fn = vi.fn(async (filePath: string) => {
    calls.push(filePath);
    return map[filePath] ?? '';
  }) as ReadFileFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** 构造 mock listFiles */
function makeListFiles(files: string[]): ListFilesFn & {
  calls: string[];
} {
  const calls: string[] = [];
  const fn = vi.fn(async (dirPath: string) => {
    calls.push(dirPath);
    return files;
  }) as ListFilesFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** 构造 mock codeMap */
function makeCodeMap(structure: FileStructure): StyleCodeMapInterface & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    getFileStructure: vi.fn(async (filePath: string) => {
      calls.push(filePath);
      return structure;
    }),
  } as StyleCodeMapInterface & { calls: string[] };
}

/** 构造 FileStructure */
function makeFileStructure(filePath: string, symbols: Array<{ name: string; kind: string }> = []): FileStructure {
  return {
    filePath,
    language: 'typescript',
    symbols: symbols.map((s, i) => ({
      name: s.name,
      kind: s.kind,
      startLine: i * 10,
      endLine: i * 10 + 9,
    })),
    summary: symbols.map((s) => `${s.name}(${s.kind})`).join(', '),
  };
}

// ============================================================
// 测试
// ============================================================

describe('StyleSampleInjector（Phase 49 Task 4.5）', () => {
  let readFile: ReturnType<typeof makeReadFile>;
  let injector: StyleSampleInjector;

  beforeEach(() => {
    readFile = makeReadFile({
      'src/index.ts': [
        'export function main() {',
        '  console.log("hello");',
        '}',
      ].join('\n'),
    });
    injector = new StyleSampleInjector({ readFile });
  });

  // ------------------------------------------------------------
  // 1. 标注"风格样本"（陷阱 #153）
  // ------------------------------------------------------------

  describe('风格样本标注（陷阱 #153）', () => {
    it('注入文本包含"风格样本"标注', async () => {
      const result = await injector.injectStyleSample('src/index.ts');
      expect(result.injected).toContain('风格样本');
    });

    it('注入文本包含"勿照抄业务逻辑"提示', async () => {
      const result = await injector.injectStyleSample('src/index.ts');
      expect(result.injected).toContain('勿照抄业务逻辑');
    });

    it('注入文本包含文件路径', async () => {
      const result = await injector.injectStyleSample('src/index.ts');
      expect(result.injected).toContain('src/index.ts');
    });

    it('注入文本包含代码块（``` 包裹）', async () => {
      const result = await injector.injectStyleSample('src/index.ts');
      expect(result.injected).toContain('```');
      expect(result.injected).toContain('console.log');
    });
  });

  // ------------------------------------------------------------
  // 2. 超过 maxTokens 时截断（陷阱 #153）
  // ------------------------------------------------------------

  describe('token 截断', () => {
    it('内容超过 maxTokens 时 truncated = true', async () => {
      // 构造大文件
      const bigContent = 'x'.repeat(10000);
      const bigReadFile = makeReadFile({ 'src/big.ts': bigContent });
      const bigInjector = new StyleSampleInjector({ readFile: bigReadFile });

      const result = await bigInjector.injectStyleSample('src/big.ts', 500);

      expect(result.truncated).toBe(true);
    });

    it('截断时注入文本包含截断标注', async () => {
      const bigContent = 'x'.repeat(10000);
      const bigReadFile = makeReadFile({ 'src/big.ts': bigContent });
      const bigInjector = new StyleSampleInjector({ readFile: bigReadFile });

      const result = await bigInjector.injectStyleSample('src/big.ts', 500);

      expect(result.injected).toContain('截断');
    });

    it('内容未超过 maxTokens 时 truncated = false', async () => {
      const result = await injector.injectStyleSample('src/index.ts', 5000);
      expect(result.truncated).toBe(false);
    });

    it('未提供 maxTokens 时使用默认值 1500', async () => {
      // 默认 1500 tokens，约 4500 字符
      // 构造 5000 字符的内容，应该被截断
      const bigContent = 'y'.repeat(5000);
      const bigReadFile = makeReadFile({ 'src/default.ts': bigContent });
      const bigInjector = new StyleSampleInjector({ readFile: bigReadFile });

      const result = await bigInjector.injectStyleSample('src/default.ts');

      // 5000 字符 > 1500 tokens * 3 chars/token = 4500 字符，应截断
      expect(result.truncated).toBe(true);
    });
  });

  // ------------------------------------------------------------
  // 3. 自动识别项目入口文件（陷阱 #153）
  // ------------------------------------------------------------

  describe('autoDetectSamples 自动识别（陷阱 #153）', () => {
    it('识别入口文件（index.ts）', async () => {
      const listFiles = makeListFiles([
        'src/index.ts',
        'src/utils/helper.ts',
        'src/components/Button.tsx',
      ]);
      const inj = new StyleSampleInjector({ readFile, listFiles });

      const samples = await inj.autoDetectSamples('src/');

      expect(samples).toContain('src/index.ts');
    });

    it('识别接口文件（types.ts）', async () => {
      const listFiles = makeListFiles([
        'src/types.ts',
        'src/utils/helper.ts',
      ]);
      const inj = new StyleSampleInjector({ readFile, listFiles });

      const samples = await inj.autoDetectSamples('src/');

      expect(samples).toContain('src/types.ts');
    });

    it('识别配置文件（config.ts）', async () => {
      const listFiles = makeListFiles([
        'src/config.ts',
        'src/utils/helper.ts',
      ]);
      const inj = new StyleSampleInjector({ readFile, listFiles });

      const samples = await inj.autoDetectSamples('src/');

      expect(samples).toContain('src/config.ts');
    });

    it('按优先级排序：入口 > 接口 > 配置', async () => {
      const listFiles = makeListFiles([
        'src/config.ts',
        'src/types.ts',
        'src/index.ts',
      ]);
      const inj = new StyleSampleInjector({ readFile, listFiles });

      const samples = await inj.autoDetectSamples('src/');

      // index.ts 应排在最前
      expect(samples[0]).toBe('src/index.ts');
      // types.ts 其次
      expect(samples[1]).toBe('src/types.ts');
      // config.ts 最后
      expect(samples[2]).toBe('src/config.ts');
    });

    it('返回最多 5 个文件', async () => {
      const listFiles = makeListFiles([
        'src/index.ts',
        'src/main.ts',
        'src/app.ts',
        'src/types.ts',
        'src/interfaces.ts',
        'src/config.ts',
        'src/settings.ts',
      ]);
      const inj = new StyleSampleInjector({ readFile, listFiles });

      const samples = await inj.autoDetectSamples('src/');

      expect(samples.length).toBeLessThanOrEqual(5);
    });

    it('未配置 listFiles 时返回空数组', async () => {
      const inj = new StyleSampleInjector({ readFile });

      const samples = await inj.autoDetectSamples('src/');

      expect(samples).toEqual([]);
    });
  });

  // ------------------------------------------------------------
  // 4. codeMap 提取结构概览
  // ------------------------------------------------------------

  describe('codeMap 结构概览', () => {
    it('配置 codeMap 时注入文本包含结构概览', async () => {
      const codeMap = makeCodeMap(
        makeFileStructure('src/index.ts', [
          { name: 'main', kind: 'function' },
          { name: 'App', kind: 'class' },
        ]),
      );
      const inj = new StyleSampleInjector({ readFile, codeMap });

      const result = await inj.injectStyleSample('src/index.ts');

      expect(result.injected).toContain('结构概览');
      expect(result.injected).toContain('main');
      expect(result.injected).toContain('App');
    });

    it('codeMap 抛异常时降级为无结构概览', async () => {
      const codeMap: StyleCodeMapInterface = {
        getFileStructure: vi.fn(async () => {
          throw new Error('codeMap unavailable');
        }),
      };
      const inj = new StyleSampleInjector({ readFile, codeMap });

      const result = await inj.injectStyleSample('src/index.ts');

      // 不应抛异常，正常注入（无结构概览）
      expect(result.injected).toContain('风格样本');
      expect(result.tokens).toBeGreaterThan(0);
    });

    it('未配置 codeMap 时跳过结构概览', async () => {
      const result = await injector.injectStyleSample('src/index.ts');
      // 仍能正常注入，只是没有结构概览
      expect(result.injected).toContain('风格样本');
      expect(result.injected).not.toContain('结构概览');
    });
  });

  // ------------------------------------------------------------
  // 5. tokens 估算
  // ------------------------------------------------------------

  describe('tokens 估算', () => {
    it('返回的 tokens 大于 0', async () => {
      const result = await injector.injectStyleSample('src/index.ts');
      expect(result.tokens).toBeGreaterThan(0);
    });
  });
});
