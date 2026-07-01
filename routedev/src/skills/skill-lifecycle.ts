// src/skills/skill-lifecycle.ts
// Skill 生命周期管理（Phase 52 Task 1 — MUSE-Autoskill 五阶段生命周期）
//
// 五阶段（来自 MUSE-Autoskill 论文）：
//   1. Creation — Agent 按需创建 Skill（重复执行相似任务 N 次时自动触发）
//   2. Memory — Skill 级记忆，积累跨任务经验
//   3. Management — Skill 组织、选择、淘汰
//   4. Evaluation — 单元测试 + 运行时反馈
//   5. Refinement — 基于评估结果优化 Skill 定义（不自动修改，需用户审批）
//
// 安全约束（陷阱 #171）：
//   - failurePatterns 与 successPaths 各最多 20 条，超出按频率淘汰低频项
//   - memoryRetentionDays 必须严格执行，过期记忆立即清理
//
// 注：SkillFlowEngine 已移除（Phase 49 实验性模块）
//   - SkillLifecycleManager 负责「是否要创建/优化 Skill」的决策
//   - Skill 执行由 AgentLoop 直接承担

import type { SkillLifecycleConfig } from '../config/schema.js';
// Phase 53 Task 6：技能安全门控（结构类型 import，无循环依赖）
import type { SkillSecurityGate } from './security-gate.js';

// ============================================================
// 类型定义
// ============================================================

/** 单次 Skill 执行记录 */
export interface SkillExecutionRecord {
  /** 执行时间戳（ms） */
  timestamp: number;
  /** 任务描述 */
  taskDescription: string;
  /** 执行步骤摘要 */
  stepsTaken: string[];
  /** 执行结果：成功 / 部分成功 / 失败 */
  outcome: 'success' | 'partial' | 'failure';
  /** 失败点（outcome 为 partial/failure 时填写） */
  failurePoint?: string;
  /** 用户反馈（可选） */
  userFeedback?: string;
  /** 执行耗时（ms） */
  durationMs: number;
}

/** 失败模式聚类 */
export interface SkillFailurePattern {
  /** 模式描述（如「文件路径不存在」「API 限流」） */
  pattern: string;
  /** 出现频率（次数） */
  frequency: number;
  /** 最后一次出现时间戳 */
  lastSeenAt: number;
  /** 关联的执行记录 ID 列表（最多保留 5 条示例） */
  exampleExecutionIds: string[];
}

/** Skill 级记忆 */
export interface SkillMemory {
  /** 关联的 Skill ID */
  skillId: string;
  /** 执行历史记录 */
  executions: SkillExecutionRecord[];
  /** 失败模式聚类（最多 20 条，按频率淘汰低频项） */
  failurePatterns: SkillFailurePattern[];
  /** 成功路径样本（最多 20 条，按最近使用排序） */
  successPaths: string[][];
  /** 最后一次精炼时间戳 */
  lastRefinedAt: number;
}

/** Skill 创建建议 */
export interface SkillCreationSuggestion {
  /** 建议的 Skill 名称 */
  suggestedName: string;
  /** 建议的分类 */
  suggestedCategory: string;
  /** 触发原因（人类可读） */
  reason: string;
  /** 检测到的相似任务数 */
  similarTaskCount: number;
  /** 示例任务描述（最多 5 条） */
  exampleTaskDescriptions: string[];
}

/** Skill 精炼提议 */
export interface SkillRefinementProposal {
  /** 关联的 Skill ID */
  skillId: string;
  /** 拟修改内容（人类可读描述） */
  proposedChanges: string;
  /** 修改理由 */
  rationale: string;
  /** 基于哪些失败模式 */
  basedOnFailurePatterns: string[];
  /** 预期改进效果 */
  expectedImprovement: string;
  /** 是否需要用户审批（autoApplyRefinement=false 时恒为 true） */
  requiresUserApproval: boolean;
}

/** 历史任务记录（用于触发创建判定） */
export interface TaskRecord {
  /** 任务描述 */
  description: string;
  /** 任务时间戳 */
  timestamp: number;
  /** 任务结果 */
  outcome: string;
  /** 关联的 Skill ID（已匹配到时填写） */
  skillId?: string;
}

// ============================================================
// 常量
// ============================================================

