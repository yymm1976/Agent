// src/cite/style-sample-injector.ts
// 打样注入器（Phase 49 Task 4.5）
//
// 设计目标（蓝图 4.5）：
//   知识库原文（主题-AI项目长期迭代——团队级 Harness 工程）：
//     "打样工程：定义代码框架和规范，AI 参照打样写出风格一致的代码，
//      产出比程序员手写更整洁。"
//
//   打样工程是吸因子（Task 1.7）在上下文层面的具体落地——
//   不是告诉 AI"不要写错"，而是给 AI 一个"写对了长什么样"的样本。
//
// 与结构化注入（4.3）的区别：
//   - 4.3 StructuredInjector 是"按需注入相关符号块"（解决大海捞针）
//   - 4.5 StyleSampleInjector 是"主动注入风格样本"（引导 AI 写出风格一致的代码）
//   - 前者是精准裁剪，后者是主动引导
//
// 陷阱 #153：打样注入可能让 AI 过度模仿而照抄业务逻辑
//   - 虽标注"勿照抄业务逻辑"，AI 仍可能把样板业务代码原样复制
//   - 样板应优先选"结构清晰但业务简单"的文件（基础接口、配置示例）
//   - 避免选包含复杂业务逻辑的核心模块
//   - 注入后可选检查 AI 产出与样板的相似度，过高时警告"疑似照抄样板"

import { logger } from '../utils/logger.js';
import type { FileStructure } from './structured-injector.js';

// ============================================================
// 类型定义
// ============================================================

/** 打样注入结果 */
export interface StyleSampleInjection {
  /** 注入的文本（含标注 + 结构概览 + 截断代码） */
  injected: string;
  /** 总 token 数（估算） */
  tokens: number;
  /** 是否被截断 */
  truncated: boolean;
}

// ============================================================
// 依赖注入接口
// ============================================================

/**
 * 读文件接口（依赖注入，便于测试 mock）
 */
export interface ReadFileFn {
  /** 读取文件全文 */
  (filePath: string): Promise<string>;
}

/**
 * 列目录接口（依赖注入，用于 autoDetectSamples）
 */
export interface ListFilesFn {
  /**
   * 列出目录下的文件（递归或单层由实现方决定）
   * @param dirPath 目录路径
   * @returns 文件路径数组（相对或绝对由实现方决定）
   */
  (dirPath: string): Promise<string[]>;
}

/**
 * CodeMap 接口（依赖注入，用于提取结构概览）
 */
export interface StyleCodeMapInterface {
  /** 获取文件结构概览 */
  getFileStructure(filePath: string): Promise<FileStructure>;
}

// ============================================================
// 常量
// ============================================================

/** 打样注入默认 token 上限（蓝图 4.5） */
const DEFAULT_MAX_TOKENS = 1500;

/**
 * 自动识别打样候选文件的优先级模式（陷阱 #153）
 *
 * 优先选"结构清晰但业务简单"的文件：
 *   - index.ts / main.ts（入口文件，结构清晰）
 *   - *.interface.ts / types.ts（接口定义，业务简单）
 *   - config.ts / *.config.ts（配置示例，结构清晰）
 *   - README（项目说明）
 */
const ENTRY_FILE_PATTERNS = [
  /(^|\/)index\.(ts|js|tsx|jsx)$/,
  /(^|\/)main\.(ts|js|tsx|jsx)$/,
  /(^|\/)app\.(ts|js|tsx|jsx)$/,
];

const INTERFACE_FILE_PATTERNS = [
  /(^|\/)types\.(ts|js|tsx|jsx)$/,
  /(^|\/).*\.interface\.(ts|js|tsx|jsx)$/,
  /(^|\/)interfaces\.(ts|js|tsx|jsx)$/,
];

const CONFIG_FILE_PATTERNS = [
  /(^|\/)config\.(ts|js|tsx|jsx)$/,
  /(^|\/).*\.config\.(ts|js|tsx|jsx)$/,
  /(^|\/)settings\.(ts|js|tsx|jsx)$/,
];

/** 自动识别返回的文件数量上限 */
const AUTO_DETECT_LIMIT = 5;

// ============================================================
// StyleSampleInjector
// ============================================================

/**
 * 打样注入器
 *
 * 使用方式：
 *   const injector = new StyleSampleInjector({ readFile, codeMap, listFiles });
 *   const result = await injector.injectStyleSample('src/index.ts');
 *   const samples = await injector.autoDetectSamples('src/');
 */
export class StyleSampleInjector {
  private readonly readFileFn: ReadFileFn;
  private readonly codeMap: StyleCodeMapInterface | null;
  private readonly listFilesFn: ListFilesFn | null;

  constructor(options: {
    readFile: ReadFileFn;
    codeMap?: StyleCodeMapInterface;
    listFiles?: ListFilesFn;
  }) {
    this.readFileFn = options.readFile;
    this.codeMap = options.codeMap ?? null;
    this.listFilesFn = options.listFiles ?? null;
  }

