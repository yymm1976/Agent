// src/import/codex-importer.ts
// Codex Instructions 导入器（Phase 48 Task 3）
//
// 设计目标：
//   1. 扫描项目根目录下的 .codex/ 目录，识别 Codex CLI 项目级配置
//   2. 主入口 .codex/instructions.md，兼容旧版 .codex/codex.md
//   3. 多个 markdown 文件按字母顺序合并，用 \n\n---\n\n 分隔
//   4. 三种导入模式：
//      - system_prompt：返回字符串供上层追加到 system prompt
//      - project_memory：按段落切分，每段打 codexMemoryTag 标签
//      - ignore：记录用户选择，不实际导入
//   5. hasUpdates 通过 mtime 比较判断是否需要重新提示
//
// 陷阱 #130：导入时必须返回明确模式，不能默默覆盖已有记忆
// 来源：Phase 48 Task 3 蓝图 3.1-3.5

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 扫描结果 */
export interface CodexScanResult {
  /** 是否找到 .codex/ 目录及至少一个 markdown 文件 */
  found: boolean;
  /** 相对路径列表（按字母顺序排序） */
  files: string[];
  /** 绝对路径列表（与 files 一一对应） */
  absolutePaths: string[];
  /** 多个文件按字母顺序合并（用 \n\n---\n\n 分隔） */
  content: string;
  /** 合并后内容的总字节数（UTF-8） */
  totalBytes: number;
}

/** 导入结果 */
export interface CodexImportResult {
  /** 实际使用的导入模式 */
  mode: 'system_prompt' | 'project_memory' | 'ignore';
  /** 已导入的文件相对路径列表 */
  importedFiles: string[];
  /** 合并后内容总字节数 */
  totalBytes: number;
  /** system_prompt 模式：返回追加到 system prompt 的内容 */
  systemPromptContent?: string;
  /** project_memory 模式：按段落切分后的记忆条目（已打 codexMemoryTag 标签） */
  memoryEntries?: Array<{ tag: string; content: string }>;
  /** ignore 模式：标记用户选择忽略（用于持久化） */
  ignored?: boolean;
  /** 过程中产生的警告（空文件、二进制读取失败等） */
  warnings: string[];
}

/** 导入选项 */
export interface CodexImportOptions {
  projectRoot: string;
  mode: 'system_prompt' | 'project_memory' | 'ignore';
  /** project_memory 模式下使用的标签，默认 'codex-instruction' */
  memoryTag?: string;
}

// ============================================================
// 常量
// ============================================================

/** Codex 配置目录名（相对项目根） */
const CODEX_DIR_NAME = '.codex';
// Codex 主入口与兼容文件名（仅文档说明；扫描时统一收集 .codex 下所有 .md 文件按字母顺序合并）：
//   - instructions.md：主入口
//   - codex.md：部分版本兼容文件
/** markdown 文件扩展名 */
const MD_EXT = '.md';
/** 多文件合并分隔符 */
const FILE_SEPARATOR = '\n\n---\n\n';
/** 单段最大字符数，超过则按句号二次切分 */
const MAX_PARAGRAPH_CHARS = 1000;

// ============================================================
// CodexInstructionImporter
// ============================================================

/**
 * Codex Instructions 导入器
 *
 * 用法：
 *   const importer = new CodexInstructionImporter();
 *   const scan = await importer.scan(projectRoot);
 *   if (scan.found) {
 *     const result = await importer.import({ projectRoot, mode: 'project_memory' });
 *     if (result.memoryEntries) {
 *       for (const entry of result.memoryEntries) {
 *         await memory.appendMemory(`[${entry.tag}] ${entry.content}`);
 *       }
 *     }
 *   }
 *
 * 设计要点：
 *   - scan 只读不写，可重复调用
 *   - import 不直接调用 ProjectMemoryManager，只返回结构化数据，
 *     由上层决定如何写入（陷阱 #130：避免默默覆盖已有记忆）
 *   - 单个文件读取失败时记入 warnings 不中断整体导入
 */
export class CodexInstructionImporter {
  /**
   * 扫描项目根目录下的 .codex/ 目录
   *
   * 查找规则（按字母顺序合并）：
   *   - .codex/instructions.md（主入口）
   *   - .codex/codex.md（部分版本兼容）
   *   - .codex/ 下其他 markdown 文件
   *
   * 目录不存在或无 markdown 文件时返回 found: false
   *
   * @param projectRoot 项目根目录绝对路径
   */
  async scan(projectRoot: string): Promise<CodexScanResult> {
    const codexDir = path.join(projectRoot, CODEX_DIR_NAME);
    const empty: CodexScanResult = {
      found: false,
      files: [],
      absolutePaths: [],
      content: '',
      totalBytes: 0,
    };

    if (!fsSync.existsSync(codexDir)) {
      logger.debug('CodexImporter.scan: directory not found', { codexDir });
      return empty;
    }

    // 收集所有 .md 文件
    const mdFiles: string[] = [];
    try {
      const entries = await fs.readdir(codexDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(MD_EXT)) {
          mdFiles.push(entry.name);
        }
      }
    } catch (err) {
      logger.warn('CodexImporter.scan: readdir failed', {
        dir: codexDir,
        error: err instanceof Error ? err.message : String(err),
      });
      return empty;
    }