/** 失败模式与成功路径的最大保留条数（陷阱 #171） */
const MAX_FAILURE_PATTERNS = 20;
const MAX_SUCCESS_PATHS = 20;
/** 失败模式示例执行 ID 上限 */
const MAX_EXAMPLE_EXECUTION_IDS = 5;
/** 创建建议中的示例任务描述上限 */
const MAX_EXAMPLE_TASK_DESCRIPTIONS = 5;
/** 一天毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================
// SkillLifecycleManager
// ============================================================

/**
 * Skill 生命周期管理器
 *
 * 职责：
 *   - 监测重复任务，触发 Skill 创建建议
 *   - 维护 Skill 级记忆（执行历史 + 失败模式 + 成功路径）
 *   - 基于失败模式生成 Skill 优化建议（不自动修改）
 *   - 清理过期记忆
 *
 * 不职责：
 *   - 直接执行 Skill（由 AgentLoop 承担）
 *   - 自动修改 Skill 定义（requiresUserApproval 由配置控制）
 */
export class SkillLifecycleManager {
  /** 配置（运行时不可变，需通过构造函数注入） */
  private readonly config: SkillLifecycleConfig;
  /** Skill 记忆表：skillId -> SkillMemory */
  private readonly memories: Map<string, SkillMemory> = new Map();
  /** 执行记录 ID 计数器（用于 exampleExecutionIds） */
  private executionIdCounter = 0;
  /** Phase 53 Task 6：技能安全门控（在 Skill 安装/保存前调用 scan，当前接线点保留待 install 方法接入） */
  private securityGate?: SkillSecurityGate;

  constructor(config: SkillLifecycleConfig) {
    this.config = config;
  }

  /** Phase 53 Task 6：注入技能安全门控 */
  setSecurityGate(gate: SkillSecurityGate): void {
    this.securityGate = gate;
  }

  /**
   * 检测重复任务，触发 Skill 创建建议
   *
   * 算法：
   *   1. 收集未关联 SkillId 的任务（已关联的不重复创建）
   *   2. 按「关键词相似度」聚类（简单实现：normalize 后取关键词集合的 Jaccard 相似度）
   *   3. 任一聚类规模 ≥ creationTriggerThreshold 时返回建议
   *
   * 配置开关 enabled=false 时直接返回 null（陷阱：默认关闭）
   *
   * @param taskHistory 任务历史记录（按时间顺序）
   * @returns 创建建议；无可触发聚类时返回 null
   */
  checkCreationTrigger(taskHistory: TaskRecord[]): SkillCreationSuggestion | null {
    // 配置开关：默认 false
    if (!this.config.enabled) {
      return null;
    }

    // 仅考虑未关联 Skill 的任务
    const unassigned = taskHistory.filter((t) => !t.skillId);
    if (unassigned.length < this.config.creationTriggerThreshold) {
      return null;
    }

    // 聚类：用关键词集合相似度
    const clusters = this.clusterSimilarTasks(unassigned);

    // 找最大聚类
    let bestCluster: TaskRecord[] | null = null;
    for (const cluster of clusters) {
      if (
        cluster.length >= this.config.creationTriggerThreshold &&
        (bestCluster === null || cluster.length > bestCluster.length)
      ) {
        bestCluster = cluster;
      }
    }

    if (bestCluster === null || bestCluster.length === 0) {
      return null;
    }

    // 从聚类中提取代表性关键词作为 Skill 名
    const keywords = this.extractKeywords(bestCluster.map((t) => t.description));
    const suggestedName = keywords.length > 0
      ? keywords.slice(0, 3).join('-')
      : `skill-${Date.now()}`;

    return {
      suggestedName,
      suggestedCategory: 'auto-generated',
      reason: `检测到 ${bestCluster.length} 次相似任务，建议固化为 Skill 以复用`,
      similarTaskCount: bestCluster.length,
      exampleTaskDescriptions: bestCluster
        .slice(-MAX_EXAMPLE_TASK_DESCRIPTIONS)
        .map((t) => t.description),
    };
  }

  /**
   * 记录 Skill 执行
   *
   * 副作用：
   *   - 创建 SkillMemory（如不存在）
   *   - 追加执行记录
   *   - 更新失败模式聚类（失败/部分成功时）
   *   - 更新成功路径（成功时）
   *   - 应用条数上限淘汰
   *
   * @param skillId Skill ID
   * @param record 执行记录
   */
  recordExecution(skillId: string, record: SkillExecutionRecord): void {
    let memory = this.memories.get(skillId);
    if (!memory) {
      memory = {
        skillId,
        executions: [],
        failurePatterns: [],
        successPaths: [],
        lastRefinedAt: 0,
      };
      this.memories.set(skillId, memory);
    }

    // 追加执行记录
    memory.executions.push(record);

    // 按结果分支处理
    if (record.outcome === 'success') {
      // 成功路径：去重后追加，超过上限淘汰最旧的
      const pathKey = record.stepsTaken.join('|');
      if (!memory.successPaths.some((p) => p.join('|') === pathKey)) {
        memory.successPaths.push([...record.stepsTaken]);
        if (memory.successPaths.length > MAX_SUCCESS_PATHS) {
          // 成功路径按「最近使用」排序淘汰——保留最新的
          memory.successPaths.shift();
        }
      }
    } else if (record.outcome === 'partial' || record.outcome === 'failure') {
      // 失败模式：提取 failurePoint 聚类
      if (record.failurePoint) {
        this.upsertFailurePattern(memory, record.failurePoint, record.timestamp);
      }
    }
  }

