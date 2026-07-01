// src/harness/experiment-runner.ts
// ExperimentRunner 的具体实现：在指定 worktree 目录执行 Agent 任务
//
// 替代已作为死代码移除的 experiment-runner.ts 旧版本（原版用 LLM 生成实验计划），
// 现版本采用最简实现：
//   1. 接收 worktreePath + task 参数
//   2. 在 worktreePath 下创建独立的 ExperimentDeps（复用 createAppDependencies）
//   3. 调用 agentLoop.run 执行任务
//   4. 收集执行结果（输出文本、token 用量、修改的文件列表）
//   5. 返回 ExperimentRunResult
//
// 设计原则：
//   - 实验任务执行失败不影响主流程（try/catch 包裹，失败时返回 success=false）
//   - 使用独立的 conversationHistory（传空数组，不复用主会话）
//   - 不注入主会话的 systemPrompt（让 agentLoop 用默认行为）
//   - 简化路由决策：由 depsFactory 在创建依赖时同时返回 routeDecision 和 llmClient

import type { ILLMClient, RoutingResult } from '../router/types.js';
import type { AppDependencies } from '../cli/app-init.js';
import type { ExperimentRunResult, ExperimentRunnerLike, TaskProgress } from './experiment-manager.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/**
 * 实验依赖：AppDependencies + runner 执行所需的路由信息
 *
 * depsFactory 在创建 AppDependencies 时同时返回 routeDecision 和 llmClient，
 * 避免 runner 内部重复构造路由决策。
 */
export interface ExperimentDeps extends AppDependencies {
  /** 实验任务的路由决策（用此调用 agentLoop.run） */
  routeDecision: RoutingResult;
  /** 实验任务使用的 LLM 客户端（通常为 primaryClient） */
  llmClient: ILLMClient;
}

/**
 * 依赖工厂签名：在指定 cwd 下创建实验依赖
 *
 * 注：复用 createAppDependencies 创建 AppDependencies，再附加 routeDecision 和 llmClient。
 *     每次调用都会创建独立的实例（MCP 连接、Tool 注册、orchestrator 等），
 *     开销较大但能保证实验任务与主会话完全隔离。
 */
export type DepsFactory = (cwd: string) => ExperimentDeps;

/** runInWorktree 的可选参数（与 ExperimentRunnerLike 对齐） */
export interface RunInWorktreeOptions {
  /** 最大迭代次数（可选，未使用，保留接口对齐） */
  maxIterations?: number;
  /** 进度回调（可选） */
  onProgress?: (progress: TaskProgress) => void;
  /** 取消信号（可选） */
  signal?: AbortSignal;
}

// ============================================================
// ExperimentRunner 实现
// ============================================================

/**
 * 创建 ExperimentRunner 实例
 *
 * @param depsFactory 依赖工厂：接收 cwd 返回 ExperimentDeps（含 AppDependencies + 路由信息）
 * @returns 实现 ExperimentRunnerLike 接口的 runner
 */
export function createExperimentRunner(depsFactory: DepsFactory): ExperimentRunnerLike {
  return {
    async runInWorktree(
      worktreePath: string,
      task: string,
      options?: RunInWorktreeOptions,
    ): Promise<ExperimentRunResult> {
      const startTime = Date.now();
      logger.info('ExperimentRunner: 开始执行实验任务', {
        worktreePath,
        task: task.slice(0, 80),
      });

      try {
        options?.onProgress?.({
          phase: 'running',
          message: `在 worktree ${worktreePath} 中创建依赖`,
        });

        // 在 worktree 路径下创建独立的依赖
        // 注：这会触发完整的依赖初始化（MCP 连接、工具注册、orchestrator 等）
        const deps = depsFactory(worktreePath);

        options?.onProgress?.({
          phase: 'running',
          message: '依赖创建完成，开始执行 Agent 任务',
        });

        // 调用 agentLoop.run 执行任务
        // 注：传入空 conversationHistory，不复用主会话上下文
        let responseText = '';
        let inputTokens = 0;
        let outputTokens = 0;

        for await (const event of deps.agentLoop.run({
          userMessage: task,
          llmClient: deps.llmClient,
          routeDecision: deps.routeDecision,
          conversationHistory: [],
          systemPrompt:
            '你是一个实验 Agent，在指定的 worktree 中独立执行任务。请直接完成分配的任务，不要询问用户确认。',
          signal: options?.signal,
        })) {
          // 消费事件流，收集最终输出
          // 注：实验任务不向 UI 转发流式事件，避免与主会话混淆
          switch (event.type) {
            case 'text_delta':
              responseText += event.text ?? '';
              break;
            case 'done':
              if (event.content) responseText = event.content;
              if (event.usage) {
                inputTokens = event.usage.inputTokens ?? 0;
                outputTokens = event.usage.outputTokens ?? 0;
              }
              break;
          }
        }

        const tokenUsage = inputTokens + outputTokens;
        const durationSec = Math.round((Date.now() - startTime) / 1000);

        // 修改的文件列表由 ExperimentManager 在 runInExperiment 后通过 getModifiedFiles 补充
        // 此处返回空数组，避免重复扫描
        const modifiedFiles: string[] = [];

        logger.info('ExperimentRunner: 实验任务执行完成', {
          worktreePath,
          durationSec,
          tokenUsage,
          outputLength: responseText.length,
        });

        options?.onProgress?.({
          phase: 'completed',
          message: `任务完成（耗时 ${durationSec}s，tokens ${tokenUsage}）`,
          tokenUsage,
          duration: durationSec,
        });

        return {
          success: true,
          result: responseText || `实验任务已完成（无文本输出）`,
          tokenUsage,
          modifiedFiles,
        };
      } catch (error) {
        const durationSec = Math.round((Date.now() - startTime) / 1000);
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('ExperimentRunner: 实验任务执行失败', {
          worktreePath,
          error: errorMsg,
          durationSec,
        });
        options?.onProgress?.({
          phase: 'failed',
          message: errorMsg,
          duration: durationSec,
        });
        return {
          success: false,
          result: `执行失败: ${errorMsg}`,
          modifiedFiles: [],
          error: errorMsg,
        };
      }
    },
  };
}