  /**
   * 注入打样代码
   *
   * 流程（蓝图 4.5）：
   *   1. 读取样板文件
   *   2. 用代码地图提取结构概览（符号列表 + 类签名 + 函数签名）
   *   3. 截断到 maxTokens
   *   4. 组装注入文本——明确标注是"风格样本"而非"待修改的代码"
   *
   * 陷阱 #153：标注"勿照抄业务逻辑"
   *
   * @param samplePath 样板文件路径（来自 node.attractor.styleSample）
   * @param maxTokens 打样注入的 token 上限（默认 1500）
   */
  async injectStyleSample(
    samplePath: string,
    maxTokens: number = DEFAULT_MAX_TOKENS,
  ): Promise<StyleSampleInjection> {
    // 1. 读取样板文件
    const content = await this.readFileFn(samplePath);

    // 2. 提取结构概览（若 codeMap 可用）
    let structureSummary = '';
    if (this.codeMap) {
      try {
        const structure = await this.codeMap.getFileStructure(samplePath);
        structureSummary = structure.summary || this.formatStructureSummary(structure);
      } catch (err) {
        logger.debug('StyleSampleInjector: codeMap getFileStructure failed, skip', {
          samplePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. 截断到 maxTokens（预留标注 + 结构概览的 token）
    const headerTokens = this.estimateTokens(this.formatHeader(samplePath, structureSummary));
    const remainingBudget = Math.max(0, maxTokens - headerTokens);
    const { truncatedContent, truncated } = this.truncateContent(content, remainingBudget);

    // 4. 组装注入文本
    const injected = this.formatInjection(samplePath, structureSummary, truncatedContent, truncated);
    const tokens = this.estimateTokens(injected);

    logger.debug('StyleSampleInjector: injected', {
      samplePath,
      tokens,
      truncated,
      contentLength: content.length,
    });

    return { injected, tokens, truncated };
  }

  /**
   * 自动识别项目中的打样文件
   *
   * 启发式（蓝图 4.5）：扫描 src/ 下的入口文件、基础接口、配置示例
   * 返回 3-5 个最具代表性的文件
   *
   * 陷阱 #153：优先选"结构清晰但业务简单"的文件
   *   - 入口文件（index/main/app）：结构清晰，能代表项目骨架
   *   - 接口文件（types/interfaces）：业务简单，纯结构定义
   *   - 配置文件（config/settings）：结构清晰，业务简单
   *
   * @param projectPath 项目路径（通常为 src/）
   * @returns 打样候选文件路径数组（3-5 个）
   */
  async autoDetectSamples(projectPath: string): Promise<string[]> {
    if (!this.listFilesFn) {
      logger.debug('StyleSampleInjector: no listFiles configured, autoDetect skipped');
      return [];
    }

    const allFiles = await this.listFilesFn(projectPath);

    // 按优先级分类
    const entryFiles: string[] = [];
    const interfaceFiles: string[] = [];
    const configFiles: string[] = [];

    for (const file of allFiles) {
      const normalized = file.replace(/\\/g, '/');
      if (ENTRY_FILE_PATTERNS.some((p) => p.test(normalized))) {
        entryFiles.push(file);
      } else if (INTERFACE_FILE_PATTERNS.some((p) => p.test(normalized))) {
        interfaceFiles.push(file);
      } else if (CONFIG_FILE_PATTERNS.some((p) => p.test(normalized))) {
        configFiles.push(file);
      }
    }

    // 按优先级合并：入口 > 接口 > 配置
    const candidates: string[] = [
      ...entryFiles,
      ...interfaceFiles,
      ...configFiles,
    ];

    // 陷阱 #153：限制为 3-5 个，优先选结构清晰的
    return candidates.slice(0, AUTO_DETECT_LIMIT);
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 组装注入文本 */
  private formatInjection(
    samplePath: string,
    structureSummary: string,
    content: string,
    truncated: boolean,
  ): string {
    const parts: string[] = [];

    // 陷阱 #153：标注"风格样本"，明确不是待修改的代码
    parts.push('【风格样本：参照此文件的结构/命名/错误处理风格，勿照抄业务逻辑】');

    // 文件路径
    parts.push(`文件：${samplePath}`);

    // 结构概览（若有）
    if (structureSummary) {
      parts.push(`结构概览：${structureSummary}`);
    }

    // 截断标注
    if (truncated) {
      parts.push('（内容已截断到 token 上限）');
    }

    // 代码块
    parts.push('```');
    parts.push(content);
    parts.push('```');

    return parts.join('\n');
  }

  /** 格式化头部（用于预估 token） */
  private formatHeader(samplePath: string, structureSummary: string): string {
    const parts: string[] = [
      '【风格样本：参照此文件的结构/命名/错误处理风格，勿照抄业务逻辑】',
      `文件：${samplePath}`,
    ];
    if (structureSummary) {
      parts.push(`结构概览：${structureSummary}`);
    }
    parts.push('```');
    return parts.join('\n');
  }

  /** 截断内容到 token 上限 */
  private truncateContent(
    content: string,
    maxTokens: number,
  ): { truncatedContent: string; truncated: boolean } {
    if (!content) {
      return { truncatedContent: '', truncated: false };
    }
    // 粗略估算：按 token 上限反推字符数（混合中英文，取保守值 3 字符/token）
    const maxChars = maxTokens * 3;
    if (content.length <= maxChars) {
      return { truncatedContent: content, truncated: false };
    }
    return {
      truncatedContent: content.slice(0, maxChars),
      truncated: true,
    };
  }

  /** 格式化结构概要（当 structure.summary 为空时从 symbols 构造） */
  private formatStructureSummary(structure: FileStructure): string {
    if (structure.symbols.length === 0) return '（未识别到符号）';
    const names = structure.symbols.slice(0, 10).map((s) => `${s.name}(${s.kind})`);
    return names.join(', ');
  }

  /** 估算 token 数（简单启发式：英文 4 字符/token，中文 2 字符/token） */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars / 2 + otherChars / 4);
  }
}
