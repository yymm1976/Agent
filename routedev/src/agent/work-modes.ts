// src/agent/work-modes.ts
// 工作模式基础设施（蓝图第十二节）
// 三种模式：Build（读写执行）/ Plan（只读分析）/ Compose（编排全流程）
// WorkModeController 作为 ToolExecutor 前置守卫，不修改 ToolRegistry
//
// Phase 32 Task 1.3：GuardedToolExecutorAdapter 接入 ReadTracker
// 先读后写强制——file_write/file_edit 前必须 file_read 过（新建文件例外）

import type { ToolExecutorAdapter } from './loop-config.js';
import type { ReadTracker } from '../tools/read-tracker.js';
import { logger } from '../utils/logger.js';
// 任务1：接入 ComposePipeline，让 Compose 模式具备自动编排能力
import { ComposePipeline } from './compose-pipeline.js';

/** 工作模式（蓝图第十二节） */
export type WorkMode = 'build' | 'plan' | 'compose';

/** 操作检查的结果 */
interface ModeCheckResult {
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
  // P1-7 修复：spawn_agent 可执行写操作，必须拦截
  'spawn_agent',
]);

/** 网络类工具（Plan 模式下需确认） */
const NETWORK_TOOL_PATTERNS = new Set([
  // P1-7 修复：web_fetch/web_search 可能产生副作用，Plan 模式下拦截
  'web_fetch', 'web_search',
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
  /** 任务1：Compose 管线实例，构造时创建，由 Agent Loop 注入使用 */
  private composePipeline: ComposePipeline;

  constructor() {
    // ComposePipeline 持有本控制器引用，构造时创建（无运行时循环依赖）
    this.composePipeline = new ComposePipeline(this);
  }

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

  /** 任务1：获取 ComposePipeline 实例（供 Agent Loop 注入使用） */
  getComposePipeline(): ComposePipeline {
    return this.composePipeline;
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

    // P1-7 修复：网络类工具在 Plan 模式下拦截
    if (NETWORK_TOOL_PATTERNS.has(toolName)) {
      return {
        allowed: false,
        reason: 'Plan mode 拦截网络请求操作',
      };
    }

    // P1-7 修复：spawn_agent 在 Plan 模式下拦截（子 Agent 可执行写操作）
    if (toolName === 'spawn_agent') {
      return {
        allowed: false,
        reason: 'Plan mode 拦截子 Agent 生成（子 Agent 可执行写操作）',
      };
    }

    // 非 mcp、非写入类工具放行（如 todo_write, notes 等内部状态工具）
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
 *
 * Phase 32 Task 1.3：可选接入 ReadTracker，实现先读后写强制。
 *   - file_write / file_edit 执行前检查 readTracker.checkWriteAllowed(path)
 *   - file_read 执行后调用 readTracker.markRead(path)
 *   - 新建文件（路径不存在）自动放行
 *   - readTracker 为 null 时跳过检查（向后兼容）
 */
export class GuardedToolExecutorAdapter implements ToolExecutorAdapter {
  private readonly inner: ToolExecutorAdapter;
  private readonly controller: WorkModeController;
  /** Phase 32 Task 1.3：文件读取追踪器（可选） */
  private readonly readTracker: ReadTracker | null;
  /** Phase 32 Task 1.3：是否启用先读后写强制（来自 config.optimization.safety.readBeforeWrite） */
  private readonly readBeforeWriteEnabled: boolean;

  constructor(
    inner: ToolExecutorAdapter,
    controller: WorkModeController,
    readTracker: ReadTracker | null = null,
    readBeforeWriteEnabled: boolean = true,
  ) {
    this.inner = inner;
    this.controller = controller;
    this.readTracker = readTracker;
    this.readBeforeWriteEnabled = readBeforeWriteEnabled;
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
    // P2-5 修复：增加 try-catch，防止 checkOperation 抛异常导致 Promise.all 全部丢失
    try {
      const check = this.controller.checkOperation(toolName, args);
      if (!check.allowed) {
        return `[${check.reason}] 操作被拦截。`;
      }

      // Phase 32 Task 1.3：先读后写强制
      // file_write / file_edit 执行前检查文件是否已读过（新建文件例外）
      if (this.readTracker && this.readBeforeWriteEnabled) {
        const writeCheck = await this.checkReadBeforeWrite(toolName, args);
        if (!writeCheck.allowed) {
          return writeCheck.reason ?? '[安全] 先读后写检查未通过';
        }
      }

      const result = await this.inner.executeTool(toolName, toolCallId, args);

      // Phase 32 Task 1.3：file_read 执行后标记文件为已读
      // 这样后续的 file_write/file_edit 才能通过检查
      if (this.readTracker && toolName === 'file_read') {
        const filePath = this.extractFilePath(args);
        if (filePath) {
          this.readTracker.markRead(filePath);
        }
      }

      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `[工具执行异常] ${toolName}: ${msg}`;
    }
  }

  /**
   * Phase 32 Task 1.3：检查先读后写
   * 仅对 file_write / file_edit 生效，其他工具直接放行
   * @returns allowed: 是否允许；reason: 拒绝原因
   */
  private async checkReadBeforeWrite(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (toolName !== 'file_write' && toolName !== 'file_edit') {
      return { allowed: true };
    }
    const filePath = this.extractFilePath(args);
    if (!filePath) {
      // 无法提取路径，放行（不阻断正常工作）
      return { allowed: true };
    }
    return this.readTracker!.checkWriteAllowed(filePath);
  }

  /**
   * 从工具参数中提取文件路径
   * file_read / file_write 用 path 字段，file_edit 用 filePath 或 path 字段
   */
  private extractFilePath(args: Record<string, unknown>): string | null {
    const p = args.path ?? args.filePath;
    return typeof p === 'string' ? p : null;
  }
}
