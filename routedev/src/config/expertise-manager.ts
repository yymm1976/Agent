// src/config/expertise-manager.ts
// Phase 40 Task 4：用户经验适配层
// 根据用户经验等级（beginner/intermediate/expert）调整 Agent 行为：
//   - 解释详细度（explanationDetail）
//   - 确认频率（confirmationFrequency）
//   - 批量操作上限（batchOperationLimit）
//   - 错误处理策略（errorHandling）
//   - 学习提示（learningTips）
//   - 默认输出风格（defaultOutputStyle）
// 配置持久化到 ${configPath}（JSON 文件），支持 overrides 覆盖单项默认值。

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

/** 用户经验等级 */
export type UserExpertise = 'beginner' | 'intermediate' | 'expert';

/** 解释详细度 */
export type ExplanationDetail = 'none' | 'key-only' | 'full';

/** 确认频率 */
export type ConfirmationFrequency = 'always' | 'risky-only' | 'minimal';

/** 错误处理策略 */
export type ErrorHandling = 'immediate' | 'auto-retry' | 'silent-retry';

/** 默认输出风格 */
export type DefaultOutputStyle = 'concise' | 'detailed' | 'structured';

/** 用户经验设置（持久化结构） */
export interface ExpertiseSettings {
  /** 经验等级，默认 'intermediate' */
  level: UserExpertise;
  /** 是否启用自动建议，默认 true */
  enableAutoSuggestion: boolean;
  /** 输出风格覆盖（null 表示使用等级默认值） */
  outputStyleOverride: string | null;
  /** 单项行为覆盖（可选） */
  overrides?: {
    explanationDetail?: ExplanationDetail;
    confirmationFrequency?: ConfirmationFrequency;
    batchOperationLimit?: number; // 0 = 禁用, -1 = 无限制
  };
}

/** 各等级的默认行为配置 */
export const EXPERTISE_BEHAVIOR: Record<
  UserExpertise,
  {
    explanationDetail: ExplanationDetail;
    confirmationFrequency: ConfirmationFrequency;
    batchOperationLimit: number;
    errorHandling: ErrorHandling;
    learningTips: boolean;
    defaultOutputStyle: DefaultOutputStyle;
  }
> = {
  beginner: {
    explanationDetail: 'full',
    confirmationFrequency: 'always', // 所有 write/execute 操作前确认
    batchOperationLimit: 0, // 禁用批量
    errorHandling: 'immediate',
    learningTips: true,
    defaultOutputStyle: 'detailed',
  },
  intermediate: {
    explanationDetail: 'key-only',
    confirmationFrequency: 'risky-only', // 仅 execute/network 确认
    batchOperationLimit: 3,
    errorHandling: 'auto-retry',
    learningTips: false,
    defaultOutputStyle: 'structured',
  },
  expert: {
    explanationDetail: 'none',
    confirmationFrequency: 'minimal', // 仅 push/delete 确认
    batchOperationLimit: -1, // 无限制
    errorHandling: 'silent-retry',
    learningTips: false,
    defaultOutputStyle: 'concise',
  },
};

/** 引导式等级选择问题答案 */
export interface RecommendAnswers {
  /** 对开发工具/命令行的熟悉度 */
  familiarity: 'high' | 'medium' | 'low';
  /** 期望的确认频率 */
  confirmation: 'always' | 'risky-only' | 'minimal';
  /** AI 编程助手使用经验 */
  aiExperience: 'new' | 'basic' | 'skilled';
}

/** 默认设置 */
const DEFAULT_SETTINGS: ExpertiseSettings = {
  level: 'intermediate',
  enableAutoSuggestion: true,
  outputStyleOverride: null,
};

/**
 * 用户经验管理器
 * 负责加载/保存经验设置，计算生效行为（合并默认值与 overrides）
 */
export class ExpertiseManager {
  private settings: ExpertiseSettings;
  private configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.settings = { ...DEFAULT_SETTINGS };
  }

  /** 从磁盘加载设置；文件不存在或解析失败时使用默认值 */
  async load(): Promise<void> {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.settings = { ...DEFAULT_SETTINGS };
        return;
      }
      const raw = await fs.promises.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ExpertiseSettings>;
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        overrides: parsed.overrides ? { ...parsed.overrides } : undefined,
      };
    } catch (err) {
      logger.warn('ExpertiseManager: load failed, fallback to defaults', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  /** 保存设置到磁盘（原子写入：先写临时文件再 rename） */
  async save(): Promise<void> {
    try {
      const dir = path.dirname(this.configPath);
      if (dir && !fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      const tmp = `${this.configPath}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(this.settings, null, 2), 'utf-8');
      await fs.promises.rename(tmp, this.configPath);
    } catch (err) {
      logger.error('ExpertiseManager: save failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** 获取当前等级 */
  getLevel(): UserExpertise {
    return this.settings.level;
  }

  /** 设置等级 */
  setLevel(level: UserExpertise): void {
    this.settings.level = level;
  }

  /** 获取 enableAutoSuggestion */
  getEnableAutoSuggestion(): boolean {
    return this.settings.enableAutoSuggestion;
  }

  /** 设置 enableAutoSuggestion */
  setEnableAutoSuggestion(enabled: boolean): void {
    this.settings.enableAutoSuggestion = enabled;
  }

  /** 设置输出风格覆盖（null 表示使用等级默认值） */
  setOutputStyleOverride(style: string | null): void {
    this.settings.outputStyleOverride = style;
  }

  /** 设置单项行为覆盖 */
  setOverrides(overrides: ExpertiseSettings['overrides']): void {
    this.settings.overrides = overrides ? { ...overrides } : undefined;
  }

  /** 获取原始设置（只读视图） */
  getSettings(): Readonly<ExpertiseSettings> {
    return this.settings;
  }

  /**
   * 获取生效的行为配置（合并默认值和 overrides）
   * outputStyle 优先级：outputStyleOverride > 等级默认值
   */
  getEffectiveBehavior() {
    const defaults = EXPERTISE_BEHAVIOR[this.settings.level];
    const overrides = this.settings.overrides || {};
    return {
      explanationDetail: overrides.explanationDetail ?? defaults.explanationDetail,
      confirmationFrequency: overrides.confirmationFrequency ?? defaults.confirmationFrequency,
      batchOperationLimit: overrides.batchOperationLimit ?? defaults.batchOperationLimit,
      errorHandling: defaults.errorHandling,
      learningTips: defaults.learningTips,
      outputStyle: this.settings.outputStyleOverride ?? defaults.defaultOutputStyle,
    };
  }

  /**
   * 引导式等级选择（3 个问题 → 推荐等级）
   * 加权计算：
   *   familiarity: high=0, medium=1, low=2
   *   confirmation: always=2, risky-only=1, minimal=0
   *   aiExperience: new=2, basic=1, skilled=0
   * 总分 0-2 → expert, 3-4 → intermediate, 5-6 → beginner
   */
  static recommendLevel(answers: RecommendAnswers): UserExpertise {
    const familiarityScore = answers.familiarity === 'high' ? 0 : answers.familiarity === 'medium' ? 1 : 2;
    const confirmationScore =
      answers.confirmation === 'always' ? 2 : answers.confirmation === 'risky-only' ? 1 : 0;
    const aiScore = answers.aiExperience === 'new' ? 2 : answers.aiExperience === 'basic' ? 1 : 0;
    const total = familiarityScore + confirmationScore + aiScore;
    if (total <= 2) return 'expert';
    if (total <= 4) return 'intermediate';
    return 'beginner';
  }
}
