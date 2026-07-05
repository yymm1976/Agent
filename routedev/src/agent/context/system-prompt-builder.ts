// src/agent/context/system-prompt-builder.ts
// Phase 71 Task D1：统一 system prompt 静态拼装
// 把分散在 chat-runner / loop 等处的静态字符串拼接收敛到一个 builder
// 注：运行时中间件（middleware onSystemPrompt、systemBlocks 动态追加）不纳入此 builder，
//     由 loop.ts 在运行时处理
//
// Phase 72 Task C3：检测代码任务时注入 LAZY_CODER_LADDER 到 task 分区
//
// Phase 72 Task B1：CacheAligner 前缀稳定化（headroom 借鉴）
//   把 system prompt 中的动态部分（日期/UUID/session token/工作目录/route_decision/用户偏好）
//   抽到尾部，让前缀字节稳定，使 Anthropic cache_control / OpenAI prefix cache 真正命中。
//   静态前缀顺序：basePrompt → projectRules → projectMemory → contextDiscipline → skillSuffix
//   动态尾部顺序：taskLadder（依赖 userMessage）→ userPreferences（含时间戳）→ dynamicContext（date/cwd/sessionId/routeDecision）

import { LAZY_CODER_LADDER, isCodeTask } from './lazy-coder-ladder.js';

export interface SystemPromptParts {
  /** 基础 prompt（PromptTemplateManager.render('main.system') 或 systemPromptRef.current） */
  basePrompt: string;
  /** Skill 路由匹配后追加的内容（chat-runner.ts 的 skillPromptSuffix） */
  skillSuffix?: string;
  /** 项目规则（AGENTS.md / CLAUDE.md，如已加载到 basePrompt 则留空） */
  projectRules?: string;
  /** 项目记忆（MEMORY.md / decisions.log，如已加载到 basePrompt 则留空） */
  projectMemory?: string;
  /** 用户偏好（user_profile.md，Task D2 接入）—— 含时间戳，归入动态尾部 */
  userPreferences?: string;
  /** 上下文工程纪律片段（Phase 71 Task E3，引导 plan/vfs/@-mention/offload） */
  contextDiscipline?: string;
  /**
   * Phase 72 Task C3：用户最新消息（用于检测是否为代码任务）
   * 若判定为代码任务，自动注入 LAZY_CODER_LADDER 到 task 分区
   * 不传或为空字符串则不注入
   */
  userMessage?: string;
  /**
   * Phase 72 Task B1：动态上下文（每轮变化的部分），归入尾部
   * 这些字段每轮都可能不同，放在 prompt 末尾以稳定前缀字节
   */
  dynamicContext?: DynamicContext;
}

/**
 * Phase 72 Task B1：动态上下文字段
 * 这些字段每轮都可能变化，统一放在 prompt 尾部以保持前缀稳定
 */
export interface DynamicContext {
  /** 当前日期（如 '2026-07-05'） */
  date?: string;
  /** 当前工作目录 */
  cwd?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 路由决策（每轮不同的模型路由信息） */
  routeDecision?: string;
  /** 其它运行时动态信息（自由文本） */
  runtime?: string;
}

/**
 * 把 DynamicContext 渲染为尾部段落
 * 仅渲染非空字段，每段加【动态上下文】总标题
 */
function renderDynamicTail(ctx: DynamicContext): string {
  const lines: string[] = [];
  if (ctx.date) lines.push(`- 当前日期：${ctx.date}`);
  if (ctx.cwd) lines.push(`- 工作目录：${ctx.cwd}`);
  if (ctx.sessionId) lines.push(`- 会话 ID：${ctx.sessionId}`);
  if (ctx.routeDecision) lines.push(`- 路由决策：${ctx.routeDecision}`);
  if (ctx.runtime) lines.push(`- 运行时：${ctx.runtime}`);
  if (lines.length === 0) return '';
  return `【动态上下文】\n${lines.join('\n')}`;
}

/**
 * 统一拼装 system prompt
 *
 * Phase 72 Task B1 重排后顺序（前缀稳定化）：
 *   [静态前缀]
 *   1. basePrompt（基础 prompt，必填，不含日期/cwd/session_id 等动态信息）
 *   2. projectRules（项目规则）
 *   3. projectMemory（项目记忆）
 *   4. contextDiscipline（上下文工程纪律）
 *   5. skillSuffix（已激活的 Skill 内容，按 Skill 路由匹配；同一会话内相对稳定）
 *   [动态尾部] —— cache_control 边界，前缀字节稳定
 *   6. taskLadder（代码任务时注入 5 级决策阶梯，依赖 userMessage）
 *   7. userPreferences（用户偏好，含时间戳）
 *   8. dynamicContext（date / cwd / sessionId / routeDecision，每轮可能变化）
 *
 * 各部分用双换行分隔，每部分（除 basePrompt / skillSuffix）有【】标题前缀
 */
export function buildSystemPrompt(parts: SystemPromptParts): string {
  // ===== 静态前缀 =====
  const staticSections: string[] = [parts.basePrompt];
  if (parts.projectRules) staticSections.push(`【项目规则】\n${parts.projectRules}`);
  if (parts.projectMemory) staticSections.push(`【项目记忆】\n${parts.projectMemory}`);
  // Phase 71 Task E3：上下文工程纪律，拼在 skillSuffix 之前
  if (parts.contextDiscipline) staticSections.push(`【上下文工程纪律】\n${parts.contextDiscipline}`);
  if (parts.skillSuffix) staticSections.push(parts.skillSuffix);

  // ===== 动态尾部 =====
  // 注：把依赖 userMessage / 含时间戳 / 每轮变化的字段统一放在尾部，
  //     使 Anthropic cache_control / OpenAI prefix cache 命中前缀字节
  const dynamicSections: string[] = [];
  // Phase 72 Task C3：代码任务时注入 5 级决策阶梯到 task 分区（依赖 userMessage，归入尾部）
  if (parts.userMessage && isCodeTask(parts.userMessage)) {
    dynamicSections.push(`【任务纪律·代码决策阶梯】\n${LAZY_CODER_LADDER}`);
  }
  // userPreferences 含时间戳，归入动态尾部
  if (parts.userPreferences) dynamicSections.push(`【用户偏好】\n${parts.userPreferences}`);
  // Phase 72 Task B1：动态上下文字段（date/cwd/sessionId/routeDecision）
  if (parts.dynamicContext) {
    const tail = renderDynamicTail(parts.dynamicContext);
    if (tail) dynamicSections.push(tail);
  }

  return [...staticSections, ...dynamicSections].join('\n\n');
}
