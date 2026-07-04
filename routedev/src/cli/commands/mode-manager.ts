// src/cli/commands/mode-manager.ts
// Agent 模式管理器：对齐 Aider 的 architect / code / ask 三模式
//
// 设计：
//   - 进程内存级别（不持久化，重启清空）
//   - 单例导出，/architect /code /ask 命令与工具过滤器共用
//   - code：默认模式，全部工具可用
//   - architect：强模型规划 + 弱模型执行，工具全开但 system prompt 不同
//   - ask：只问答不修改文件，禁用所有写工具
//
// 工具过滤策略：
//   - code / architect：全部工具可用（architect 仅 system prompt 不同）
//   - ask：只允许只读工具（file_read / file_search / code_search / code_graph_query / repo_map）

/** Agent 模式类型 */
export type AgentMode = 'code' | 'architect' | 'ask';

/** 模式对应的工具过滤配置 */
export interface ToolFilter {
  /** 允许使用的工具名（白名单），为空表示全部允许 */
  allowed: string[];
  /** 禁止使用的工具名（黑名单） */
  blocked: string[];
}

/** Architect 模式追加到 system prompt 的指令 */
export const ARCHITECT_SYSTEM_PROMPT_ADDENDUM = `你是架构师。先规划再编码：
1. 分析需求，列出涉及的模块与改动点
2. 输出明确的实施计划（步骤、文件、风险）
3. 等待用户确认计划后，再执行编码操作
4. 编码阶段使用 file_edit / file_write 等工具落地`;

/** Ask 模式追加到 system prompt 的指令 */
export const ASK_SYSTEM_PROMPT_ADDENDUM = `你处于"只读问答"模式：
- 只回答用户问题，不修改任何文件
- 不得调用 file_edit / file_write / shell_exec 等写工具
- 可使用 file_read / file_search / code_search / code_graph_query / repo_map 等只读工具查阅代码
- 回答完本问题后会自动恢复原模式`;

/** 只读工具白名单（ask 模式下仅这些工具可用） */
export const READONLY_TOOLS = [
  'file_read',
  'file_search',
  'code_search',
  'code_graph_query',
  'repo_map',
  'list_directory',
  'web_fetch',
] as const;

/** 写工具黑名单（ask 模式下禁用） */
export const WRITE_TOOLS = [
  'file_edit',
  'file_write',
  'shell_exec',
  'shell',
  'vfs_write',
  'vfs_delete',
] as const;

/** 各模式对应的工具过滤配置 */
const MODE_TOOL_FILTERS: Record<AgentMode, ToolFilter> = {
  code: { allowed: [], blocked: [] },
  architect: { allowed: [], blocked: [] },
  ask: { allowed: [...READONLY_TOOLS], blocked: [...WRITE_TOOLS] },
};

/** 各模式对应的 system prompt 追加指令 */
const MODE_PROMPT_ADDENDUM: Record<AgentMode, string> = {
  code: '',
  architect: ARCHITECT_SYSTEM_PROMPT_ADDENDUM,
  ask: ASK_SYSTEM_PROMPT_ADDENDUM,
};

export class ModeManager {
  private currentMode: AgentMode = 'code';
  private previousMode: AgentMode = 'code';
  /** 标记当前 ask 是否为单次问答（需自动恢复） */
  private pendingAskRestore = false;

  /** 设置当前模式，自动记录上一个模式 */
  setMode(mode: AgentMode): void {
    if (mode === this.currentMode) return;
    this.previousMode = this.currentMode;
    this.currentMode = mode;
    // 进入 ask 模式时标记需要恢复；离开 ask 时清除标记
    this.pendingAskRestore = mode === 'ask';
  }

  /** 获取当前模式 */
  getMode(): AgentMode {
    return this.currentMode;
  }

  /** 获取上一个模式（用于 restoreMode） */
  getPreviousMode(): AgentMode {
    return this.previousMode;
  }

  /**
   * 恢复到上一个模式
   * 主要用于 /ask 单次问答后自动回到原模式
   * @returns 是否实际发生了恢复
   */
  restoreMode(): boolean {
    if (!this.pendingAskRestore && this.currentMode !== 'ask') {
      return false;
    }
    if (this.currentMode === 'ask') {
      this.currentMode = this.previousMode;
      this.pendingAskRestore = false;
      return true;
    }
    // 即使没标记，如果当前是 ask 也尝试恢复
    this.pendingAskRestore = false;
    return false;
  }

  /**
   * 根据模式返回工具过滤配置
   * 父 Agent / 工具执行器可在 LLM 循环前查询此配置，过滤可用工具
   */
  getToolFilter(mode: AgentMode = this.currentMode): ToolFilter {
    return MODE_TOOL_FILTERS[mode];
  }

  /** 返回当前模式对应的 system prompt 追加指令（空串表示无追加） */
  getSystemPromptAddendum(mode: AgentMode = this.currentMode): string {
    return MODE_PROMPT_ADDENDUM[mode];
  }

  /** 是否处于 ask 模式（只读问答） */
  isAskMode(): boolean {
    return this.currentMode === 'ask';
  }

  /** 是否处于 architect 模式（规划先行） */
  isArchitectMode(): boolean {
    return this.currentMode === 'architect';
  }

  /** 重置到默认 code 模式（测试用） */
  reset(): void {
    this.currentMode = 'code';
    this.previousMode = 'code';
    this.pendingAskRestore = false;
  }
}

/** 单例：进程内全局共享，命令与工具过滤器共用 */
export const modeManager = new ModeManager();
