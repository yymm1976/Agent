// src/harness/experiment-runner.ts
// Phase 39 Task 3：ExperimentRunner——在 worktree 中执行 Agent 任务
//
// 设计要点：
// 1. 不修改 loop.ts 和 worker-executor.ts，通过动态 import ReActAgentLoop 复用执行逻辑
// 2. chdir 到 worktreePath，使 Agent 工具（file_read/file_write 等）在 worktree 中操作
// 3. 执行后通过 git status 收集变更文件列表
// 4. chdir 回原目录（try/finally 保证恢复）
//
// 注意：process.chdir 是进程级全局操作，不支持并发执行。
//       如需并发，应在调用层序列化或为每个 worktree 启动子进程。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ILLMClient, RoutingResult, LLMMessage } from '../router/types.js';
import type { ToolExecutorAdapter, ReActConfig } from '../agent/loop-config.js';
import type { ExperimentRunResult, TaskProgress } from './experiment-manager.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Agent Loop 的最小接口（解耦，便于测试注入 mock）
 * 与 ReActAgentLoop.run() 的签名兼容
 */
export interface IAgentLoop {
  run(params: {
    userMessage: string;
    llmClient: ILLMClient;
    routeDecision: RoutingResult;
    conversationHistory: LLMMessage[];
    systemPrompt?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<AgentLoopEvent>;
}

/** Agent Loop 事件（ReActEvent 的子集） */
export type AgentLoopEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_result'; toolName: string; toolCallId: string; result: string; isError: boolean }
  | { type: 'done'; content: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }
  | { type: 'error'; error: string };

/** Agent Loop 工厂函数签名（用于注入 mock 或动态 import ReActAgentLoop） */
export type AgentLoopFactory = (
  toolExecutor: ToolExecutorAdapter,
  config?: Partial<ReActConfig>,
) => IAgentLoop;

/** ExperimentRunner 依赖 */
export interface ExperimentRunnerDeps {
  /** LLM 客户端 */
  llmClient: ILLMClient;
  /** 路由决策 */
  routeDecision: RoutingResult;
  /** 系统提示词 */
  systemPrompt: string;
  /** 继承主 Agent 的 Skill 内容（可选，追加到 systemPrompt） */
  skillsContent?: string;
  /** 工具执行适配器（ReActAgentLoop 构造必需） */
  toolExecutor: ToolExecutorAdapter;
  /**
   * Agent Loop 工厂（可选）
   * 未提供时通过动态 import ReActAgentLoop 创建
   * 测试时注入 mock 以隔离 LLM 调用
   */
  agentLoopFactory?: AgentLoopFactory;
}

/** runInWorktree 的可选参数 */
export interface RunInWorktreeOptions {
  maxIterations?: number;
  onProgress?: (progress: TaskProgress) => void;
  signal?: AbortSignal;
}

export class ExperimentRunner {
  private deps: ExperimentRunnerDeps;

  constructor(deps: ExperimentRunnerDeps) {
    this.deps = deps;
  }

  /**
   * 在指定 worktree 中执行任务
   *
   * 流程：
   *   1. chdir 到 worktreePath
   *   2. 创建 Agent Loop 实例（动态 import 或注入的工厂）
   *   3. 运行 agentLoop.run()，收集 text_delta 和 done 事件
   *   4. 通过 git status 获取变更文件列表
   *   5. chdir 回原目录（finally 保证恢复）
   *   6. 返回 ExperimentRunResult
   */
  async runInWorktree(
    worktreePath: string,
    task: string,
    options?: RunInWorktreeOptions,
  ): Promise<ExperimentRunResult> {
    const originalCwd = process.cwd();
    const startTime = Date.now();

    try {
      // chdir 到 worktree
      process.chdir(worktreePath);
      logger.debug('ExperimentRunner: chdir 到 worktree', { worktreePath });

      // 创建 Agent Loop
      const agentLoop = await this.createAgentLoop(options?.maxIterations);

      // 构建系统提示词（追加 skillsContent）
      const systemPrompt = this.deps.skillsContent
        ? `${this.deps.systemPrompt}\n\n## 可用技能\n${this.deps.skillsContent}`
        : this.deps.systemPrompt;

      // 运行 Agent Loop，收集结果
      let responseText = '';
      let tokenUsage = 0;
      let loopError: string | null = null;

      options?.onProgress?.({
        phase: 'running',
        message: 'Agent Loop 开始执行',
      });

      try {
        for await (const event of agentLoop.run({
          userMessage: task,
          llmClient: this.deps.llmClient,
          routeDecision: this.deps.routeDecision,
          conversationHistory: [],
          systemPrompt,
          signal: options?.signal,
        })) {
          switch (event.type) {
            case 'text_delta':
              responseText += event.text;
              break;
            case 'done':
              if (event.content) responseText = event.content;
              if (event.usage) {
                tokenUsage = event.usage.totalTokens;
              }
              break;
            case 'error':
              loopError = event.error;
              logger.warn('ExperimentRunner: Agent Loop 错误事件', {
                error: event.error,
              });
              break;
          }
        }
      } catch (error: any) {
        loopError = error instanceof Error ? error.message : String(error);
        logger.error('ExperimentRunner: Agent Loop 执行异常', { error: loopError });
      }

      // 收集变更文件列表（在 worktree 目录中执行 git 命令）
      const modifiedFiles = await this.getModifiedFiles(worktreePath);

      const duration = Math.round((Date.now() - startTime) / 1000);
      const success = loopError === null;

      options?.onProgress?.({
        phase: success ? 'completed' : 'failed',
        message: success ? responseText.slice(0, 200) : (loopError ?? '未知错误'),
        modifiedFiles,
        tokenUsage,
        duration,
      });

      if (!success) {
        return {
          success: false,
          result: responseText || `执行失败: ${loopError}`,
          tokenUsage,
          modifiedFiles,
          error: loopError ?? undefined,
        };
      }

      logger.info('ExperimentRunner: 任务执行完成', {
        worktreePath,
        modifiedFilesCount: modifiedFiles.length,
        tokenUsage,
        duration,
      });

      return {
        success: true,
        result: responseText,
        tokenUsage,
        modifiedFiles,
      };
    } finally {
      // 无论成功失败，恢复原工作目录
      try {
        process.chdir(originalCwd);
      } catch (error: any) {
        logger.error('ExperimentRunner: 恢复工作目录失败', {
          originalCwd,
          error: error.message,
        });
      }
    }
  }

  /**
   * 创建 Agent Loop 实例
   * 优先使用注入的工厂，否则动态 import ReActAgentLoop
   */
  private async createAgentLoop(maxIterations?: number): Promise<IAgentLoop> {
    if (this.deps.agentLoopFactory) {
      const config: Partial<ReActConfig> = {};
      if (maxIterations !== undefined) {
        config.maxIterations = maxIterations;
      }
      return this.deps.agentLoopFactory(this.deps.toolExecutor, config);
    }

    // 动态 import ReActAgentLoop（避免静态导入导致循环依赖）
    const { ReActAgentLoop } = await import('../agent/loop.js');
    const config: Partial<ReActConfig> = {
      toolsEnabled: true,
    };
    if (maxIterations !== undefined) {
      config.maxIterations = maxIterations;
    }
    return new ReActAgentLoop(this.deps.toolExecutor, config) as unknown as IAgentLoop;
  }

  /**
   * 获取 worktree 中的变更文件列表
   * 合并 git diff HEAD（已暂存+未暂存）和 untracked 文件，去重
   */
  private async getModifiedFiles(worktreePath: string): Promise<string[]> {
    const files = new Set<string>();

    // git diff --name-only HEAD（已跟踪文件的变更）
    try {
      const trackedResult = await execFileAsync(
        'git',
        ['diff', '--name-only', 'HEAD'],
        { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
      );
      const tracked = trackedResult.stdout.trim();
      if (tracked) {
        for (const line of tracked.split('\n')) {
          const f = line.trim();
          if (f) files.add(f);
        }
      }
    } catch {
      // HEAD 不存在（空仓库）或其他错误，忽略
    }

    // git ls-files --others --exclude-standard（未跟踪文件）
    try {
      const untrackedResult = await execFileAsync(
        'git',
        ['ls-files', '--others', '--exclude-standard'],
        { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
      );
      const untracked = untrackedResult.stdout.trim();
      if (untracked) {
        for (const line of untracked.split('\n')) {
          const f = line.trim();
          if (f) files.add(f);
        }
      }
    } catch {
      // 忽略错误
    }

    return Array.from(files).sort();
  }
}
