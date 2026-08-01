// src/workspace/manager.ts
// Phase 97 Part D：工作区管理器
//
// 设计目的：
//   工作区 CRUD + 启动校验 + 路径边界判定。持久化为本地 JSON（本地优先、可检查），
//   复用 safeWriteJSON 原子写入。路径边界判定（isPathAllowed）供权限引擎按工作区
//   授权范围拦截文件类工具，而非依赖提示词约束。

import fs from 'node:fs/promises';
import path from 'node:path';
import { safeWriteJSON } from '../utils/safe-write.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir, ensureDir } from '../utils/paths.js';
import type { Workspace, WorkspaceManagerConfig } from './types.js';

/** 路径规范化：统一为正斜杠；Windows 下统一小写（文件系统不区分大小写） */
function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 判断 target 是否位于 root 之下（前缀匹配 + 路径边界，防止 /a 匹配 /abc） */
function isWithin(root: string, target: string): boolean {
  const r = normalizePath(path.resolve(root));
  const t = normalizePath(path.resolve(target));
  return t === r || t.startsWith(r + '/');
}

export class WorkspaceManager {
  private workspaces = new Map<string, Workspace>();
  private activeWorkspaceId: string | null = null;
  private storageFile: string;
  private loaded = false;

  constructor(config?: WorkspaceManagerConfig) {
    this.storageFile = config?.storageFile ?? path.join(getAppDataDir(), 'workspaces.json');
  }

  /** 从磁盘加载工作区（幂等，重复调用仅首次生效） */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.storageFile, 'utf-8');
      const parsed = JSON.parse(raw) as { workspaces?: Workspace[]; activeWorkspaceId?: string };
      const list = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
      for (const ws of list) {
        if (ws && typeof ws.id === 'string' && typeof ws.projectRoot === 'string') {
          this.workspaces.set(ws.id, ws);
        }
      }
      this.activeWorkspaceId = parsed.activeWorkspaceId ?? null;
      this.loaded = true;
      logger.debug('WorkspaceManager loaded', { count: this.workspaces.size });
    } catch (err) {
      // 文件不存在或损坏：fail-open，从空工作区开始
      this.loaded = true;
      logger.warn('WorkspaceManager load failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 持久化到磁盘（原子写） */
  async save(): Promise<void> {
    try {
      ensureDir(path.dirname(this.storageFile));
      await safeWriteJSON(this.storageFile, {
        workspaces: [...this.workspaces.values()],
        activeWorkspaceId: this.activeWorkspaceId,
      });
    } catch (err) {
      logger.warn('WorkspaceManager save failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 新增/覆盖工作区 */
  addWorkspace(ws: Workspace): void {
    this.workspaces.set(ws.id, ws);
  }

  /** 删除工作区 */
  removeWorkspace(id: string): void {
    this.workspaces.delete(id);
    if (this.activeWorkspaceId === id) {
      this.activeWorkspaceId = null;
    }
  }

  /** 按 id 获取工作区 */
  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  /** 列出全部工作区 */
  listWorkspaces(): Workspace[] {
    return [...this.workspaces.values()];
  }

  /** 设置当前工作区 */
  setActiveWorkspace(id: string | null): void {
    this.activeWorkspaceId = id;
  }

  /** 获取当前工作区 */
  getActiveWorkspace(): Workspace | null {
    if (!this.activeWorkspaceId) return null;
    return this.workspaces.get(this.activeWorkspaceId) ?? null;
  }

  /** 当前工作区 id（可为空） */
  getActiveWorkspaceId(): string | null {
    return this.activeWorkspaceId;
  }

  /**
   * 工作区授权根目录集合：projectRoot + attachedDirectories + attachedFiles 的父目录
   * 用于权限引擎的路径边界判定
   */
  getAllowedRoots(id: string): string[] {
    const ws = this.workspaces.get(id);
    if (!ws) return [];
    const roots = [ws.projectRoot, ...(ws.attachedDirectories ?? [])];
    for (const file of ws.attachedFiles ?? []) {
      roots.push(path.dirname(file));
    }
    // 去重（按规范化路径）
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const r of roots) {
      const norm = normalizePath(path.resolve(r));
      if (!seen.has(norm)) {
        seen.add(norm);
        unique.push(r);
      }
    }
    return unique;
  }

  /**
   * 判断绝对路径是否位于工作区授权范围内
   * 未找到工作区或未设置 active 时返回 true（fail-open，不阻断现有行为）
   */
  isPathAllowed(id: string | null | undefined, absPath: string): boolean {
    if (!id) return true;
    const roots = this.getAllowedRoots(id);
    if (roots.length === 0) return true;
    return roots.some(root => isWithin(root, absPath));
  }

  /** 启动校验：返回失效的附加路径列表（目录/文件不存在） */
  async validateAttachments(): Promise<{ workspaceId: string; missing: string[] }[]> {
    const results: { workspaceId: string; missing: string[] }[] = [];
    for (const ws of this.workspaces.values()) {
      const missing: string[] = [];
      for (const dir of ws.attachedDirectories ?? []) {
        try {
          await fs.access(dir);
        } catch {
          missing.push(dir);
        }
      }
      for (const file of ws.attachedFiles ?? []) {
        try {
          await fs.access(file);
        } catch {
          missing.push(file);
        }
      }
      if (missing.length > 0) {
        results.push({ workspaceId: ws.id, missing });
      }
    }
    return results;
  }
}
