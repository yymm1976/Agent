// src/agent/context/system-prompt-builder.ts
// Phase 71 Task D1：统一 system prompt 静态拼装
// 把分散在 chat-runner / loop 等处的静态字符串拼接收敛到一个 builder
// 注：运行时中间件（middleware onSystemPrompt、systemBlocks 动态追加）不纳入此 builder，
//     由 loop.ts 在运行时处理

export interface SystemPromptParts {
  /** 基础 prompt（PromptTemplateManager.render('main.system') 或 systemPromptRef.current） */
  basePrompt: string;
  /** Skill 路由匹配后追加的内容（chat-runner.ts 的 skillPromptSuffix） */
  skillSuffix?: string;
  /** 项目规则（AGENTS.md / CLAUDE.md，如已加载到 basePrompt 则留空） */
  projectRules?: string;
  /** 项目记忆（MEMORY.md / decisions.log，如已加载到 basePrompt 则留空） */
  projectMemory?: string;
  /** 用户偏好（user_profile.md，Task D2 接入） */
  userPreferences?: string;
  /** 上下文工程纪律片段（Phase 71 Task E3，引导 plan/vfs/@-mention/offload） */
  contextDiscipline?: string;
}

/**
 * 统一拼装 system prompt
 *
 * 拼装顺序（每个部分可选，为空则跳过）：
 * 1. basePrompt（基础 prompt，必填）
 * 2. projectRules（项目规则）
 * 3. projectMemory（项目记忆）
 * 4. userPreferences（用户偏好）
 * 5. contextDiscipline（上下文工程纪律，Phase 71 Task E3）
 * 6. skillSuffix（已激活的 Skill）
 *
 * 各部分用双换行分隔，每部分（除 basePrompt）有【】标题前缀
 */
export function buildSystemPrompt(parts: SystemPromptParts): string {
  const sections: string[] = [parts.basePrompt];
  if (parts.projectRules) sections.push(`【项目规则】\n${parts.projectRules}`);
  if (parts.projectMemory) sections.push(`【项目记忆】\n${parts.projectMemory}`);
  if (parts.userPreferences) sections.push(`【用户偏好】\n${parts.userPreferences}`);
  // Phase 71 Task E3：上下文工程纪律，拼在 skillSuffix 之前
  if (parts.contextDiscipline) sections.push(`【上下文工程纪律】\n${parts.contextDiscipline}`);
  if (parts.skillSuffix) sections.push(parts.skillSuffix);
  return sections.join('\n\n');
}
