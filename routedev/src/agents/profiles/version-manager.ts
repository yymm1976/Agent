/**
 * AgentProfile 版本管理器
 * 负责版本快照的保存、列表、加载、diff、回滚与保留策略
 *
 * 存储路径：
 *   ${rootDir}/.routedev/skills/agents/<profileId>/versions/<versionId>.json
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentProfile } from './types.js';
import type { VersionMeta, VersionRecord, VersionSource, FieldChange, FieldDiff } from './version-types.js';

/** 每个 Profile 最多保留版本数 */
const MAX_VERSIONS_PER_PROFILE = 20;

/** P1-1：revision schema v2 迁移 marker（存在 = 已完成统一 revision 空间迁移） */
const REVISION_SCHEMA_MARKER = '.revision-schema-v2';

/** 参与 diff / fieldChanges 的字段 */
const DIFF_FIELDS: (keyof AgentProfile)[] = [
  'name',
  'description',
  'systemPrompt',
  'modelId',
  'version',
  'role',
  'allowedTools',
  'forbiddenTools',
  'boundSkills',
  'maxTokens',
  'maxSteps',
  'canChallenge',
  'challengeSeverity',
  'outputFormat',
];

/** 磁盘上的持久化格式（与 VersionRecord 同构，便于兼容） */
interface PersistedVersion {
  meta: VersionMeta;
  snapshot: AgentProfile;
}

export class VersionManager {
  constructor(private rootDir: string) {}

  /** 获取某 Profile 的 versions 目录 */
  private versionsDir(profileId: string): string {
    return join(this.rootDir, '.routedev', 'skills', 'agents', profileId, 'versions');
  }

  private versionPath(profileId: string, versionId: string): string {
    return join(this.versionsDir(profileId), `${versionId}.json`);
  }

