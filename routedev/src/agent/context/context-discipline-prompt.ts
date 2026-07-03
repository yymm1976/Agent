// src/agent/context/context-discipline-prompt.ts
// Phase 71 Task E3：上下文工程纪律 prompt 片段
// 借鉴 deepagents 的 prompt 工程思路，引导 Agent 正确使用 plan/vfs/@-mention/offload 等机制，
// 避免上下文被无序占用或重复 system prompt 中已声明的规则

export interface ContextDisciplineOptions {
  /** 是否包含 plan 工具引导段，默认 true */
  includePlan?: boolean;
  /** 是否包含 vfs 工具引导段，默认 true */
  includeVFS?: boolean;
  /** 是否包含 @-mention 引导段，默认 true */
  includeMention?: boolean;
  /** 是否包含 offload 引导段，默认 true */
  includeOffload?: boolean;
  /** 是否包含禁止复读规则段，默认 true */
  includeNoRepeat?: boolean;
}

/**
 * 构造"上下文工程纪律" prompt 片段
 *
 * 引导 Agent 正确使用 plan / vfs / @-mention / offload 等机制，
 * 避免上下文被无序占用或重复 system prompt 已声明的规则。
 *
 * 返回的片段不含外层标题，由 system-prompt-builder.ts 的 contextDiscipline 字段统一加【上下文工程纪律】标题。
 */
export function buildContextDisciplinePrompt(options: ContextDisciplineOptions = {}): string {
  const {
    includePlan = true,
    includeVFS = true,
    includeMention = true,
    includeOffload = true,
    includeNoRepeat = true,
  } = options;

  const lines: string[] = [];

  if (includePlan) {
    lines.push('- 任务计划：用 plan_get / plan_set 维护任务计划与进度，不要把计划散落在对话消息中。');
  }
  if (includeVFS) {
    lines.push('- 工作笔记：长文本（>10 行）用 vfs_write / vfs_read 写入虚拟文件系统，按需读取，避免占用对话上下文。');
  }
  if (includeMention) {
    lines.push('- @路径：用户消息中的 @路径 会被自动解析为绝对路径，可直接作为工具参数使用，不要自行猜测。');
  }
  if (includeOffload) {
    lines.push('- 自动 offload：工具输出超过 token 预算时会自动转存到文件，原始结果可用 file_read 读取完整内容。');
  }
  if (includeNoRepeat) {
    lines.push('- 禁止复读：不要在对话中重复 system prompt 已声明的规则，只在工具调用与回复中体现。');
  }

  return lines.join('\n');
}
