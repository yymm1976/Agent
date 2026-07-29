// src/session/conversation-persistence.ts
// Phase 96 P0-1：对话历史持久化（最小可用方案——重启恢复）
//
// 职责：
//   - 把 EngineContext.conversationHistory（LLMMessage[]）持久化为 JSONL
//   - 应用启动时 load，恢复上次对话
//   - sendChat 完成 / /clear / syncConversationHistory / 上下文压缩后 save
//   - 写入前先备份到 .bak，文件损坏时从 .bak 恢复
//
// 设计权衡：
//   - 不复用 BranchPersistence：其数据模型是 BranchNode 树（parentId/children），
//     与线性 LLMMessage[] 不匹配，强转会造成冗余字段与转换开销
//   - 不引入多 session 管理（JsonlSessionRepo 风格）：用户选择"最小可用"方案，
//     当前仅满足"重启恢复"需求，跨 session 列表/fork 留待后续
//   - 持久化范围与 conversationHistory 截断逻辑一致（最近 20 条），避免磁盘膨胀
//
// 文件格式：
//   每行一个 LLMMessage 的 JSON：{"role":"user","content":"..."}
//   content 为 string 或 ContentPart[]，均 JSON 可序列化
//   空文件或文件缺失视为无历史，返回 []

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { LLMMessage } from '../router/types.js';
import { logger } from '../utils/logger.js';
import { registerShutdownHook } from '../runtime/graceful-shutdown.js';

export class ConversationPersistence {
  private readonly filePath: string;
  private readonly backupPath: string;
  /** 写入防抖：同进程内多次 save 合并为一次写入 */
  private saveTimer: NodeJS.Timeout | null = null;
  /** 待写入的历史快照（防抖期间累积的最新值） */
  private pendingHistory: LLMMessage[] | null = null;
  /** 防抖窗口（毫秒）：sendChat 完成后短时间内可能触发多次 save，合并为一次 */
  private static readonly DEBOUNCE_MS = 500;

  constructor(rootDir: string) {
    const convDir = path.join(rootDir, '.routedev', 'conversation');
    this.filePath = path.join(convDir, 'history.jsonl');
    this.backupPath = path.join(convDir, 'history.jsonl.bak');
  }

  /**
   * 加载历史对话
   * 读取失败时尝试从 .bak 恢复；均失败返回空数组（fail-open）
   */
  async load(): Promise<LLMMessage[]> {
    const primary = await this.tryLoadFile(this.filePath);
    if (primary.ok) return primary.messages;

    logger.warn('ConversationPersistence: primary file unreadable, falling back to .bak', {
      error: primary.error,
    });
    const backup = await this.tryLoadFile(this.backupPath);
    if (backup.ok) return backup.messages;

    logger.warn('ConversationPersistence: backup also unreadable', { error: backup.error });
    return [];
  }

  /**
   * 保存历史对话（防抖写入）
   * 多次快速调用会合并为一次磁盘写入，避免 sendChat 后续触发链中重复 IO
   */
  save(history: LLMMessage[]): void {
    this.pendingHistory = history;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const snapshot = this.pendingHistory;
      if (snapshot === null) return;
      this.pendingHistory = null;
      this.flushWrite(snapshot).catch((err) => {
        logger.warn('ConversationPersistence: debounced save failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, ConversationPersistence.DEBOUNCE_MS);
    // 防抖定时器不阻止进程退出
    this.saveTimer.unref?.();
  }

  /**
   * 立即写入（跳过防抖）
   * 用于应用退出前的强制持久化（registerShutdownHook 调用）
   */
  async flush(history: LLMMessage[]): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.pendingHistory = null;
    }
    await this.flushWrite(history);
  }

  /** 清空历史文件（/clear 命令调用） */
  async clear(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.pendingHistory = null;
    }
    try {
      await fsp.unlink(this.filePath);
    } catch (err) {
      // 文件不存在视为已清空
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('ConversationPersistence: clear failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async flushWrite(history: LLMMessage[]): Promise<void> {
    const payload = this.serialize(history);
    await this.ensureDir(path.dirname(this.filePath));

    // 先备份当前正式文件（如果存在）
    try {
      if (fs.existsSync(this.filePath)) {
        await fsp.copyFile(this.filePath, this.backupPath);
      }
    } catch (err) {
      logger.warn('ConversationPersistence: backup failed, proceeding to write', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 原子写入：先写临时文件再 rename
    const tmpPath = this.filePath + '.tmp';
    await fsp.writeFile(tmpPath, payload, 'utf8');
    await fsp.rename(tmpPath, this.filePath);
  }

  private serialize(history: LLMMessage[]): string {
    if (history.length === 0) return '';
    const lines = history.map((msg) => JSON.stringify(msg));
    return lines.join('\n') + '\n';
  }

  private async tryLoadFile(
    filePath: string,
  ): Promise<{ ok: true; messages: LLMMessage[] } | { ok: false; error: string }> {
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch (e) {
      // 文件不存在（首次启动）视为空历史，不报警
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: true, messages: [] };
      logger.warn('[conversation-persistence] 读取文件失败', {
        filePath,
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, error: 'file-not-found' };
    }

    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: true, messages: [] };

    const messages: LLMMessage[] = [];
    const lines = trimmed.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      try {
        const obj = JSON.parse(lines[i]) as LLMMessage;
        // 基础校验：必须有 role 和 content 字段
        if (!obj || typeof obj.role !== 'string' || obj.content === undefined) {
          throw new Error(`line ${i + 1}: missing role or content`);
        }
        messages.push(obj);
      } catch (err) {
        return {
          ok: false,
          error: `parse-failed at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return { ok: true, messages };
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (e) {
      logger.warn('[conversation-persistence] ensureDir 失败', {
        dir,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