  private ensureDir(profileId: string): void {
    const dir = this.versionsDir(profileId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * P1-1 修复（复审）：Migration V2——统一 revision 空间。
   * 旧算法"legacy 从 maxExisting+1 起"在混合态（已 revision 记录 + legacy）
   * 会把老 legacy 排到新 revision 之后（破坏 newer > older 不变量）。
   *
   * 新算法（正式一次性 canonical migration）：
   *   1. 全部记录排序：legacy（timestamp ASC → versionId ASC）在前，
   *      已有 revision 的 post-schema 记录（revision ASC）在后
   *   2. 统一重新赋号 revision 1..N（每个文件 tmp+rename 原子写）
   *   3. 迁移完成后写 marker 文件（.revision-schema-v2）——幂等防重复迁移；
   *      marker 之前存在 = 半迁移状态（写入中断），重新执行（幂等，值不变）
   * GA 前无外部消费者，重编号安全。
   * @returns 迁移后的最大 revision（供 nextRevision 使用）
   */
  ensureRevisions(profileId: string): number {
    const dir = this.versionsDir(profileId);
    if (!existsSync(dir)) return 0;
    const marker = join(dir, REVISION_SCHEMA_MARKER);
    // 已迁移：只读当前最大 revision（不重写）
    if (existsSync(marker)) {
      return this.maxRevision(profileId);
    }

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const entries: Array<{ file: string; meta: VersionMeta | null }> = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const record = JSON.parse(raw) as PersistedVersion;
        entries.push({ file, meta: record?.meta ?? null });
      } catch {
        entries.push({ file, meta: null }); // corrupt JSON：跳过（不迁移不阻塞）
      }
    }

    // legacy（无 revision）：timestamp ASC → versionId ASC
    const legacy = entries
      .filter((e) => e.meta !== null && typeof e.meta!.revision !== 'number')
      .sort((a, b) => {
        const ta = a.meta!.timestamp;
        const tb = b.meta!.timestamp;
        if (ta !== tb) return ta - tb;
        return a.meta!.versionId < b.meta!.versionId ? -1 : a.meta!.versionId > b.meta!.versionId ? 1 : 0;
      });
    // post-schema（已有 revision）：revision ASC——旧版保存的新版本在 legacy 之后
    const postSchema = entries
      .filter((e) => e.meta !== null && typeof e.meta!.revision === 'number')
      .sort((a, b) => (a.meta!.revision as number) - (b.meta!.revision as number));

    // 统一 revision 空间：legacy 先（历史更旧），post-schema 后（新版本保持 newest）
    const ordered = [...legacy, ...postSchema];
    let next = 1;
    for (const e of ordered) {
      // crash-safe：tmp + rename 原子写回
      const raw = readFileSync(join(dir, e.file), 'utf-8');
      const record = JSON.parse(raw) as PersistedVersion;
      record.meta = { ...record.meta, revision: next };
      const filePath = join(dir, e.file);
      const tmpPath = `${filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
      renameSync(tmpPath, filePath);
      next += 1;
    }
    // 迁移全部成功后才写 marker（中断则下次重跑，幂等）
    writeFileSync(marker, new Date().toISOString(), 'utf-8');
    return next - 1;
  }

  /** 读取当前最大 revision（迁移后调用；无记录返回 0） */
  private maxRevision(profileId: string): number {
    const dir = this.versionsDir(profileId);
    if (!existsSync(dir)) return 0;
    let max = 0;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const record = JSON.parse(raw) as PersistedVersion;
        const rev = record?.meta?.revision;
        if (typeof rev === 'number' && rev > max) max = rev;
      } catch {
        // 损坏文件跳过
      }
    }
    return max;
  }

  /** 分配单调 revision（先正式迁移，再取 max+1） */
  private nextRevision(profileId: string): number {
    const max = this.ensureRevisions(profileId);
    return max + 1;
  }

  private generateVersionId(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = randomBytes(4).toString('hex');
    return `${ts}-${rand}`;
  }

  /**
   * 计算相对前一快照的字段变更
   */
  private computeFieldChanges(
    previous: AgentProfile | undefined,
    current: AgentProfile,
  ): FieldChange[] {
    if (!previous) return [];
    const changes: FieldChange[] = [];
    for (const field of DIFF_FIELDS) {
      const before = previous[field];
      const after = current[field];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({ field, before, after });
      }
    }
    return changes;
  }

  /**
   * 生成人类可读变更摘要
   */
  private buildChangeSummary(fieldChanges: FieldChange[]): string {
    if (fieldChanges.length === 0) return '';
    return fieldChanges
      .map((c) => {
        if (typeof c.before === 'string' || typeof c.after === 'string' || typeof c.before === 'number' || typeof c.after === 'number') {
          return `${c.field}: ${String(c.before)} → ${String(c.after)}`;
        }
        return `${c.field} changed`;
      })
      .join('; ');
  }

  /**
   * 保存当前 profile 为新版本快照
   * @returns versionId
   */
  async saveVersion(
    profile: AgentProfile,
    source: VersionSource,
    previousSnapshot?: AgentProfile,
  ): Promise<string> {
    this.ensureDir(profile.id);
    const versionId = this.generateVersionId();
    const timestamp = Date.now();
    const revision = this.nextRevision(profile.id);
    const fieldChanges = this.computeFieldChanges(previousSnapshot, profile);
    const changeSummary = this.buildChangeSummary(fieldChanges);

    const meta: VersionMeta = {
      versionId,
      profileId: profile.id,
      timestamp,
      revision,
      source,
      fieldChanges,
      changeSummary,
    };

    const record: PersistedVersion = {
      meta,
      snapshot: structuredClone(profile),
    };

    writeFileSync(
      this.versionPath(profile.id, versionId),
      JSON.stringify(record, null, 2),
      'utf-8',
    );

    this.enforceRetention(profile.id);
    return versionId;
  }

  /**
   * 列出某 Profile 的所有版本元数据（按时间倒序，最新在前）
   */
  async listVersions(profileId: string): Promise<VersionMeta[]> {
    // P1-1：先执行统一 revision 迁移——避免混合态 `revision ?? timestamp` 跨数值域比较
    this.ensureRevisions(profileId);
    const dir = this.versionsDir(profileId);
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const metas: VersionMeta[] = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const record = JSON.parse(raw) as PersistedVersion;
        if (record?.meta) {
          metas.push(record.meta);
        }
      } catch {
        // skip corrupt files
      }
    }

    // 第九轮复审：revision 是唯一排序键（同毫秒保存的版本顺序确定）
    return metas.sort((a, b) => b.revision - a.revision);
  }

  /**
   * 加载指定版本的完整记录（含 snapshot）
   * @throws 版本不存在时抛错
   */
  async loadVersion(profileId: string, versionId: string): Promise<VersionRecord> {
    const path = this.versionPath(profileId, versionId);
    if (!existsSync(path)) {
      throw new Error(`Version not found: ${profileId}/${versionId}`);
    }
    try {
      const raw = readFileSync(path, 'utf-8');
      const record = JSON.parse(raw) as PersistedVersion;
      if (!record?.meta || !record?.snapshot) {
        throw new Error(`Corrupt version record: ${profileId}/${versionId}`);
      }
      return { meta: record.meta, snapshot: record.snapshot };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Version not found')) throw err;
      if (err instanceof Error && err.message.startsWith('Corrupt')) throw err;
      throw new Error(`Failed to load version ${profileId}/${versionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 比较两个版本的字段差异
   */
  async diffVersions(
    profileId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<FieldDiff[]> {
    const from = await this.loadVersion(profileId, fromVersionId);
    const to = await this.loadVersion(profileId, toVersionId);
    return this.diffProfiles(from.snapshot, to.snapshot);
  }

  /**
   * 比较当前 Profile 与指定历史版本的字段差异
   * @param currentProfile 当前内存中的 Profile
   * @param targetVersionId 目标历史版本 ID
   */
  async diffCurrentWith(
    profileId: string,
    currentProfile: AgentProfile,
    targetVersionId: string,
  ): Promise<FieldDiff[]> {
    const target = await this.loadVersion(profileId, targetVersionId);
    return this.diffProfiles(target.snapshot, currentProfile);
  }

  /**
   * 字段级 diff
   */
  diffProfiles(before: AgentProfile, after: AgentProfile): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    for (const field of DIFF_FIELDS) {
      const b = before[field];
      const a = after[field];
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        diffs.push({ field, before: b, after: a });
      }
    }
    return diffs;
  }

  /**
   * 回滚到指定版本，返回该版本的 profile 快照
   * @throws 版本不存在时抛错
   */
  async rollbackTo(profileId: string, versionId: string): Promise<AgentProfile> {
    const record = await this.loadVersion(profileId, versionId);
    return structuredClone(record.snapshot);
  }

  /**
   * 删除某 Profile 的全部版本目录
   */
  async deleteAllVersions(profileId: string): Promise<void> {
    const dir = this.versionsDir(profileId);
    if (!existsSync(dir)) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  /**
   * 保留策略：超过 MAX_VERSIONS_PER_PROFILE 时删除最旧的
   */
  enforceRetention(profileId: string): void {
    // P1-1：先统一 revision（避免混合态排序错乱误删新版本）
    this.ensureRevisions(profileId);
    const dir = this.versionsDir(profileId);
    if (!existsSync(dir)) return;

    // 同步列出（enforce 常在 save 后调用）
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const metas: VersionMeta[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const record = JSON.parse(raw) as PersistedVersion;
        if (record?.meta) metas.push(record.meta);
      } catch {
        // skip
      }
    }
    metas.sort((a, b) => b.revision - a.revision);

    if (metas.length <= MAX_VERSIONS_PER_PROFILE) return;

    const toDelete = metas.slice(MAX_VERSIONS_PER_PROFILE);
    for (const v of toDelete) {
      try {
        const p = this.versionPath(profileId, v.versionId);
        if (existsSync(p)) unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }

  /** 获取最大保留数（供测试） */
  static get maxVersionsPerProfile(): number {
    return MAX_VERSIONS_PER_PROFILE;
  }
}
