// src/cite/structured-injector.ts
// 文件引用结构化注入器（Phase 49 Task 4.3）
//
// 设计目标（蓝图 4.3）：
//   知识库原文："大海捞针问题：达到阈值后效果下降 →
//               解法：结构化文件解析（先脚本解析，不全量读取）。"
//
//   1. 不全量读取文件内容到上下文
//   2. 通过 codeMap 提取文件结构概览（符号列表）
//   3. 根据对话上下文查询相关符号
//   4. 只注入相关符号的代码块 + 文件结构概览
//
// 与 Phase 48 CiteResolver 的关系：
//   - CiteResolver 生成 preflight 的 read_file 调用（全文读取）
//   - StructuredInjector 在 read_file 返回后做结构化裁剪
//   - 只注入与当前对话相关的符号块，而非全文
//
// 陷阱 #145：结构化注入可能遗漏关键代码
//   - codeMap 的符号查询可能不完整（全局函数、闭包内变量）
//   - 截断时必须显示"已注入 N/M 个符号块"，让用户知道有内容被省略
//
// 依赖注入：不直接依赖 code-map 模块，通过 CodeMapQueryInterface 注入
//   - 便于测试 mock
//   - 避免循环依赖

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 文件结构概览（符号列表的精简表示） */
export interface FileStructure {
  /** 文件路径 */
  filePath: string;
  /** 文件语言 */
  language?: string;
  /** 符号列表（按出现顺序） */
  symbols: SymbolSummary[];
  /** 结构概要文本（用于注入到上下文） */
  summary: string;
}

/** 符号概要（精简版，只保留注入所需字段） */
export interface SymbolSummary {
  /** 符号名称 */
  name: string;
  /** 符号类型 */
  kind: string;
  /** 起始行（0-based） */
  startLine: number;
  /** 结束行（0-based） */
  endLine: number;
  /** 签名（函数/方法的签名） */
  signature?: string;
}

/** 符号块（含源代码） */
export interface SymbolBlock {
  /** 符号名称 */
  name: string;
  /** 符号类型 */
  kind: string;
  /** 起始行（0-based） */
  startLine: number;
  /** 结束行（0-based） */
  endLine: number;
  /** 源代码内容 */
  content: string;
}

/** 注入结果 */
export interface InjectedFileContent {
  /** 文件路径 */
  filePath: string;
  /** 文件结构概览（符号列表） */
  structureOverview: FileStructure;
  /** 注入的符号块 */
  injectedBlocks: SymbolBlock[];
  /** 总 token 数（估算） */
  totalTokens: number;
  /** 是否被截断（injectedBlocks.length < 相关符号总数） */
  truncated: boolean;
  /** 相关符号总数（截断前的数量，用于显示 N/M） */
  totalRelevantSymbols: number;
  /** 组装好的注入文本（结构概览 + 代码块） */
  injectedText: string;
}

// ============================================================
// 依赖注入接口
// ============================================================

/**
 * CodeMap 查询接口（依赖注入）
 *
 * 不直接 import code-map 模块，通过此接口注入
 * 便于测试 mock，也避免循环依赖
 */
export interface CodeMapQueryInterface {
  /** 获取文件结构概览（符号列表） */
  getFileStructure(filePath: string): Promise<FileStructure>;
  /** 根据对话上下文查询相关符号块 */
  queryRelevantSymbols(filePath: string, conversationContext: string): Promise<SymbolBlock[]>;
}

// ============================================================
// StructuredInjector
// ============================================================

/**
 * 文件引用结构化注入器
 *
 * 使用方式：
 *   const injector = new StructuredInjector({ codeMap });
 *   const result = await injector.injectFileReference('src/foo.ts', '用户在问 bar 函数', 2000);
 */
export class StructuredInjector {
  private readonly codeMap: CodeMapQueryInterface;

  constructor(options: {
    codeMap: CodeMapQueryInterface;
  }) {
    this.codeMap = options.codeMap;
  }

