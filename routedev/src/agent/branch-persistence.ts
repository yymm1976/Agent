// src/agent/branch-persistence.ts
// 节点持久化与恢复
//
// 职责：
//   - save/load：把对话节点树写入 .routedev/conversation/tree.jsonl
//   - 备份与恢复：写入前先备份到 .bak；文件损坏时从 .bak 恢复
//   - 快照：/compact 前调用 saveSnapshot，支持 listSnapshots / loadSnapshot
//   - validate：检测缺失节点引用、孤立分支等完整性问题
//   - extractFromManager / applyToManager：与 BranchManager 互转
//
// JSONL 格式：
//   第 1 行：header  { type:'header', version, activeBranchId, activeBranchKey, lastModifiedAt }
//   后续行：{ type:'node', ...BranchNode } 或 { type:'branch', ...BranchInfo }
//   末行：  { type:'history', nodeIds: string[] }

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BranchNode, BranchInfo } from './branch.js';
import { logger } from '../utils/logger.js';

/** 持久化的对话树 */
export interface PersistedConversationTree {
  version: 1;
  activeBranchId: string | null;
  activeBranchKey: string | null;
  nodes: BranchNode[];
  branches: BranchInfo[];
  historyNodeIds: string[];
  lastModifiedAt: number;
}

/** JSONL 行类型 */
type JsonlLine =
  | { type: 'header'; version: 1; activeBranchId: string | null; activeBranchKey: string | null; lastModifiedAt: number }
  | { type: 'node' } & BranchNode
  | { type: 'branch' } & BranchInfo
  | { type: 'history'; nodeIds: string[] };

/** BranchManager 的最小可访问形态（仅用于 extract/apply） */
interface ManagerLike {
  nodes: Map<string, BranchNode>;
  branches: Map<string, BranchInfo>;
  activeBranchId: string | null;
  activeBranchKey: string | null;
  historyNodeIds: string[];
}

export class BranchPersistence {
  private readonly filePath: string;
  private readonly backupPath: string;
  private readonly snapshotDir: string;

  constructor(rootDir: string) {
    const convDir = path.join(rootDir, '.routedev', 'conversation');
    this.filePath = path.join(convDir, 'tree.jsonl');
    this.backupPath = path.join(convDir, 'tree.jsonl.bak');
    this.snapshotDir = path.join(convDir, 'snapshots');
  }

  // ============================================================
  // save / load
  // ============================================================

  /** 保存节点树到 JSONL（先备份再写入） */
  async save(tree: PersistedConversationTree): Promise<void> {
    const payload = this.serialize(tree);
    await this.ensureDir(path.dirname(this.filePath));

    // 先备份当前正式文件（如果存在）
    try {
      if (fs.existsSync(this.filePath)) {
        await fsp.copyFile(this.filePath, this.backupPath);
      }
    } catch (err) {
      logger.warn?.('BranchPersistence: backup failed, proceeding to write', { err: String(err) });
    }

    // 原子写入：先写临时文件再 rename
    const tmpPath = this.filePath + '.tmp';
    await fsp.writeFile(tmpPath, payload, 'utf8');
    await fsp.rename(tmpPath, this.filePath);
  }

  /** 从 JSONL 加载节点树；文件损坏时尝试从 .bak 恢复 */
  async load(): Promise<PersistedConversationTree | null> {
    const primary = await this.tryLoadFile(this.filePath);
    if (primary.ok) return primary.tree;

    logger.warn?.('BranchPersistence: primary file unreadable, falling back to .bak', {
      error: primary.error,
    });
    const backup = await this.tryLoadFile(this.backupPath);
    if (backup.ok) return backup.tree;

    logger.warn?.('BranchPersistence: backup also unreadable', { error: backup.error });
    return null;
  }

  /** 显式从 .bak 恢复 */
  async loadFromBackup(): Promise<PersistedConversationTree | null> {
    const result = await this.tryLoadFile(this.backupPath);
    if (result.ok) return result.tree;
    return null;
  }

  private async tryLoadFile(
    filePath: string,
  ): Promise<{ ok: true; tree: PersistedConversationTree } | { ok: false; error: string }> {
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch {
      return { ok: false, error: 'file-not-found' };
    }

    let tree: PersistedConversationTree;
    try {
      tree = this.deserialize(raw);
    } catch (err) {
      return { ok: false, error: String(err) };
    }

    const errors = BranchPersistence.validate(tree);
    if (errors.length > 0) {
      return { ok: false, error: `validation-failed: ${errors.join('; ')}` };
    }
    return { ok: true, tree };
  }

  // ============================================================
  // snapshot
  // ============================================================

  /** 保存快照（/compact 前调用）。返回快照名称。 */
  async saveSnapshot(tree: PersistedConversationTree): Promise<string> {
    await this.ensureDir(this.snapshotDir);
    const name = `snap-${Date.now()}.jsonl`;
    const snapPath = path.join(this.snapshotDir, name);
    const payload = this.serialize(tree);
    await fsp.writeFile(snapPath, payload, 'utf8');
    return name;
  }

