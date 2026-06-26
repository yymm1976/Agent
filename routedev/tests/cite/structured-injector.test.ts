// tests/cite/structured-injector.test.ts
// 文件引用结构化注入器单元测试（Phase 49 Task 4.3）
//
// 覆盖（蓝图 4.6）：
//   1. 只返回相关符号块（不全量注入）
//   2. 超过 maxTokens 时截断
//   3. 截断时显示"已注入 N/M 个符号块"（陷阱 #145）
//   4. 结构概览正确包含符号列表
//   5. 无相关符号时返回空 injectedBlocks
//   6. injectedText 包含结构概览 + 代码块

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StructuredInjector,
  type CodeMapQueryInterface,
  type FileStructure,
  type SymbolBlock,
} from '../../src/cite/structured-injector.js';

// ============================================================
// 工具函数
// ============================================================

/** 构造文件结构概览 */
function makeFileStructure(filePath: string, symbols: Array<{ name: string; kind: string; startLine: number; endLine: number; signature?: string }> = []): FileStructure {
  return {
    filePath,
    language: 'typescript',
    symbols: symbols.map((s) => ({ ...s })),
    summary: symbols.map((s) => `${s.name}(${s.kind})`).join(', '),
  };
}

/** 构造符号块 */
function makeBlock(name: string, content: string, kind = 'function'): SymbolBlock {
  return {
    name,
    kind,
    startLine: 0,
    endLine: content.split('\n').length - 1,
    content,
  };
}

/** 构造 mock codeMap */
function makeCodeMap(options: {
  structure?: FileStructure;
  symbols?: SymbolBlock[];
}): CodeMapQueryInterface & { calls: { getFileStructure: string[]; queryRelevantSymbols: Array<{ filePath: string; context: string }> } } {
  const calls = {
    getFileStructure: [] as string[],
    queryRelevantSymbols: [] as Array<{ filePath: string; context: string }>,
  };
  return {
    calls,
    getFileStructure: vi.fn(async (filePath: string) => {
      calls.getFileStructure.push(filePath);
      return options.structure ?? makeFileStructure(filePath);
    }),
    queryRelevantSymbols: vi.fn(async (filePath: string, conversationContext: string) => {
      calls.queryRelevantSymbols.push({ filePath, context: conversationContext });
      return options.symbols ?? [];
    }),
  };
}

// ============================================================
// 测试
// ============================================================

