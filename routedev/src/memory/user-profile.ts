// src/memory/user-profile.ts
// Phase 97 Part I：轻量用户档案（UserProfile）
//
// 设计目的（借鉴 Proma：不做宽泛 RAG 记忆）：
//   只用几百字的用户档案 schema（职业/当前工作/水平/交互偏好/必记信息）拼进系统提示词，
//   靠模型推理能力起效，而非依赖模糊的关联搜索。
//
// 约束：
//   - 总量控制在几百字内（字段 + 渲染有截断保护）
//   - 空档案安全降级：渲染为空字符串，不报错

/** 用户档案字段（全部可选，空档案安全降级） */
export interface UserProfile {
  /** 职业/角色（如"前端工程师"） */
  occupation?: string;
  /** 最近在做的事（如"重构订单模块"） */
  currentWork?: string;
  /** 技术/领域水平（如"熟悉 TypeScript，NeoForge 新手"） */
  skillLevel?: string;
  /** 交互偏好（如"代码注释用中文""回复简洁"） */
  interactionPrefs?: string;
  /** 必记信息（如"不要用 emoji""验证用 pnpm test"） */
  mustRemember?: string[];
}

/** 渲染档案的文本长度上限（控制在几百字内） */
const MAX_PROFILE_TEXT_LENGTH = 600;

/**
 * 渲染 UserProfile 为系统提示词片段
 * 空档案或全空字段时返回空字符串（安全降级，不报错）
 */
export function renderUserProfile(profile: UserProfile | null | undefined): string {
  if (!profile) return '';
  const lines: string[] = [];

  if (profile.occupation) lines.push(`职业：${profile.occupation}`);
  if (profile.currentWork) lines.push(`最近在做：${profile.currentWork}`);
  if (profile.skillLevel) lines.push(`水平：${profile.skillLevel}`);
  if (profile.interactionPrefs) lines.push(`交互偏好：${profile.interactionPrefs}`);
  if (Array.isArray(profile.mustRemember) && profile.mustRemember.length > 0) {
    lines.push(`必记信息：${profile.mustRemember.join('；')}`);
  }

  if (lines.length === 0) return '';
  const body = `【用户档案】\n${lines.join('\n')}`;
  // 截断保护：超长时丢弃尾部（保持档案轻量）
  return body.length > MAX_PROFILE_TEXT_LENGTH
    ? `${body.slice(0, MAX_PROFILE_TEXT_LENGTH)}…`
    : body;
}

/** 校验用户档案合法性（供配置层调用；返回错误信息数组，空数组=通过） */
export function validateUserProfile(profile: unknown): string[] {
  if (profile === null || profile === undefined) return [];
  if (typeof profile !== 'object') return ['userProfile 必须是对象'];
  const errors: string[] = [];
  const p = profile as Record<string, unknown>;
  for (const key of ['occupation', 'currentWork', 'skillLevel', 'interactionPrefs']) {
    const v = p[key];
    if (v !== undefined && typeof v !== 'string') {
      errors.push(`userProfile.${key} 必须是字符串`);
    }
  }
  if (p.mustRemember !== undefined) {
    if (!Array.isArray(p.mustRemember) || !p.mustRemember.every((item) => typeof item === 'string')) {
      errors.push('userProfile.mustRemember 必须是字符串数组');
    }
  }
  return errors;
}
