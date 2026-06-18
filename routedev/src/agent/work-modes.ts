// src/agent/work-modes.ts
// 工作模式基础设施（蓝图第十二节）
// 三种模式：Build（读写执行）/ Plan（只读分析）/ Compose（编排全流程）
// WorkModeController 作为 ToolExecutor 前置守卫，不修改 ToolRegistry

import type { ToolExecutorAdapter } from './loop-config.js';

/** 工作模式（蓝图第十二节） */
export type WorkMode = 'build' | 'plan' | 'compose';

/** 操作检查的结果 */
export interface ModeCheckResult {
  allowed: boolean;
  /** 被拦截时的人类可读原因 */
  reason?: string;
}

/** Compose 模式的管线阶段 */
export type ComposePhase = 'requirements' | 'coding' | 'testing' | 'review';

/** Plan 模式允许的只读工具集合 */
const READ_ONLY_TOOLS = new Set([
  'file_read', 'file_search', 'code_search', 'list_directory',
]);

/** 需要检查的写入类工具（shell_exec/git_op 需进一步分析参数） */
const WRITE_TOOL_PATTERNS = new Set([
  'file_write', 'file_edit', 'shell_exec', 'git_op',
]);

/** shell_exec 中暗示有副作用的关键词（宁可误拦也不要漏放） */
const SHELL_WRITE_KEYWORDS = [
  'rm ', 'rm -', 'rmdir', 'mv ', 'cp ', 'mkdir', 'touch',
  'git push', 'git commit', 'git add', 'git reset', 'git checkout', 'git merge',
  'git rebase', 'git stash', 'git tag',
  'npm install', 'npm uninstall', 'npm publish', 'npm run',
  'pnpm install', 'pnpm add', 'pnpm remove', 'pnpm publish',
  'yarn add', 'yarn remove', 'yarn publish',
  'pip install', 'pip uninstall',
  'curl ', 'wget ', 'chmod', 'chown',
  'echo >', 'echo >>', 'cat >', 'cat >>',
  '> ', '>> ',
  'sed -i', 'awk -i',
  'docker ', 'kubectl ',
];

/** git_op 中属于写操作的类型 */
const GIT_WRITE_OPERATIONS = new Set([
  'add', 'commit', 'push', 'pull', 'reset', 'checkout', 'merge', 'rebase',
]);

/** Compose 管线阶段顺序 */
const COMPOSE_PHASES: ComposePhase[] = ['requirements', 'coding', 'testing', 'review'];

/**
 * 工作模式控制器
 *
 * 作为 ToolExecutor 的前置守卫：在工具执行前检查当前模式是否允许该操作。
 * 不修改 ToolRegistry，仅做权限判断。
 */
export class WorkModeController {
  private mode: WorkMode = 'build';
  private composePhase: ComposePhase | null = null;

  /** 获取当前模式 */
  getMode(): WorkMode {
    return this.mode;
  }

  /** 切换模式 */
  setMode(mode: WorkMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    // 进入 Compose 模式时初始化管线阶段
    this.composePhase = mode === 'compose' ? 'requirements' : null;
  }

  /** 检查操作是否被当前模式允许 */
  checkOperation(toolName: string, args: Record<string, unknown>): ModeCheckResult {
    // Build 和 Compose 模式放行所有操作
    if (this.mode === 'build' || this.mode === 'compose') {
      return { allowed: true };
    }

    // Plan 模式：只读分析，拦截所有写入操作
    if (this.mode === 'plan') {
      return this.checkPlanOperation(toolName, args);
    }

    return { allowed: true };
  }

  /** 获取当前 Compose 阶段（仅 Compose 模式有效） */
  getComposePhase(): ComposePhase | null {
    return this.composePhase;
  }

  /** 推进 Compose 管线到下一阶段 */
  advanceComposePhase(): void {
    if (this.mode !== 'compose' || !this.composePhase) return;
    const idx = COMPOSE_PHASES.indexOf(this.composePhase);
    if (idx < 0 || idx >= COMPOSE_PHASES.length - 1) {
      // 已到最后一阶段，保持不变（完整实现是独立 Phase 级工作量）
      return;
    }
    this.composePhase = COMPOSE_PHASES[idx + 1];
  }

  /** Plan 模式的操作权限检查 */
  private checkPlanOperation(toolName: string, args: Record<string, unknown>): ModeCheckResult {
    // 只读工具直接放行
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { allowed: true };
    }

    // 非 mcp、非写入类工具放行（如 web_search 等只读工具）
    if (!WRITE_TOOL_PATTERNS.has(toolName) && !toolName.startsWith('mcp_')) {
      return { allowed: true };
    }

    // file_write / file_edit：直接拦截
    if (toolName === 'file_write' || toolName === 'file_edit') {
      return {
        allowed: false,
        reason: 'Plan mode 拦截文件写入操作',
      };
    }

    // shell_exec：启发式判断命令是否有副作用
    if (toolName === 'shell_exec') {
      const command = (args.command as string) ?? '';
      if (this.isShellWriteCommand(command)) {
        return {
          allowed: false,
          reason: 'Plan mode 拦截 Shell 写入命令',
        };
      }
      return { allowed: true };
    }

    // git_op：检查 operation 参数判断读写
    if (toolName === 'git_op') {
      const operation = (args.operation as string) ?? '';
      if (GIT_WRITE_OPERATIONS.has(operation)) {
        return {
          allowed: false,
          reason: 'Plan mode 拦截 Git 写操作',
        };
      }
      return { allowed: true };
    }

    // mcp 工具：一律拦截（后续可让 MCP 工具声明 readOnly 元数据）
    if (toolName.startsWith('mcp_')) {
      return {
        allowed: false,
        reason: 'Plan mode 拦截 MCP 工具',
      };
    }

    return { allowed: true };
  }

  /** 启发式判断 shell 命令是否有副作用 */
  private isShellWriteCommand(command: string): boolean {
    const lower = command.toLowerCase();
    for (const keyword of SHELL_WRITE_KEYWORDS) {
      if (lower.includes(keyword)) {
        return true;
      }
    }
    return false;
  }
}

/**
 * 创建带 WorkMode 守卫的工具执行适配器
 *
 * 包装原始 ToolExecutorAdapter，在 executeTool 前插入权限检查。
 * 不修改原始适配器，不修改 ToolRegistry。
 */
export class GuardedToolExecutorAdapter implements ToolExecutorAdapter {
  private readonly inner: ToolExecutorAdapter;
  private readonly controller: WorkModeController;

  constructor(inner: ToolExecutorAdapter, controller: WorkModeController) {
    this.inner = inner;
    this.controller = controller;
  }

  getToolDefinitions() {
    return this.inner.getToolDefinitions();
  }

  hasTool(toolName: string): boolean {
    return this.inner.hasTool(toolName);
  }

  async executeTool(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const check = this.controller.checkOperation(toolName, args);
    if (!check.allowed) {
      return `[${check.reason}] 操作被拦截。`;
    }
    return this.inner.executeTool(toolName, toolCallId, args);
  }
}