  /**
   * 结构化注入文件内容
   *
   * 流程（蓝图 4.3）：
   *   1. 获取文件结构概览（符号列表）
   *   2. 根据对话上下文查询相关符号
   *   3. 只读取相关符号的代码块
   *   4. 组装注入内容：结构概览 + 相关代码块
   *   5. 超过 maxTokens 时截断，显示"已注入 N/M 个符号块"
   *
   * @param filePath 文件路径
   * @param conversationContext 当前对话上下文（用于查询相关符号）
   * @param maxTokens 注入内容的 token 上限
   * @returns InjectedFileContent
   */
  async injectFileReference(
    filePath: string,
    conversationContext: string,
    maxTokens: number,
  ): Promise<InjectedFileContent> {
    // 1. 获取文件结构概览
    const structure = await this.codeMap.getFileStructure(filePath);

    // 2. 根据对话上下文查询相关符号
    const relevantSymbols = await this.codeMap.queryRelevantSymbols(
      filePath,
      conversationContext,
    );

    // 3. 按 maxTokens 截断符号块（陷阱 #145）
    const { injectedBlocks, truncated } = this.truncateBlocks(
      relevantSymbols,
      maxTokens,
      structure,
    );

    // 4. 组装注入文本
    const injectedText = this.formatInjection(structure, injectedBlocks, {
      totalRelevant: relevantSymbols.length,
      truncated,
    });

    const totalTokens = this.estimateTokens(injectedText);

    logger.debug('StructuredInjector: injected', {
      filePath,
      relevant: relevantSymbols.length,
      injected: injectedBlocks.length,
      truncated,
      totalTokens,
    });

    return {
      filePath,
      structureOverview: structure,
      injectedBlocks,
      totalTokens,
      truncated,
      totalRelevantSymbols: relevantSymbols.length,
      injectedText,
    };
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 按 maxTokens 截断符号块（陷阱 #145）
   *
   * 策略：
   *   - 先计算结构概览的 token 占用（保留预算）
   *   - 逐个累加符号块，超过剩余预算时停止
   *   - 至少注入 1 个符号块（保证不为空）
   */
  private truncateBlocks(
    blocks: SymbolBlock[],
    maxTokens: number,
    structure: FileStructure,
  ): { injectedBlocks: SymbolBlock[]; truncated: boolean } {
    if (blocks.length === 0) {
      return { injectedBlocks: [], truncated: false };
    }

    // 预留结构概览 + 标注文本的 token
    const reservedTokens = this.estimateTokens(this.formatStructureOverview(structure)) + 100;
    const remainingBudget = Math.max(0, maxTokens - reservedTokens);

    const injectedBlocks: SymbolBlock[] = [];
    let usedTokens = 0;

    for (const block of blocks) {
      const blockTokens = this.estimateTokens(this.formatBlock(block));
      // 至少注入 1 个（即使超出预算也保留第一个）
      if (injectedBlocks.length > 0 && usedTokens + blockTokens > remainingBudget) {
        break;
      }
      injectedBlocks.push(block);
      usedTokens += blockTokens;
    }

    return {
      injectedBlocks,
      truncated: injectedBlocks.length < blocks.length,
    };
  }

  /** 组装注入文本 */
  private formatInjection(
    structure: FileStructure,
    blocks: SymbolBlock[],
    meta: { totalRelevant: number; truncated: boolean },
  ): string {
    const parts: string[] = [];

    // 结构概览
    parts.push(this.formatStructureOverview(structure));

    // 符号块
    if (blocks.length > 0) {
      parts.push('--- 相关代码块 ---');
      for (const block of blocks) {
        parts.push(this.formatBlock(block));
      }
    }

    // 陷阱 #145：截断标注"已注入 N/M 个符号块"
    if (meta.truncated) {
      parts.push(
        `[已注入 ${blocks.length}/${meta.totalRelevant} 个符号块，达到 token 上限，部分内容已省略]`,
      );
    }

    return parts.join('\n');
  }

  /** 格式化结构概览 */
  private formatStructureOverview(structure: FileStructure): string {
    const lines: string[] = [
      `文件：${structure.filePath}`,
      `结构概览：`,
    ];
    if (structure.symbols.length === 0) {
      lines.push('  （未识别到符号）');
    } else {
      for (const sym of structure.symbols) {
        const sig = sym.signature ? ` ${sym.signature}` : '';
        lines.push(`  - [${sym.kind}] ${sym.name}${sig} (L${sym.startLine + 1}-${sym.endLine + 1})`);
      }
    }
    return lines.join('\n');
  }

  /** 格式化单个符号块为文本 */
  private formatBlock(block: SymbolBlock): string {
    return [
      `### [${block.kind}] ${block.name} (L${block.startLine + 1}-${block.endLine + 1})`,
      '```',
      block.content,
      '```',
    ].join('\n');
  }

  /** 估算 token 数（简单启发式：英文 4 字符/token，中文 2 字符/token） */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars / 2 + otherChars / 4);
  }
}