  /**
   * 从执行历史提取失败模式聚类
   *
   * 算法：直接基于 failurePoint 字段做简单聚合
   * （complex NLP 聚类留给后续 Task，本 Task 先做基础实现）
   *
   * @param skillId Skill ID
   * @returns 失败模式列表（按频率降序）
   */
  extractFailurePatterns(skillId: string): SkillFailurePattern[] {
    const memory = this.memories.get(skillId);
    if (!memory) {
      return [];
    }
    // 返回副本，按频率降序
    return [...memory.failurePatterns].sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * 基于记忆构建 Skill 优化建议（不自动修改）
   *
   * 触发条件：
   *   - 存在 SkillMemory
   *   - 存在至少 1 条失败模式
   *
   * 安全约束：
   *   - autoApplyRefinement=false（默认）时 requiresUserApproval === true
   *   - 即使 autoApplyRefinement=true 也不直接修改 Skill 定义（仅生成提议）
   *
   * @param skillId Skill ID
   * @returns 优化建议；无可优化项时返回 null
   */
  proposeRefinement(skillId: string): SkillRefinementProposal | null {
    const memory = this.memories.get(skillId);
    if (!memory || memory.failurePatterns.length === 0) {
      return null;
    }

    // 取频率最高的失败模式作为主要优化方向
    const topPatterns = [...memory.failurePatterns]
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 3);

    const patternNames = topPatterns.map((p) => p.pattern);
    const totalFailures = memory.failurePatterns.reduce((s, p) => s + p.frequency, 0);
    const successCount = memory.executions.filter((e) => e.outcome === 'success').length;

    const proposedChanges = patternNames
      .map((p) => `针对「${p}」增加预防性步骤或检查点`)
      .join('；');

    return {
      skillId,
      proposedChanges,
      rationale: `近期 ${totalFailures} 次失败中，主要模式：${patternNames.join('、')}；成功 ${successCount} 次`,
      basedOnFailurePatterns: patternNames,
      expectedImprovement: `预计降低 ${patternNames.join('、')} 类失败的发生频率`,
      requiresUserApproval: !this.config.autoApplyRefinement,
    };
  }

  /**
   * 获取 Skill 记忆（只读视图）
   *
   * @param skillId Skill ID
   * @returns 记忆副本；不存在时返回 undefined
   */
  getMemory(skillId: string): SkillMemory | undefined {
    const memory = this.memories.get(skillId);
    if (!memory) {
      return undefined;
    }
    // 返回深拷贝避免外部修改内部状态
    return {
      skillId: memory.skillId,
      executions: memory.executions.map((e) => ({ ...e, stepsTaken: [...e.stepsTaken] })),
      failurePatterns: memory.failurePatterns.map((p) => ({
        ...p,
        exampleExecutionIds: [...p.exampleExecutionIds],
      })),
      successPaths: memory.successPaths.map((p) => [...p]),
      lastRefinedAt: memory.lastRefinedAt,
    };
  }

  /**
   * 清理过期记忆
   *
   * 规则：执行历史中所有记录的 timestamp 都早于 (now - memoryRetentionDays) 时，
   *      整条 SkillMemory 被清理。
   *
   * @param memoryRetentionDays 保留天数（必须 > 0）
   * @returns 清理的 Skill 数量
   */
  cleanupExpiredMemory(memoryRetentionDays: number): number {
    // 陷阱 #171：memoryRetentionDays 必须严格执行
    if (memoryRetentionDays <= 0) {
      return 0;
    }
    const cutoff = Date.now() - memoryRetentionDays * DAY_MS;
    let cleanedCount = 0;

    for (const [skillId, memory] of this.memories.entries()) {
      // 全部记录都过期才清理；只要有近期记录则保留
      const hasRecent = memory.executions.some((e) => e.timestamp >= cutoff);
      if (!hasRecent && memory.executions.length > 0) {
        this.memories.delete(skillId);
        cleanedCount++;
      } else if (memory.executions.length === 0 && memory.lastRefinedAt < cutoff) {
        // 无执行记录且记忆早已过期的也清理
        this.memories.delete(skillId);
        cleanedCount++;
      }
    }

    return cleanedCount;
  }

  // ============================================================
  // 内部辅助方法
  // ============================================================

