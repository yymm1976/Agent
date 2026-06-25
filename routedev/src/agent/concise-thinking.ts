// src/agent/concise-thinking.ts
// Phase 30 Task 4：简洁思考约束（实验性）
//
// 核心哲学："AI 回答应该像电报，不是作文"——给 AI 戴上字数紧箍咒
// 三个能力：
//   1. 系统提示词注入"输出纪律"段落（CONCISE_THINKING_BLOCK）
//   2. 工具返回裁剪（trimToolResult，> 2000 字符时 800 首 + 标记 + 800 尾）
//   3. 用户关键词检测（shouldSkipConcise，临时跳过本轮约束）
//
// 设计要点：
//   1. 纯函数模块，不依赖外部服务，零副作用
//   2. 配置开关 optimization.conciseThinking.enabled 默认 false（实验性）
//   3. 用户明确请求"详细/完整"时，临时跳过约束（安全降级）
//   4. 与 ContextCompactor L1 不冲突：本模块仅在 conciseThinking 启用时生效，
//      L1 始终生效；上层集成时取两者较小裁剪结果（不重复裁剪）

// ============================================================
// 常量定义
// ============================================================

/**
 * 输出纪律段落
 *
 * 当 optimization.conciseThinking.enabled 为 true 时注入系统提示词
 * 借鉴 Claude Code 的"极简输出纪律"模式
 */
export const CONCISE_THINKING_BLOCK = `## 输出纪律
- 直接给出结论和操作，省略"好的"、"让我来"、"综上所述"等过渡语
- 代码修改直接展示 diff 或代码块，不要先描述"我打算..."再展示
- 工具调用结果正确时，用一句话确认即可，不要复述工具返回的内容
- 思考过程（如果有）控制在 5 个要点以内
- 如果用户问"怎么做"，给步骤；如果问"是什么"，给定义；如果问"为什么"，给原因。不要三种都给。`;

/** 工具返回裁剪阈值（字符数） */
const TRIM_THRESHOLD = 2000;

/** 裁剪后保留的首部字符数 */
const TRIM_HEAD = 800;

/** 裁剪后保留的尾部字符数 */
const TRIM_TAIL = 800;

/**
 * 触发"临时跳过约束"的关键词列表
 *
 * 用户消息中包含任一关键词时，本轮不应用简洁思考约束
 * 包含中英文关键词，覆盖"请详细解释"、"展示完整结果"等场景
 */
const SKIP_KEYWORDS: readonly string[] = [
  '详细',
  '完整',
  '展示完整',
  '全部',
  'explain in detail',
];

// ============================================================
// 核心函数
// ============================================================

/**
 * 裁剪工具返回结果
 *
 * 当 enabled 且 toolResult.length > 2000 时：
 *   保留 800 字符首部 + 裁剪标记 + 800 字符尾部
 *   裁剪标记格式：[...已裁剪 N 字符，如需完整内容请说"展示完整结果"...]
 *   其中 N = toolResult.length - 1600（被裁掉的字符数）
 *
 * 与 ContextCompactor L1（500 首 + 500 尾）相比更激进（800 首 + 800 尾），
 * 但仅在 conciseThinking 启用时生效；上层集成时取两者较小裁剪结果
 *
 * @param toolResult 原始工具返回字符串
 * @param enabled 是否启用简洁思考约束
 * @returns 裁剪后的字符串（未启用或未超阈值时原样返回）
 */
export function trimToolResult(toolResult: string, enabled: boolean): string {
  // 未启用简洁思考约束时，原样返回
  if (!enabled) {
    return toolResult;
  }

  // 未超过阈值时，原样返回
  if (toolResult.length <= TRIM_THRESHOLD) {
    return toolResult;
  }

  // 超过阈值：保留 800 首 + 标记 + 800 尾
  const trimmedCount = toolResult.length - (TRIM_HEAD + TRIM_TAIL);
  const marker =
    '\n\n[...已裁剪 ' +
    trimmedCount +
    ' 字符，如需完整内容请说"展示完整结果"...]\n\n';

  return (
    toolResult.substring(0, TRIM_HEAD) +
    marker +
    toolResult.substring(toolResult.length - TRIM_TAIL)
  );
}

/**
 * 检测用户是否请求详细输出（临时跳过简洁约束）
 *
 * 当用户消息中包含"详细"、"完整"、"展示完整"、"全部"、"explain in detail"
 * 等关键词时，返回 true——本轮不应用简洁思考约束
 *
 * 检测采用大小写不敏感的子串匹配（中文不区分大小写，英文统一转小写比较）
 *
 * @param userMessage 用户当前消息文本
 * @returns true 表示用户请求详细输出，应跳过本轮约束
 */
export function shouldSkipConcise(userMessage: string): boolean {
  // 空消息不触发跳过
  if (!userMessage) {
    return false;
  }

  // 统一转小写进行英文关键词匹配（中文关键词不受影响）
  const lowerMessage = userMessage.toLowerCase();

  return SKIP_KEYWORDS.some((keyword) => {
    const lowerKeyword = keyword.toLowerCase();
    return lowerMessage.includes(lowerKeyword);
  });
}
