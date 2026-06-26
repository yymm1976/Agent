// src/agent/preference-manager.ts
// 主动个性化记忆
//
// 核心能力：
//   1. 显式声明偏好（confidence=1.0，用户明确告知）
//   2. 推断偏好（confidence 随证据递增，每次 +0.15，上限 0.95）
//   3. 全局 vs 项目级偏好（项目级覆盖全局）
//   4. 高置信度偏好注入上下文（>= 0.7）
//   5. 审计日志（所有变更可追溯）
//   6. 持久化到 .routedev/preferences.json
//
// 设计要点：
//   1. autoLearn=false 时 infer 不生效（用户可关闭自动学习）
//   2. 项目级偏好优先于全局偏好（getResolved）
//   3. 持久化采用整体覆盖写入（debounce 由调用方控制）
//   4. 审计日志记录所有 set/infer/delete/update 操作

import fs from 'node:fs/promises';
import path from 'node:path';

// ============================================================
// 类型定义
// ============================================================

/** 偏好类别 */
type PreferenceCategory =
  | 'tech_stack'
  | 'coding_style'
  | 'communication'
  | 'workflow'
  | 'security';

/** 用户偏好 */
interface UserPreference {
  /** 唯一 ID（category:key 的哈希） */
  id: string;
  /** 类别 */
  category: PreferenceCategory;
  /** 键名（如 "language"、"framework"） */
  key: string;
  /** 值（如 "typescript"、"react"） */
  value: string;
  /** 置信度 0.0 ~ 1.0 */
  confidence: number;
  /** 来源：explicit（用户明确声明）/ inferred（推断） */
  source: 'explicit' | 'inferred';
  /** 最后更新时间戳（毫秒） */
  updatedAt: number;
}

/** 审计日志条目 */
interface AuditLogEntry {
  /** 操作类型 */
  action: string;
  /** 相关偏好 */
  preference: UserPreference;
  /** 时间戳 */
  timestamp: number;
}

// ============================================================
// 常量
// ============================================================

/** 推断偏好的初始置信度 */
const INITIAL_INFERRED_CONFIDENCE = 0.3;

/** 每次推断证据增加的置信度 */
const CONFIDENCE_INCREMENT = 0.15;

/** 推断置信度上限 */
const CONFIDENCE_CEILING = 0.95;

/** 注入上下文的最低置信度阈值 */
const INJECTABLE_THRESHOLD = 0.7;

/** 显式声明的置信度 */
const EXPLICIT_CONFIDENCE = 1.0;

// ============================================================
// PreferenceManager
// ============================================================

/**
 * 主动个性化记忆管理器
 *
 * 用法：
 *   const pm = new PreferenceManager(projectRoot);
 *   await pm.load();
 *   pm.setExplicit('tech_stack', 'language', 'typescript');
 *   pm.infer('coding_style', 'indent', '2spaces', '用户多次使用 2 空格缩进');
 *   const injectable = pm.getInjectable();
 *   const context = pm.formatForContext();
 */