    if (mdFiles.length === 0) {
      logger.debug('CodexImporter.scan: no markdown files', { codexDir });
      return empty;
    }

    // 按字母顺序排序（instructions.md 与 codex.md 混在一起，统一按文件名排序）
    mdFiles.sort();

    const files: string[] = [];
    const absolutePaths: string[] = [];
    const contents: string[] = [];

    for (const name of mdFiles) {
      const absPath = path.join(codexDir, name);
      try {
        const content = await fs.readFile(absPath, 'utf-8');
        files.push(path.join(CODEX_DIR_NAME, name));
        absolutePaths.push(absPath);
        contents.push(content);
      } catch (err) {
        // 单个文件读取失败不影响其他文件（在 import 阶段也会收集 warnings）
        logger.warn('CodexImporter.scan: readFile failed', {
          file: absPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (contents.length === 0) {
      return empty;
    }

    const merged = contents.join(FILE_SEPARATOR);
    const totalBytes = Buffer.byteLength(merged, 'utf-8');

    logger.info('CodexImporter.scan: done', {
      dir: codexDir,
      fileCount: files.length,
      totalBytes,
    });

    return {
      found: true,
      files,
      absolutePaths,
      content: merged,
      totalBytes,
    };
  }

  /**
   * 导入 Codex Instructions
   *
   * 三种模式：
   *   - system_prompt：合并内容，返回 systemPromptContent
   *   - project_memory：按段落切分，每段打 memoryTag 标签
   *   - ignore：返回 ignored=true，不实际导入
   *
   * 陷阱 #130：导入时返回明确模式与数据，由上层决定写入策略，
   *            避免导入器直接覆盖已有项目记忆
   *
   * @param options.projectRoot 项目根目录绝对路径
   * @param options.mode 导入模式
   * @param options.memoryTag project_memory 模式下的标签（默认 codex-instruction）
   */
  async import(options: CodexImportOptions): Promise<CodexImportResult> {
    const { projectRoot, mode } = options;
    const memoryTag = options.memoryTag ?? 'codex-instruction';
    const warnings: string[] = [];

    const scan = await this.scan(projectRoot);

    if (!scan.found) {
      // 未找到 .codex/ 目录：返回空结果，由上层决定是否提示用户
      return {
        mode,
        importedFiles: [],
        totalBytes: 0,
        warnings,
      };
    }

    // 收集 warnings：检查空文件
    for (const [i, relPath] of scan.files.entries()) {
      const absPath = scan.absolutePaths[i]!;
      try {
        const stat = await fs.stat(absPath);
        if (stat.size === 0) {
          warnings.push(`文件为空：${relPath}`);
        }
      } catch {
        // stat 失败不影响整体
      }
    }

    switch (mode) {
      case 'system_prompt':
        return {
          mode,
          importedFiles: scan.files,
          totalBytes: scan.totalBytes,
          systemPromptContent: scan.content,
          warnings,
        };

      case 'project_memory': {
        const entries = this.splitIntoMemoryEntries(scan.content, memoryTag);
        logger.info('CodexImporter.import: project_memory', {
          files: scan.files.length,
          entries: entries.length,
          tag: memoryTag,
        });
        return {
          mode,
          importedFiles: scan.files,
          totalBytes: scan.totalBytes,
          memoryEntries: entries,
          warnings,
        };
      }

      case 'ignore':
        return {
          mode,
          importedFiles: [],
          totalBytes: 0,
          ignored: true,
          warnings,
        };

      default:
        // 穷尽性检查：mode 已被 Zod 枚举约束，此处不应到达
        return {
          mode,
          importedFiles: [],
          totalBytes: 0,
          warnings: [`未知模式：${mode as string}`],
        };
    }
  }

  /**
   * 检查文件是否已更新（用于 ignore 模式下判断是否重新提示）
   *
   * 比较当前文件 mtime 与上次记录的 mtime：
   *   - 任何文件 mtime 变化 → 返回 true
   *   - 新增文件 → 返回 true
   *   - 文件被删除 → 返回 true（用户可能已清理 .codex/）
   *   - 全部一致 → 返回 false
   *
   * @param projectRoot 项目根目录绝对路径
   * @param lastSeenMtimes 上次记录的 mtime 映射（key 为相对路径，value 为 mtimeMs）
   */
  async hasUpdates(
    projectRoot: string,
    lastSeenMtimes: Record<string, number>,
  ): Promise<boolean> {
    const scan = await this.scan(projectRoot);

    // .codex/ 目录消失 → 视为更新（用户可能删除了配置）
    if (!scan.found) {
      return Object.keys(lastSeenMtimes).length > 0;
    }

    // 新增文件 → 更新
    if (scan.files.length !== Object.keys(lastSeenMtimes).length) {
      return true;
    }

    // 逐文件比较 mtime
    for (const [i, relPath] of scan.files.entries()) {
      const absPath = scan.absolutePaths[i]!;
      try {
        const stat = await fs.stat(absPath);
        const last = lastSeenMtimes[relPath];
        if (last === undefined) {
          // 新文件
          return true;
        }
        // mtime 比较用 Math.floor 避免浮点精度问题（不同文件系统精度不同）
        if (Math.floor(stat.mtimeMs) !== Math.floor(last)) {
          return true;
        }
      } catch {
        // stat 失败视为更新（文件可能被删除）
        return true;
      }
    }

    return false;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 将合并后的内容切分为记忆条目
   *
   * 切分优先级：
   *   1. 按 ## 标题切分（每段包含标题行）
   *   2. 无标题时按双换行切分
   *   3. 单段超过 1000 字符时按句号二次切分
   *
   * 每段前不加标签前缀（tag 单独存于返回对象的 tag 字段），
   * 由上层在写入 MEMORY.md 时拼接 [tag] content
   *
   * @param content 合并后的完整内容
   * @param tag 记忆标签
   */
  private splitIntoMemoryEntries(
    content: string,
    tag: string,
  ): Array<{ tag: string; content: string }> {
    const trimmed = content.trim();
    if (!trimmed) return [];

    // 1. 优先按 ## 标题切分
    let segments = this.splitByH2Header(trimmed);

    // 2. 无标题时按双换行切分
    if (segments.length <= 1) {
      segments = this.splitByDoubleNewline(trimmed);
    }

    // 3. 单段超过 1000 字符时按句号切分
    const result: Array<{ tag: string; content: string }> = [];
    for (const seg of segments) {
      const clean = seg.trim();
      if (!clean) continue;

      if (clean.length > MAX_PARAGRAPH_CHARS) {
        const subSegs = this.splitBySentence(clean);
        for (const sub of subSegs) {
          const s = sub.trim();
          if (s) {
            result.push({ tag, content: s });
          }
        }
      } else {
        result.push({ tag, content: clean });
      }
    }

    return result;
  }

  /**
   * 按 ## 标题切分（每段包含标题行）
   *
   * 例：
   *   ## 编码规范
   *   内容1
   *   ## 测试规范
   *   内容2
   *
   * 切分为：
   *   ["## 编码规范\n内容1", "## 测试规范\n内容2"]
   *
   * 若首段 ## 之前有非空内容（如 H1 标题），作为独立的 preamble 段保留
   */
  private splitByH2Header(content: string): string[] {
    // 匹配行首的 ## 标题（不含 ### 及更深层级）
    const lines = content.split('\n');
    const segments: string[] = [];
    let current: string[] = [];
    let foundHeader = false;

    for (const line of lines) {
      // 行首 ## 后跟空格，且不是 ###
      const isH2 = /^## (?!#)/.test(line);
      if (isH2) {
        // 首次遇到 ##：把之前累积的 preamble（若非空）作为独立段保留
        if (!foundHeader) {
          const preamble = current.join('\n').trim();
          if (preamble) {
            segments.push(preamble);
          }
          current = [];
        } else if (current.length > 0) {
          segments.push(current.join('\n'));
          current = [];
        }
        current = [line];
        foundHeader = true;
      } else {
        current.push(line);
      }
    }
    if (current.length > 0 && foundHeader) {
      segments.push(current.join('\n'));
    }

    // 如果没找到任何 ## 标题，返回原内容（调用方会回退到双换行切分）
    if (!foundHeader) {
      return [content];
    }
    return segments;
  }

  /**
   * 按双换行切分（段落级）
   */
  private splitByDoubleNewline(content: string): string[] {
    return content
      .split(/\n\s*\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  /**
   * 按句号切分（用于超长段落二次切分）
   *
   * 支持中英文句号：。 . ! ?
   * 每个句号保留在前一段末尾
   */
  private splitBySentence(content: string): string[] {
    // 按 。.!? 切分，保留分隔符
    const parts = content.split(/(?<=[。.!?])\s+/);
    const result: string[] = [];
    let buffer = '';

    for (const part of parts) {
      buffer += part;
      // 累积到一定长度（约 300 字符）后切出一段
      if (buffer.length >= 300) {
        result.push(buffer);
        buffer = '';
      }
    }
    if (buffer.trim()) {
      result.push(buffer);
    }

    return result.length > 0 ? result : [content];
  }
}
