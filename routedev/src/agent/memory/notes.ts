// src/agent/memory/notes.ts
// NotesManager：Agent 唯一写通道（蓝图 Section X.1）
// 自由格式草稿本 notes.md，Agent 推理过程中随时追加笔记
// CheckpointWriter 在 checkpoint 时读取 → 分类到结构化字段 → 清空
//
// 设计意图：
//   - Agent 不直接写结构化 checkpoint，只写自由格式笔记
//   - 结构化分类由 CheckpointWriter（LLM 子 Agent）完成
//   - 避免主 Agent 被记忆维护分心

import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../utils/logger.js';

/**
 * notes.md 管理器
 *
 * 负责 Agent 自由格式笔记的追加、读取、清空、大小查询。
 * 文件存储在 session 目录下（由构造函数传入）。
 */
export class NotesManager {
  private notesPath: string;

  constructor(sessionDir: string) {
    this.notesPath = path.join(sessionDir, 'notes.md');
  }

  /** Agent 追加笔记到 notes.md */
  async append(content: string): Promise<void> {
    try {
      // 确保目录存在
      const dir = path.dirname(this.notesPath);
      await fs.mkdir(dir, { recursive: true });
      // 追加内容 + 换行
      await fs.appendFile(this.notesPath, content + '\n', 'utf-8');
    } catch (error) {
      logger.warn('NotesManager: append failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** CheckpointWriter 读取全部笔记内容 */
  async readAll(): Promise<string> {
    try {
      return await fs.readFile(this.notesPath, 'utf-8');
    } catch {
      // 文件不存在时返回空字符串
      return '';
    }
  }

  /** CheckpointWriter 分类后清空 notes.md */
  async clear(): Promise<void> {
    try {
      await fs.writeFile(this.notesPath, '', 'utf-8');
    } catch (error) {
      logger.warn('NotesManager: clear failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 获取 notes.md 文件大小（字节） */
  async size(): Promise<number> {
    try {
      const stats = await fs.stat(this.notesPath);
      return stats.size;
    } catch {
      // 文件不存在时返回 0
      return 0;
    }
  }

  /** 获取 notes.md 路径（供测试和调试使用） */
  getPath(): string {
    return this.notesPath;
  }
}
