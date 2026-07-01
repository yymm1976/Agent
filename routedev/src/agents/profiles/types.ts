// src/agents/profiles/types.ts
// Agent Profile 类型定义
//
// 设计目标：
//   1. 定义子 Agent 的角色配置（researcher / executor / reviewer / custom）
//   2. 描述工具白名单、质疑权限、输出格式等契约字段
//   3. 与 SKILL.md 格式兼容（type = 'agent-profile'）
//
// 一个 AgentProfile 即一份"委托契约"：父 Agent 派发任务时，
// 子 Agent 必须严格遵循 profile 中声明的工具范围、输出格式与权限边界。

// ============================================================
// 角色与枚举
// ============================================================

/** 子 Agent 角色 */
export type AgentRole = 'researcher' | 'executor' | 'reviewer' | 'custom';

/** 输出格式 */
type AgentOutputFormat =
  | 'research_report'
  | 'code_change'
  | 'review_report'
  | 'custom';

/** 质疑严重级别 */
type ChallengeSeverity = 'blocking' | 'warning';

// ============================================================
// AgentProfile
// ============================================================

/**
 * Agent Profile：描述一类子 Agent 的能力边界与行为契约
 *
 * 字段语义：
 *   - allowedTools / forbiddenTools：工具白名单/黑名单（白名单优先）
 *   - canChallenge：子 Agent 是否可对父 Agent 的指令提出质疑
 *   - challengeSeverity：质疑级别（blocking 会暂停流水线，warning 仅记录）
 *   - boundSkills：绑定的 Skill id 列表（子 Agent 启动时自动加载）
 *   - maxTokens / maxSteps：硬性预算上限，超过即终止
 *   - isBuiltin：内置模板不可删除，只能复制或重置
 */
export interface AgentProfile {
  /** 唯一 id（kebab-case） */
  id: string;
  /** 展示名 */
  name: string;
  /** 固定为 'agent-profile'，用于与普通 Skill 区分 */
  type: 'agent-profile';
  /** 语义化版本号 */
  version: string;
  /** 角色 */
  role: AgentRole;
  /** 模型 id（'default' 表示走路由器默认选择） */
  modelId: string;
  /** 一句话描述 */
  description: string;
  /** 系统提示词 */
  systemPrompt: string;
  /** 允许使用的工具白名单 */
  allowedTools: string[];
  /** 明确禁止使用的工具（即使白名单包含也优先禁止） */
  forbiddenTools: string[];
  /** 是否允许质疑父 Agent */
  canChallenge: boolean;
  /** 质疑级别 */
  challengeSeverity: ChallengeSeverity;
  /** 输出格式 */
  outputFormat: AgentOutputFormat;
  /** 绑定的 Skill id 列表 */
  boundSkills: string[];
  /** Token 预算上限 */
  maxTokens: number;
  /** 最大步数 */
  maxSteps: number;
  /** 是否为内置模板 */
  isBuiltin: boolean;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 更新时间戳（ms） */
  updatedAt: number;
}

// ============================================================
// 校验
// ============================================================

/** 校验错误项 */
export interface AgentProfileValidationError {
  /** 出错字段名 */
  field: string;
  /** 错误描述 */
  message: string;
}

/**
 * 校验 AgentProfile 合法性
 *
 * 规则：
 *   - id / name / modelId / systemPrompt 非空
 *   - type 必须为 'agent-profile'
 *   - maxTokens > 0
 *   - maxSteps > 0
 *   - role / outputFormat / challengeSeverity 取值合法
 */
export function validateProfile(profile: AgentProfile): AgentProfileValidationError[] {
  const errors: AgentProfileValidationError[] = [];

  if (!profile.id || profile.id.trim().length === 0) {
    errors.push({ field: 'id', message: 'id must not be empty' });
  }
  if (!profile.name || profile.name.trim().length === 0) {
    errors.push({ field: 'name', message: 'name must not be empty' });
  }
  if (profile.type !== 'agent-profile') {
    errors.push({ field: 'type', message: "type must be 'agent-profile'" });
  }
  if (!profile.version || profile.version.trim().length === 0) {
    errors.push({ field: 'version', message: 'version must not be empty' });
  }
  const validRoles: AgentRole[] = ['researcher', 'executor', 'reviewer', 'custom'];
  if (!validRoles.includes(profile.role)) {
    errors.push({ field: 'role', message: `role must be one of: ${validRoles.join(', ')}` });
  }
  if (!profile.modelId || profile.modelId.trim().length === 0) {
    errors.push({ field: 'modelId', message: 'modelId must not be empty' });
  }
  if (!profile.description || profile.description.trim().length === 0) {
    errors.push({ field: 'description', message: 'description must not be empty' });
  }
  if (!profile.systemPrompt || profile.systemPrompt.trim().length === 0) {
    errors.push({ field: 'systemPrompt', message: 'systemPrompt must not be empty' });
  }
  const validOutputFormats: AgentOutputFormat[] = [
    'research_report',
    'code_change',
    'review_report',
    'custom',
  ];
  if (!validOutputFormats.includes(profile.outputFormat)) {
    errors.push({
      field: 'outputFormat',
      message: `outputFormat must be one of: ${validOutputFormats.join(', ')}`,
    });
  }
  const validSeverities: ChallengeSeverity[] = ['blocking', 'warning'];
  if (!validSeverities.includes(profile.challengeSeverity)) {
    errors.push({
      field: 'challengeSeverity',
      message: `challengeSeverity must be one of: ${validSeverities.join(', ')}`,
    });
  }
  if (!Array.isArray(profile.allowedTools)) {
    errors.push({ field: 'allowedTools', message: 'allowedTools must be an array' });
  }
  if (!Array.isArray(profile.forbiddenTools)) {
    errors.push({ field: 'forbiddenTools', message: 'forbiddenTools must be an array' });
  }
  if (!Array.isArray(profile.boundSkills)) {
    errors.push({ field: 'boundSkills', message: 'boundSkills must be an array' });
  }
  if (typeof profile.maxTokens !== 'number' || profile.maxTokens <= 0) {
    errors.push({ field: 'maxTokens', message: 'maxTokens must be a positive number' });
  }
  if (typeof profile.maxSteps !== 'number' || profile.maxSteps <= 0) {
    errors.push({ field: 'maxSteps', message: 'maxSteps must be a positive number' });
  }
  if (typeof profile.isBuiltin !== 'boolean') {
    errors.push({ field: 'isBuiltin', message: 'isBuiltin must be a boolean' });
  }
  if (typeof profile.createdAt !== 'number' || profile.createdAt < 0) {
    errors.push({ field: 'createdAt', message: 'createdAt must be a non-negative number' });
  }
  if (typeof profile.updatedAt !== 'number' || profile.updatedAt < 0) {
    errors.push({ field: 'updatedAt', message: 'updatedAt must be a non-negative number' });
  }

  return errors;
}
