// src/agents/profiles/version-types.ts
// AgentProfile 版本管理类型

/** 版本来源：用户编辑 / 程序写入 / 回滚；测试与扩展场景允许任意字符串 */
export type VersionSource = 'user_edit' | 'programmatic_write' | 'rollback' | (string & {});

/** 单个字段变更记录 */
export interface FieldChange {
  /** 变更字段名（如 name / maxSteps） */
  field: string;
  /** 变更前值 */
  before: unknown;
  /** 变更后值 */
  after: unknown;
}

/**
 * 版本元数据（列表展示用，不含完整 snapshot）
 */
export interface VersionMeta {
  versionId: string;
  profileId: string;
  /** 创建时间戳（ms）——展示用；排序以 revision 为准 */
  timestamp: number;
  /**
   * 第九轮复审：单调版本号（同 profile 内递增，唯一排序键）。
   * listVersions/rollback/retention 全部基于 revision——
   * 不再依赖墙钟毫秒（同毫秒保存两个版本时"谁新谁旧"由 revision 表达）。
   * 历史版本无此字段时按 timestamp 兼容排序。
   */
  revision: number;
  source: VersionSource;
  /** 相对上一版本的字段变更 */
  fieldChanges: FieldChange[];
  /** 人类可读变更摘要 */
  changeSummary: string;
  /** 可选标签 */
  label?: string;
}

/**
 * 完整版本记录（含 snapshot）
 */
export interface VersionRecord {
  meta: VersionMeta;
  /** 该版本时的完整 Profile 快照 */
  snapshot: import('./types.js').AgentProfile;
}

/** 字段级 diff 结果（用于 UI 对比） */
export interface FieldDiff {
  field: string;
  before: unknown;
  after: unknown;
}
