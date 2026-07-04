// src/cli/commands/context-manager.ts
// 轻量级 CLI 上下文管理器：对齐 Aider 的 /add 行为
//
// 设计：
//   - 进程内存级别（不持久化，重启清空）
//   - 单例导出，/include 命令与 LLM 上下文构建共用
//   - 加入时读取文件内容，存入 Map<path, content>
//   - getContent() 拼接所有文件内容为上下文文本，供 system prompt 注入
//   - 支持 glob 模式批量加入（src/**/*.ts）
//
// 与 agent/memory/context-manager.ts 的关系：
//   - 那是 Agent 内部的对话历史/触发器管理
//   - 本类是 CLI 层的"用户显式 /include 文件"管理，二者正交
//   - 父 Agent（app-init.ts）负责把 getContent() 注入 system prompt

import fs from 'node:fs/promises';
import path from 'node:path';

/** 文件元信息（用于 /include 无参数列表展示） */
export interface IncludedFileInfo {
  /** 绝对路径 */
  path: string;
  /** 文件字节数 */
  size: number;
  /** 文件行数 */
  lines: number;
}

/** 加入文件的结果 */
export interface AddFileResult {
  /** 是否成功加入（已存在或读取失败时为 false） */
  added: boolean;
  /** 失败原因（added=false 时有值） */
  reason?: string;
}

export class CliContextManager {
  /** path -> content，按加入顺序保留 */
  private includedFiles = new Map<string, string>();

  /**
   * 加入单个文件到上下文
   * @param filePath 文件路径（相对或绝对）
   * @param cwd 工作目录（用于解析相对路径）
   */
  async addFile(filePath: string, cwd: string = process.cwd()): Promise<AddFileResult> {
    const absPath = path.resolve(cwd, filePath);
    if (this.includedFiles.has(absPath)) {
      return { added: false, reason: '文件已在上下文中' };
    }
    try {
      const content = await fs.readFile(absPath, 'utf-8');
      this.includedFiles.set(absPath, content);
      return { added: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { added: false, reason: msg };
    }
  }

  /**
   * 从上下文移除文件
   * @param filePath 文件路径（相对或绝对）
   * @param cwd 工作目录
   */
  removeFile(filePath: string, cwd: string = process.cwd()): boolean {
    const absPath = path.resolve(cwd, filePath);
    return this.includedFiles.delete(absPath);
  }

  /** 获取所有已包含文件的元信息（按加入顺序） */
  getFiles(): IncludedFileInfo[] {
    const result: IncludedFileInfo[] = [];
    for (const [filePath, content] of this.includedFiles) {
      result.push({ path: filePath, size: Buffer.byteLength(content, 'utf-8'), lines: countLines(content) });
    }
    return result;
  }

  /**
   * 拼接所有文件内容为上下文文本
   * 格式参考 Aider：每个文件用 === filename === 包裹
   * 空上下文返回空串
   */
  getContent(): string {
    if (this.includedFiles.size === 0) return '';
    const blocks: string[] = [];
    for (const [filePath, content] of this.includedFiles) {
      blocks.push(`=== ${filePath} ===\n${content}`);
    }
    return blocks.join('\n\n');
  }

  /** 当前已包含文件数 */
  size(): number {
    return this.includedFiles.size;
  }

  /** 是否包含指定文件 */
  has(filePath: string, cwd: string = process.cwd()): boolean {
    const absPath = path.resolve(cwd, filePath);
    return this.includedFiles.has(absPath);
  }

  /** 清空所有已包含文件 */
  clear(): void {
    this.includedFiles.clear();
  }
}

/** 单例：进程内全局共享，/include 命令与 system prompt 注入共用 */
export const cliContextManager = new CliContextManager();

/**
 * 统计文件行数
 * 约定：以换行符结尾的文件，最后一行空串不计入行数
 *   - 'a\nb\nc\n' → 3 行（不是 4）
 *   - 'a\nb\nc'   → 3 行
 *   - ''          → 0 行
 */
function countLines(content: string): number {
  if (!content) return 0;
  const parts = content.split('\n');
  // 内容以 \n 结尾时，最后一个元素是空串，不计入
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    return parts.length - 1;
  }
  return parts.length;
}