  /**
   * 简单关键词聚类
   *
   * 算法：
   *   1. 对每个任务描述提取关键词集合
   *   2. 两两计算 Jaccard 相似度
   *   3. 相似度 ≥ 0.5 视为同类，归并到同一聚类
   *
   * 注：本 Task 只做基础实现，复杂的语义聚类留给后续 Task
   */
  private clusterSimilarTasks(tasks: TaskRecord[]): TaskRecord[][] {
    const tokens = tasks.map((t) => this.tokenize(t.description));
    const clusters: TaskRecord[][] = [];
    const assigned = new Set<number>();

    for (let i = 0; i < tasks.length; i++) {
      if (assigned.has(i)) continue;
      const cluster: TaskRecord[] = [tasks[i]];
      assigned.add(i);
      for (let j = i + 1; j < tasks.length; j++) {
        if (assigned.has(j)) continue;
        const sim = this.jaccardSimilarity(tokens[i], tokens[j]);
        if (sim >= 0.5) {
          cluster.push(tasks[j]);
          assigned.add(j);
        }
      }
      clusters.push(cluster);
    }

    return clusters;
  }

  /**
   * 简单分词：按非字母数字字符切分 + 小写化 + 过滤短词
   *
   * 陷阱 #191：中文文本没有空格分隔，按整体字符串切分会把"运行单元测试"当成单个 token，
   * 导致 Jaccard 相似度计算失败（两个高度相似的任务被判为不相似）。
   * 修复：对 CJK 字符串按单字拆分，每个汉字作为独立 token；ASCII 部分保留完整单词。
   */
  private tokenize(text: string): Set<string> {
    const tokens: string[] = [];
    const parts = text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/i);
    for (const part of parts) {
      if (!part) continue;
      const hasCjk = /[\u4e00-\u9fa5]/.test(part);
      if (hasCjk) {
        // CJK 字符串：按单字拆分（中文无空格分隔，单字 token 更合理）
        for (const ch of part) {
          if (/[\u4e00-\u9fa5]/.test(ch)) {
            tokens.push(ch);
          } else if (/[a-z0-9]/.test(ch) && part.length >= 2) {
            // CJK 字符串中夹杂的 ASCII——保留完整 part 一次即可
            tokens.push(part);
            break;
          }
        }
      } else {
        // 纯 ASCII：保留完整单词，过滤单字符噪声
        if (part.length >= 2) {
          tokens.push(part);
        }
      }
    }
    return new Set(tokens);
  }

  /** Jaccard 相似度 */
  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const x of a) {
      if (b.has(x)) intersection++;
    }
    return intersection / (a.size + b.size - intersection);
  }

  /** 从任务描述列表中提取代表性关键词（按出现频率降序） */
  private extractKeywords(descriptions: string[]): string[] {
    const freq = new Map<string, number>();
    for (const d of descriptions) {
      for (const tok of this.tokenize(d)) {
        freq.set(tok, (freq.get(tok) ?? 0) + 1);
      }
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([w]) => w);
  }

  /** 插入或更新失败模式（陷阱 #171：超出 20 条时按频率淘汰低频项） */
  private upsertFailurePattern(
    memory: SkillMemory,
    pattern: string,
    timestamp: number,
  ): void {
    const existing = memory.failurePatterns.find((p) => p.pattern === pattern);
    if (existing) {
      existing.frequency++;
      existing.lastSeenAt = timestamp;
      // 追加示例执行 ID（用计数器生成）
      const execId = `exec-${++this.executionIdCounter}`;
      if (existing.exampleExecutionIds.length < MAX_EXAMPLE_EXECUTION_IDS) {
        existing.exampleExecutionIds.push(execId);
      } else {
        // 满了则替换最旧的
        existing.exampleExecutionIds.shift();
        existing.exampleExecutionIds.push(execId);
      }
      return;
    }

    // 新增
    const execId = `exec-${++this.executionIdCounter}`;
    memory.failurePatterns.push({
      pattern,
      frequency: 1,
      lastSeenAt: timestamp,
      exampleExecutionIds: [execId],
    });

    // 陷阱 #171：超出 20 条时按频率淘汰最低频项
    if (memory.failurePatterns.length > MAX_FAILURE_PATTERNS) {
      // 找频率最低且最久未出现的，移除
      let minIdx = 0;
      for (let i = 1; i < memory.failurePatterns.length; i++) {
        const cur = memory.failurePatterns[i];
        const min = memory.failurePatterns[minIdx];
        if (
          cur.frequency < min.frequency ||
          (cur.frequency === min.frequency && cur.lastSeenAt < min.lastSeenAt)
        ) {
          minIdx = i;
        }
      }
      memory.failurePatterns.splice(minIdx, 1);
    }
  }
}