  /** 列出所有快照名称（按时间倒序） */
  listSnapshots(): string[] {
    try {
      const entries = fs.readdirSync(this.snapshotDir);
      return entries
        .filter(f => f.startsWith('snap-') && f.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** 从快照恢复 */
  async loadSnapshot(snapshotName: string): Promise<PersistedConversationTree | null> {
    // 防止路径穿越
    const safe = path.basename(snapshotName);
    const snapPath = path.join(this.snapshotDir, safe);
    const result = await this.tryLoadFile(snapPath);
    return result.ok ? result.tree : null;
  }

  // ============================================================
  // 序列化 / 反序列化
  // ============================================================

  private serialize(tree: PersistedConversationTree): string {
    const lines: string[] = [];
    const header: JsonlLine = {
      type: 'header',
      version: 1,
      activeBranchId: tree.activeBranchId,
      activeBranchKey: tree.activeBranchKey,
      lastModifiedAt: tree.lastModifiedAt,
    };
    lines.push(JSON.stringify(header));
    for (const node of tree.nodes) {
      const line: JsonlLine = { type: 'node', ...node };
      lines.push(JSON.stringify(line));
    }
    for (const branch of tree.branches) {
      const line: JsonlLine = { type: 'branch', ...branch };
      lines.push(JSON.stringify(line));
    }
    const history: JsonlLine = { type: 'history', nodeIds: tree.historyNodeIds };
    lines.push(JSON.stringify(history));
    return lines.join('\n') + '\n';
  }

  private deserialize(raw: string): PersistedConversationTree {
    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) throw new Error('empty-file');

    let header: JsonlLine | null = null;
    const nodes: BranchNode[] = [];
    const branches: BranchInfo[] = [];
    let historyNodeIds: string[] = [];

    for (const line of lines) {
      const obj = JSON.parse(line) as JsonlLine;
      switch (obj.type) {
        case 'header':
          header = obj;
          break;
        case 'node': {
          const { type: _t, ...rest } = obj;
          nodes.push(rest as BranchNode);
          break;
        }
        case 'branch': {
          const { type: _t, ...rest } = obj;
          branches.push(rest as BranchInfo);
          break;
        }
        case 'history':
          historyNodeIds = obj.nodeIds;
          break;
        default:
          // 未知行类型忽略，向前兼容
          break;
      }
    }

    if (!header || header.type !== 'header') {
      throw new Error('missing-header');
    }

    return {
      version: 1,
      activeBranchId: header.activeBranchId,
      activeBranchKey: header.activeBranchKey,
      nodes,
      branches,
      historyNodeIds,
      lastModifiedAt: header.lastModifiedAt,
    };
  }

  // ============================================================
  // validate
  // ============================================================

  /** 校验数据完整性，返回错误列表（空数组=有效） */
  static validate(tree: PersistedConversationTree): string[] {
    const errors: string[] = [];

    if (tree.version !== 1) {
      errors.push(`unsupported-version: ${tree.version}`);
    }

    const nodeIds = new Set<string>();
    for (const n of tree.nodes) {
      if (nodeIds.has(n.id)) errors.push(`duplicate-node-id: ${n.id}`);
      nodeIds.add(n.id);
    }

    // 节点引用完整性
    for (const n of tree.nodes) {
      if (n.parentId !== null && !nodeIds.has(n.parentId)) {
        errors.push(`missing-parent: node ${n.id} references missing parent ${n.parentId}`);
      }
      for (const c of n.children) {
        if (!nodeIds.has(c)) {
          errors.push(`missing-child: node ${n.id} references missing child ${c}`);
        }
      }
    }

    const branchIds = new Set<string>();
    for (const b of tree.branches) {
      if (branchIds.has(b.id)) errors.push(`duplicate-branch-id: ${b.id}`);
      branchIds.add(b.id);
      if (!nodeIds.has(b.tipNodeId)) {
        errors.push(`branch-tip-missing: branch ${b.id} tip ${b.tipNodeId} not in nodes`);
      }
      if (b.parentId !== null && !branchIds.has(b.parentId) && !nodeIds.has(b.parentId)) {
        // 父分支可能尚未注册（孤立分支）
        errors.push(`orphan-branch: branch ${b.id} parent ${b.parentId} not in branches or nodes`);
      }
    }

    // historyNodeIds 必须都存在
    for (const hid of tree.historyNodeIds) {
      if (!nodeIds.has(hid)) {
        errors.push(`history-missing-node: ${hid}`);
      }
    }

    // activeBranchId 必须存在
    if (tree.activeBranchId !== null && !nodeIds.has(tree.activeBranchId)) {
      errors.push(`active-branch-id-missing: ${tree.activeBranchId}`);
    }
    if (tree.activeBranchKey !== null && !branchIds.has(tree.activeBranchKey)) {
      errors.push(`active-branch-key-missing: ${tree.activeBranchKey}`);
    }

    return errors;
  }

  // ============================================================
  // extract / apply
  // ============================================================

  /** 从 BranchManager 提取持久化数据 */
  static extractFromManager(manager: ManagerLike): PersistedConversationTree {
    return {
      version: 1,
      activeBranchId: manager.activeBranchId,
      activeBranchKey: manager.activeBranchKey,
      nodes: Array.from(manager.nodes.values()),
      branches: Array.from(manager.branches.values()),
      historyNodeIds: [...manager.historyNodeIds],
      lastModifiedAt: Date.now(),
    };
  }

  /** 应用持久化数据到 BranchManager（覆盖现有状态） */
  static applyToManager(tree: PersistedConversationTree, manager: ManagerLike): void {
    manager.nodes.clear();
    manager.branches.clear();
    for (const n of tree.nodes) manager.nodes.set(n.id, n);
    for (const b of tree.branches) manager.branches.set(b.id, b);
    manager.activeBranchId = tree.activeBranchId;
    manager.activeBranchKey = tree.activeBranchKey;
    manager.historyNodeIds = [...tree.historyNodeIds];
  }

  // ============================================================
  // helpers
  // ============================================================

  private async ensureDir(dir: string): Promise<void> {
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      // 并发创建时可能 EEXIST，忽略
    }
  }
}
