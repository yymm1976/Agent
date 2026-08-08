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
import { RouteDevError } from '../../utils/errors.js';

/** 每个 Profile 最多保留版本数 */
const MAX_VERSIONS_PER_PROFILE = 20;

/** P1-1：revision schema v2 迁移 marker（存在 = 已完成统一 revision 空间迁移） */
const REVISION_SCHEMA_MARKER = '.revision-schema-v2';

/** F-011：不可变迁移 plan 文件（崩溃恢复用） */
const REVISION_SCHEMA_PLAN = '.revision-schema-v2.plan.json';

/** F-011：迁移 plan schema 版本 */
const MIGRATION_PLAN_SCHEMA = 2;

/** F-011：迁移 plan——file → targetRevision 不可变映射（迁移前持久化） */
interface RevisionMigrationPlanV2 {
  schema: typeof MIGRATION_PLAN_SCHEMA;
  entries: Array<{ file: string; targetRevision: number }>;
}

/**
 * GA Hardening 第5项：迁移 plan 损坏错误（fail-closed）
 * plan 损坏（JSON 解析失败/schema 不符/结构非法）时抛出——
 * 绝不重扫当前状态重新生成（半迁移态重扫 = 混合态分类，revision collision 风险），
 * 绝不覆盖/修改任何版本文件。
 * Closure 4（Recovery Contract）：恢复指引禁止"删除 plan 重扫"——
 * 半迁移状态下删除 plan 会重新打开 F-011 原始缺陷。只允许：
 *   1. 从备份恢复 plan 文件（迁移未开始/完整时安全）
 *   2. 从备份恢复整个版本目录（权威恢复路径）
 *   3. 显式 recovery tooling（由维护者确认迁移状态后处理）
 */
export class MigrationPlanCorruptError extends RouteDevError {
  readonly planPath: string;

  constructor(planPath: string, reason: string) {
    super(
      `迁移 plan 损坏（fail-closed），迁移未执行、未修改任何版本文件：${reason}。` +
      `恢复指引（按顺序尝试）：` +
      `(1) 从备份恢复 ${REVISION_SCHEMA_PLAN} 文件——仅在迁移确认未开始时安全；` +
      `(2) 从备份恢复整个版本目录；` +
      `(3) 使用显式 recovery tooling（人工确认迁移状态）。` +
      `警告：半迁移状态下删除 plan 文件并重扫会重新打开 revision 冲突缺陷（F-011），禁止作为默认恢复手段。`,
      'MIGRATION_PLAN_CORRUPT',
      { details: `plan 路径: ${planPath}` },
    );
    this.planPath = planPath;
  }
}