describe('StructuredInjector（Phase 49 Task 4.3）', () => {
  let codeMap: ReturnType<typeof makeCodeMap>;
  let injector: StructuredInjector;

  beforeEach(() => {
    codeMap = makeCodeMap({
      structure: makeFileStructure('src/foo.ts', [
        { name: 'foo', kind: 'function', startLine: 0, endLine: 5, signature: '(): void' },
        { name: 'bar', kind: 'function', startLine: 6, endLine: 11, signature: '(): number' },
        { name: 'Baz', kind: 'class', startLine: 12, endLine: 30 },
      ]),
      symbols: [
        makeBlock('foo', 'function foo() { return 1; }'),
        makeBlock('bar', 'function bar() { return 2; }'),
      ],
    });
    injector = new StructuredInjector({ codeMap });
  });

  // ------------------------------------------------------------
  // 1. 只返回相关符号块
  // ------------------------------------------------------------

  describe('相关符号块注入', () => {
    it('调用 codeMap.getFileStructure 获取结构概览', async () => {
      await injector.injectFileReference('src/foo.ts', '用户在问 foo', 10000);
      expect(codeMap.calls.getFileStructure).toContain('src/foo.ts');
    });

    it('调用 codeMap.queryRelevantSymbols 查询相关符号', async () => {
      await injector.injectFileReference('src/foo.ts', '用户在问 foo', 10000);
      expect(codeMap.calls.queryRelevantSymbols).toHaveLength(1);
      expect(codeMap.calls.queryRelevantSymbols[0]).toEqual({
        filePath: 'src/foo.ts',
        context: '用户在问 foo',
      });
    });

    it('只返回相关符号块（不全量注入）', async () => {
      const result = await injector.injectFileReference('src/foo.ts', '用户在问 foo', 10000);
      // 应该只包含 foo 和 bar 两个块（mock 返回的）
      expect(result.injectedBlocks).toHaveLength(2);
      expect(result.injectedBlocks[0].name).toBe('foo');
      expect(result.injectedBlocks[1].name).toBe('bar');
      // truncated 为 false（未超出 token 上限）
      expect(result.truncated).toBe(false);
    });
  });

  // ------------------------------------------------------------
  // 2. 超过 maxTokens 时截断
  // ------------------------------------------------------------

  describe('token 截断', () => {
    it('超过 maxTokens 时截断符号块', async () => {
      // 构造多个大符号块
      const bigBlocks: SymbolBlock[] = [];
      for (let i = 0; i < 10; i++) {
        bigBlocks.push(makeBlock(`func${i}`, `function func${i}() { return '${'x'.repeat(200)}'; }`));
      }
      const bigCodeMap = makeCodeMap({
        structure: makeFileStructure('src/big.ts'),
        symbols: bigBlocks,
      });
      const bigInjector = new StructuredInjector({ codeMap: bigCodeMap });

      // maxTokens 设得很小，强制截断
      const result = await bigInjector.injectFileReference('src/big.ts', 'context', 500);

      expect(result.truncated).toBe(true);
      expect(result.injectedBlocks.length).toBeLessThan(bigBlocks.length);
      // 至少注入 1 个
      expect(result.injectedBlocks.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ------------------------------------------------------------
  // 3. 截断时显示"已注入 N/M 个符号块"（陷阱 #145）
  // ------------------------------------------------------------

  describe('截断标注（陷阱 #145）', () => {
    it('截断时 injectedText 包含"已注入 N/M 个符号块"', async () => {
      const bigBlocks: SymbolBlock[] = [];
      for (let i = 0; i < 5; i++) {
        bigBlocks.push(makeBlock(`func${i}`, `function func${i}() { return '${'x'.repeat(200)}'; }`));
      }
      const bigCodeMap = makeCodeMap({
        structure: makeFileStructure('src/big.ts'),
        symbols: bigBlocks,
      });
      const bigInjector = new StructuredInjector({ codeMap: bigCodeMap });

      const result = await bigInjector.injectFileReference('src/big.ts', 'context', 300);

      expect(result.truncated).toBe(true);
      // N = injectedBlocks.length, M = totalRelevantSymbols
      const expectedN = result.injectedBlocks.length;
      const expectedM = result.totalRelevantSymbols;
      expect(result.injectedText).toContain(`已注入 ${expectedN}/${expectedM} 个符号块`);
    });

    it('未截断时 injectedText 不包含"已注入"标注', async () => {
      const result = await injector.injectFileReference('src/foo.ts', 'context', 10000);
      expect(result.truncated).toBe(false);
      expect(result.injectedText).not.toContain('已注入');
    });

    it('totalRelevantSymbols 等于 codeMap 返回的符号块总数', async () => {
      const result = await injector.injectFileReference('src/foo.ts', 'context', 10000);
      expect(result.totalRelevantSymbols).toBe(2);
    });
  });

  // ------------------------------------------------------------
  // 4. 结构概览正确包含符号列表
  // ------------------------------------------------------------

  describe('结构概览', () => {
    it('injectedText 包含文件路径', async () => {
      const result = await injector.injectFileReference('src/foo.ts', 'context', 10000);
      expect(result.injectedText).toContain('src/foo.ts');
    });

    it('injectedText 包含结构概览的符号列表', async () => {
      const result = await injector.injectFileReference('src/foo.ts', 'context', 10000);
      expect(result.injectedText).toContain('foo');
      expect(result.injectedText).toContain('bar');
      expect(result.injectedText).toContain('Baz');
      // 应包含 kind 标注
      expect(result.injectedText).toContain('[function]');
      expect(result.injectedText).toContain('[class]');
    });
  });

  // ------------------------------------------------------------
  // 5. 无相关符号时返回空 injectedBlocks
  // ------------------------------------------------------------

  describe('无相关符号', () => {
    it('codeMap 返回空数组时 injectedBlocks 为空，truncated 为 false', async () => {
      const emptyCodeMap = makeCodeMap({
        structure: makeFileStructure('src/empty.ts'),
        symbols: [],
      });
      const emptyInjector = new StructuredInjector({ codeMap: emptyCodeMap });

      const result = await emptyInjector.injectFileReference('src/empty.ts', 'context', 10000);

      expect(result.injectedBlocks).toHaveLength(0);
      expect(result.truncated).toBe(false);
      expect(result.totalRelevantSymbols).toBe(0);
    });
  });

  // ------------------------------------------------------------
  // 6. injectedText 包含结构概览 + 代码块
  // ------------------------------------------------------------

  describe('injectedText 组装', () => {
    it('injectedText 包含"相关代码块"分隔符和代码内容', async () => {
      const result = await injector.injectFileReference('src/foo.ts', 'context', 10000);
      expect(result.injectedText).toContain('--- 相关代码块 ---');
      expect(result.injectedText).toContain('function foo() { return 1; }');
      expect(result.injectedText).toContain('function bar() { return 2; }');
    });

    it('totalTokens 大于 0（有内容注入时）', async () => {
      const result = await injector.injectFileReference('src/foo.ts', 'context', 10000);
      expect(result.totalTokens).toBeGreaterThan(0);
    });
  });
});
