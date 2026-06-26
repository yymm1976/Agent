// src/skills/skill-metadata-extension.ts
// SkillMetadata 扩展接口（Phase 49 Task 3.6 — 模型漂移检测用）
//
// 设计目标（蓝图 3.6 节）：
//   - 不修改 skill-md-parser.ts 的现有接口（避免破坏既有代码）
//   - 通过扩展接口添加可选字段 lastValidatedModel
//   - ModelDriftDetector 使用此扩展接口访问 lastValidatedModel
//
// 知识库原文（主题-AI独立创业 延伸阅读）：
//   "模型升级后，原有 prompt 可能失效，需要持续维护。"
//   记录每个 Skill 上次通过质量门时的模型版本，启动时比对当前模型版本。

import type { SkillMetadata, ParsedSkill } from './skill-md-parser.js';

/**
 * 扩展 SkillMetadata，添加模型漂移检测相关字段
 *
 * 由于 SkillMetadataWithDrift 仅在 SkillMetadata 基础上新增可选字段，
 * 任何 SkillMetadata 类型的对象都可以安全地视为 SkillMetadataWithDrift
 * （lastValidatedModel 为 undefined）。
 */
export interface SkillMetadataWithDrift extends SkillMetadata {
  /** 上次通过质量门时的模型版本（用于漂移检测；未校验过则为 undefined） */
  lastValidatedModel?: string;
}

/**
 * 带 drift 字段的 ParsedSkill
 *
 * 与 ParsedSkill 结构一致，仅把 metadata 类型替换为扩展接口。
 * 用于 ModelDriftDetector 的入参类型。
 */
export interface ParsedSkillWithDrift {
  metadata: SkillMetadataWithDrift;
  content: string;
  format: 'skill-md' | 'json' | 'yaml';
}