/** GA Hardening 第5项：校验 plan 结构——非法即 fail-closed（返回失败原因，null = 合法） */
function validateMigrationPlan(plan: unknown, planPath: string): string | null {
  if (typeof plan !== 'object' || plan === null) return 'plan 不是对象';
  const p = plan as { schema?: unknown; entries?: unknown };
  if (p.schema !== MIGRATION_PLAN_SCHEMA) return `schema=${String(p.schema)}（期望 ${MIGRATION_PLAN_SCHEMA}）`;
  if (!Array.isArray(p.entries)) return 'entries 不是数组';
  const seenTargets = new Set<number>();
  const seenFiles = new Set<string>();
  for (const entry of p.entries) {
    if (typeof entry !== 'object' || entry === null) return 'entries 含非对象项';
    const e = entry as { file?: unknown; targetRevision?: unknown };
    if (typeof e.file !== 'string' || e.file.length === 0) return 'entry.file 非法';
    // Closure 4：file 必须是合法 basename——禁止路径分隔符与 '..'，
    // 防止损坏 plan 把迁移边界打穿（写入目录外文件）
    if (e.file.includes('/') || e.file.includes('\\') || e.file === '..' || e.file.startsWith('..')) {
      return `entry.file 不是合法 basename: ${e.file}`;
    }
    if (seenFiles.has(e.file)) return `file 重复: ${e.file}`;
    seenFiles.add(e.file);
    if (typeof e.targetRevision !== 'number' || !Number.isInteger(e.targetRevision) || e.targetRevision <= 0) {
      return `entry(${e.file}).targetRevision 非法`;
    }
    if (seenTargets.has(e.targetRevision)) return `targetRevision 重复: ${e.targetRevision}`;
    seenTargets.add(e.targetRevision);
  }
  // Closure 4：target revisions 必须连续（恰好 1..N）——损坏 plan 不得把迁移边界打穿
  const maxTarget = Math.max(...seenTargets);
  if (seenTargets.size !== maxTarget) {
    return `targetRevision 不连续（期望 1..${seenTargets.size}）`;
  }
  return null;
}

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
   * F-011 修复（复审）：Migration V2 事务化——不可变 plan 先持久化，崩溃后按 plan resume。
   *
   * 旧实现"逐文件迁移 + 最后写 marker"在中间崩溃后，已迁移文件（revision 已写）
   * 会被重新扫描误判为 post-schema，与真正的新版本产生 revision collision——
   * 无法幂等恢复（"从已改数据反推原始分类"不可靠）。
   *
   * 新流程：
   *   1. 无 marker 且无 plan：扫描原始状态 → 确定完整 file→targetRevision 映射
   *      → 原子写 plan 文件（.revision-schema-v2.plan.json）
   *   2. 按 plan 逐文件迁移（无论当前值如何，一律写为 plan.targetRevision——幂等）
   *   3. 全部完成 → 验证 → 原子写正式 marker → 删 plan
   *   4. 崩溃在任何点恢复：plan 存在 → 直接按 plan 重放（幂等）
   *
   * 分类信息（legacy/post-schema）只来自 plan 生成时的一次扫描，不再从已改数据反推。
   * @returns 迁移后的最大 revision（供 nextRevision 使用）
   */
  ensureRevisions(profileId: string): number {
    const dir = this.versionsDir(profileId);
    if (!existsSync(dir)) return 0;
    const marker = join(dir, REVISION_SCHEMA_MARKER);
    const planPath = join(dir, REVISION_SCHEMA_PLAN);
    // 已迁移：只读当前最大 revision（不重写）
    if (existsSync(marker)) {
      return this.maxRevision(profileId);
    }

    // 崩溃恢复：plan 已存在 → 按 plan 重放（幂等）
    // GA Hardening 第5项：plan 损坏（解析失败/schema 不符/结构非法）→ fail-closed——
    // 不重扫当前状态重新生成（半迁移态重扫 = 混合态分类，revision collision 风险）、
    // 不覆盖任何文件、不写 marker，抛出明确 recovery error 由操作者决定恢复路径
    let plan: RevisionMigrationPlanV2 | null = null;
    if (existsSync(planPath)) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(readFileSync(planPath, 'utf-8'));
      } catch {
        throw new MigrationPlanCorruptError(planPath, 'JSON 解析失败');
      }
      const invalidReason = validateMigrationPlan(parsed, planPath);
      if (invalidReason !== null) {
        throw new MigrationPlanCorruptError(planPath, invalidReason);
      }
      plan = parsed as RevisionMigrationPlanV2;
    }
    if (!plan) {
      // 生成不可变 plan（分类信息只在此处确定；此处仅在"无 plan 文件"时可达——
      // plan 损坏已由第5项 fail-closed 拦截，不存在半迁移态重扫）
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      const entries: Array<{ file: string; meta: VersionMeta | null }> = [];
      for (const file of files) {
        try {
          const raw = readFileSync(join(dir, file), 'utf-8');
          const record = JSON.parse(raw) as PersistedVersion;
          entries.push({ file, meta: record?.meta ?? null });
        } catch {
          entries.push({ file, meta: null }); // corrupt JSON：跳过
        }
      }
      // 分类：无 revision 的按 legacy（timestamp ASC→versionId ASC），
      // 有 revision 的按 post-schema（revision ASC）——统一重编号 1..N。
      // 不依赖具体分类，只依赖全序，最终空间一致。
      const legacy = entries
        .filter((e) => e.meta !== null && typeof e.meta!.revision !== 'number')
        .sort((a, b) => {
          const ta = a.meta!.timestamp;
          const tb = b.meta!.timestamp;
          if (ta !== tb) return ta - tb;
          return a.meta!.versionId < b.meta!.versionId ? -1 : a.meta!.versionId > b.meta!.versionId ? 1 : 0;
        });
      const postSchema = entries
        .filter((e) => e.meta !== null && typeof e.meta!.revision === 'number')
        .sort((a, b) => (a.meta!.revision as number) - (b.meta!.revision as number));
      const ordered = [...legacy, ...postSchema];
      plan = {
        schema: MIGRATION_PLAN_SCHEMA,
        entries: ordered.map((e, i) => ({ file: e.file, targetRevision: i + 1 })),
      };
      // 原子写 plan（迁移开始前）
      const tmpPlan = `${planPath}.tmp`;
      writeFileSync(tmpPlan, JSON.stringify(plan, null, 2), 'utf-8');
      renameSync(tmpPlan, planPath);
    }

    // 按 plan 逐文件迁移（幂等：一律写 targetRevision）
    for (const entry of plan.entries) {
      const filePath = join(dir, entry.file);
      if (!existsSync(filePath)) continue; // 文件已被清理（如 retention）
      const raw = readFileSync(filePath, 'utf-8');
      const record = JSON.parse(raw) as PersistedVersion;
      if (record.meta.revision === entry.targetRevision) continue; // 已完成（resume 加速）
      record.meta = { ...record.meta, revision: entry.targetRevision };
      const tmpPath = `${filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
      renameSync(tmpPath, filePath);
    }
    // 验证：所有 plan 文件 revision == target
    for (const entry of plan.entries) {
      const filePath = join(dir, entry.file);
      if (!existsSync(filePath)) continue;
      const record = JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedVersion;
      if (record.meta.revision !== entry.targetRevision) {
        throw new Error(`Migration verification failed: ${entry.file} expected ${entry.targetRevision} got ${record.meta.revision}`);
      }
    }
    // 提交正式 marker + 删除 plan（原子：先写 marker 再删 plan）
    writeFileSync(marker, new Date().toISOString(), 'utf-8');
    try {
      unlinkSync(planPath);
    } catch {
      // plan 删除失败不影响（下次 ensureRevisions 见 marker 直接返回）
    }
    return plan.entries.length;
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