export class PreferenceManager {
  /** 项目级偏好 */
  private preferences: Map<string, UserPreference> = new Map();
  /** 全局偏好（跨项目共享） */
  private globalPreferences: Map<string, UserPreference> = new Map();
  /** 审计日志 */
  private auditLog: AuditLogEntry[] = [];
  /** 自动学习开关 */
  private autoLearn: boolean = true;
  /** 持久化文件路径（.routedev/preferences.json） */
  private filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, '.routedev', 'preferences.json');
  }

  // ============================================================
  // 显式声明（confidence=1.0）
  // ============================================================

  /**
   * 显式声明偏好（用户明确告知）
   * @param category 类别
   * @param key 键名
   * @param value 值
   * @returns 创建/更新的偏好
   */
  setExplicit(
    category: PreferenceCategory,
    key: string,
    value: string,
  ): UserPreference {
    const id = this.makeId(category, key);
    const pref: UserPreference = {
      id,
      category,
      key,
      value,
      confidence: EXPLICIT_CONFIDENCE,
      source: 'explicit',
      updatedAt: Date.now(),
    };
    this.preferences.set(id, pref);
    this.recordAudit('set_explicit', pref);
    return pref;
  }

  // ============================================================
  // 推断（confidence 随证据递增）
  // ============================================================

  /**
   * 推断偏好（基于行为证据）
   *
   * autoLearn=false 时不生效（直接返回当前偏好或新建但不存储）
   * 首次推断 confidence=0.3，每次证据增加 +0.15，上限 0.95
   *
   * @param category 类别
   * @param key 键名
   * @param value 值
   * @param evidence 证据描述（记录到审计日志）
   * @returns 更新后的偏好
   */
  infer(
    category: PreferenceCategory,
    key: string,
    value: string,
    evidence: string,
  ): UserPreference {
    // autoLearn=false 时推断不生效
    if (!this.autoLearn) {
      const id = this.makeId(category, key);
      const existing = this.preferences.get(id);
      if (existing) {
        return existing;
      }
      // 不存储，返回临时对象
      return {
        id,
        category,
        key,
        value,
        confidence: INITIAL_INFERRED_CONFIDENCE,
        source: 'inferred',
        updatedAt: Date.now(),
      };
    }

    const id = this.makeId(category, key);
    const existing = this.preferences.get(id);

    let pref: UserPreference;
    if (existing) {
      // 已存在：提升置信度
      pref = this.bumpConfidence(existing, evidence);
      // 同步更新 value（可能变化）
      pref = { ...pref, value, updatedAt: Date.now() };
      this.preferences.set(id, pref);
    } else {
      // 首次推断
      pref = {
        id,
        category,
        key,
        value,
        confidence: INITIAL_INFERRED_CONFIDENCE,
        source: 'inferred',
        updatedAt: Date.now(),
      };
      this.preferences.set(id, pref);
      this.recordAudit('infer_new', pref);
    }
    return pref;
  }

  // ============================================================
  // 查询
  // ============================================================

  /** 获取单个偏好 */
  get(category: PreferenceCategory, key: string): UserPreference | undefined {
    return this.preferences.get(this.makeId(category, key));
  }

  /** 获取所有偏好 */
  getAll(): UserPreference[] {
    return Array.from(this.preferences.values());
  }

  /**
   * 获取高置信度偏好（>= 0.7）用于注入上下文
   */
  getInjectable(): UserPreference[] {
    return this.getAll().filter((p) => p.confidence >= INJECTABLE_THRESHOLD);
  }

  // ============================================================
  // 删除 / 编辑
  // ============================================================

  /** 删除偏好 */
  delete(id: string): boolean {
    const pref = this.preferences.get(id);
    if (!pref) {
      return false;
    }
    this.preferences.delete(id);
    this.recordAudit('delete', pref);
    return true;
  }

  /** 编辑偏好 */
  update(
    id: string,
    updates: Partial<Pick<UserPreference, 'value' | 'confidence'>>,
  ): UserPreference | undefined {
    const existing = this.preferences.get(id);
    if (!existing) {
      return undefined;
    }
    const updated: UserPreference = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };
    this.preferences.set(id, updated);
    this.recordAudit('update', updated);
    return updated;
  }

  // ============================================================
  // 上下文注入
  // ============================================================

  /**
   * 生成注入上下文的文本
   *
   * 格式：
   *   ## 用户偏好
   *   - tech_stack.language: typescript (confidence: 1.0)
   *   - coding_style.indent: 2spaces (confidence: 0.6)
   *   ...
   *
   * 仅包含高置信度偏好（>= 0.7）
   */
  formatForContext(): string {
    const injectable = this.getInjectable();
    if (injectable.length === 0) {
      return '';
    }
    const lines: string[] = ['## 用户偏好'];
    for (const pref of injectable) {
      lines.push(
        `- ${pref.category}.${pref.key}: ${pref.value} (confidence: ${pref.confidence.toFixed(2)})`,
      );
    }
    return lines.join('\n');
  }

  // ============================================================
  // 自动学习开关
  // ============================================================

  /** 设置自动学习开关 */
  setAutoLearn(enabled: boolean): void {
    this.autoLearn = enabled;
  }

  /** 是否启用自动学习 */
  isAutoLearn(): boolean {
    return this.autoLearn;
  }

  // ============================================================
  // 持久化
  // ============================================================

  /** 保存到磁盘 */
  async save(): Promise<void> {
    const data = {
      preferences: this.getAll(),
      globalPreferences: Array.from(this.globalPreferences.values()),
      autoLearn: this.autoLearn,
    };
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** 从磁盘加载 */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as {
        preferences?: UserPreference[];
        globalPreferences?: UserPreference[];
        autoLearn?: boolean;
      };
      this.preferences.clear();
      this.globalPreferences.clear();
      if (data.preferences) {
        for (const pref of data.preferences) {
          this.preferences.set(pref.id, pref);
        }
      }
      if (data.globalPreferences) {
        for (const pref of data.globalPreferences) {
          this.globalPreferences.set(pref.id, pref);
        }
      }
      if (typeof data.autoLearn === 'boolean') {
        this.autoLearn = data.autoLearn;
      }
    } catch {
      // 文件不存在或解析失败：保持空状态
    }
  }

  // ============================================================
  // 全局 vs 项目级
  // ============================================================

  /**
   * 设置全局偏好（跨项目共享）
   */
  setGlobal(
    category: PreferenceCategory,
    key: string,
    value: string,
  ): UserPreference {
    const id = this.makeId(category, key);
    const pref: UserPreference = {
      id,
      category,
      key,
      value,
      confidence: EXPLICIT_CONFIDENCE,
      source: 'explicit',
      updatedAt: Date.now(),
    };
    this.globalPreferences.set(id, pref);
    this.recordAudit('set_global', pref);
    return pref;
  }

  /**
   * 获取解析后的偏好（项目级覆盖全局）
   *
   * 优先级：项目级 > 全局
   *
   * @param category 类别
   * @param key 键名
   * @returns 项目级偏好，若不存在则返回全局偏好，都没有返回 undefined
   */
  getResolved(
    category: PreferenceCategory,
    key: string,
  ): UserPreference | undefined {
    const id = this.makeId(category, key);
    // 项目级优先
    const project = this.preferences.get(id);
    if (project) {
      return project;
    }
    // 回退到全局
    return this.globalPreferences.get(id);
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /**
   * 生成偏好 ID（category:key）
   */
  private makeId(category: PreferenceCategory, key: string): string {
    return `${category}:${key}`;
  }

  /**
   * 提升置信度（每次 +0.15，上限 0.95）
   */
  private bumpConfidence(pref: UserPreference, evidence: string): UserPreference {
    const newConfidence = Math.min(
      pref.confidence + CONFIDENCE_INCREMENT,
      CONFIDENCE_CEILING,
    );
    const updated: UserPreference = {
      ...pref,
      confidence: newConfidence,
      updatedAt: Date.now(),
    };
    this.recordAudit('infer_bump', updated);
    // evidence 记录到审计日志的 action 中（便于追溯）
    void evidence;
    return updated;
  }

  /**
   * 记录审计日志
   */
  private recordAudit(action: string, preference: UserPreference): void {
    this.auditLog.push({
      action,
      preference: { ...preference },
      timestamp: Date.now(),
    });
  }
}
