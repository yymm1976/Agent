// src/skills/model-drift-detector.ts
// 模型漂移检测器（Phase 49 Task 3.6）
//
// 知识库原文（主题-AI独立创业 延伸阅读）：
//   "模型升级后，原有 prompt 可能失效，需要持续维护。"
//
// 实现：
//   - 比对 skill.metadata.lastValidatedModel 与 currentModelVersion
//   - 不一致 → 标记 Skill 为"待重新校验"
//   - 严重度：同主版本=low，跨主版本=high
//   - low 严重度只记录日志，high 严重度弹窗提示用户（陷阱 #154）
//
// 与在线监控（Task 5）的关系：
//   - 模型漂移检测是"一次性校验"（启动时发现版本变更）
//   - 在线监控的"漂移信号"是"运行时统计"（运行中发现行为分布变化）
//   - 两者互补

import type { ParsedSkill } from './skill-md-parser.js';
import type { SkillMetadataWithDrift } from './skill-metadata-extension.js';

/** 单个 Skill 的漂移检测结果 */
export interface DriftResult {
  /** Skill 名称 */
  skillName: string;
  /** 上次校验时的模型版本（未校验过则为 'unknown'） */
  lastValidatedModel: string;
  /** 当前模型版本 */
  currentModelVersion: string;
  /** 漂移严重度：low（同主版本）/ high（跨主版本或未校验过） */
  severity: 'low' | 'high';
}

/**
 * 模型漂移检测器——检测模型升级后需要重新校验的 Skill
 *
 * 用法：
 *   const detector = new ModelDriftDetector();
 *   const drifts = detector.detectDrift(installedSkills, 'gpt-4-1106');
 *   for (const d of drifts) {
 *     if (d.severity === 'high') {
 *       // 弹窗提示用户重新校验
 *     } else {
 *       // low 严重度只记录日志
 *     }
 *   }
 */
export class ModelDriftDetector {
  /**
   * 检测模型漂移
   *
   * @param installedSkills 已安装的 Skill 列表
   * @param currentModelVersion 当前使用的模型版本
   * @returns 需要重新校验的 Skill 列表（已过滤掉版本匹配的 Skill）
   */
  detectDrift(
    installedSkills: ParsedSkill[],
    currentModelVersion: string,
  ): DriftResult[] {
    return installedSkills
      .filter((s) => {
        // 把 metadata 视为带 drift 字段的扩展接口
        // 由于 SkillMetadataWithDrift 仅在 SkillMetadata 上新增可选字段，
        // 此处的类型断言是安全的
        const meta = s.metadata as SkillMetadataWithDrift;
        return meta.lastValidatedModel !== currentModelVersion;
      })
      .map((s) => {
        const meta = s.metadata as SkillMetadataWithDrift;
        return {
          skillName: s.metadata.name,
          lastValidatedModel: meta.lastValidatedModel ?? 'unknown',
          currentModelVersion,
          severity: this.assessDriftSeverity(meta.lastValidatedModel, currentModelVersion),
        };
      });
  }

  /**
   * 评估漂移严重度
   *
   * 规则（蓝图 3.6 节 + 陷阱 #154）：
   *   - 未记录 lastValidatedModel（从未校验过）→ high
   *   - 同主版本升级（如 4.0613 → 4.1106）→ low（只记录日志）
   *   - 跨主版本升级（如 3.5 → 4.0）→ high（弹窗提示用户）
   *
   * @param oldVer 上次校验时的模型版本（undefined 表示从未校验）
   * @param newVer 当前模型版本
   */
  private assessDriftSeverity(
    oldVer: string | undefined,
    _newVer: string,
  ): 'low' | 'high' {
    if (!oldVer) return 'high';
    // 同主版本 = low；跨主版本 = high
    const oldMajor = oldVer.split('.')[0];
    const newMajor = _newVer.split('.')[0];
    return oldMajor === newMajor ? 'low' : 'high';
  }
}
