// src/harness/worktree-task-runner.ts
// B-16：task worktree 隔离——在 git worktree 内真实执行 Agent 任务
//
// 设计目的：
//   ExperimentManager 已负责 worktree 的创建/注册/回滚（git worktree add）；
//   本 runner 补齐"真正执行"的一环：在 worktree 路径内驱动 kernel 完成任务，
//   主工作区文件不受影响。默认本地执行路径不被替换——仅实验/显式任务使用。
//
// 依赖注入（最小结构类型，避免与装配层强耦合）：
//   - kernel：AgentKernel（runReAct 生产路径）
//   - classifier/modelRouter/clientManager：路由与客户端（缺失时记录并失败，不静默）
//   - prompts：提示渲染（稳定/动态区）
//   - config：语言等渲染上下文
//
// 容器后端（如 Docker）未来在此接口旁另立 adapter，不改变本类语义。

import type { AgentKernel } from '../agent/kernel.js';
import { createDefaultExecutionContext } from '../agent/execution-context.js';
import { logger } from '../utils/logger.js';
import type {
  ExperimentRunnerLike,
  ExperimentRunResult,
  TaskProgress,
} from './experiment-manager.js';

/** 最小依赖接口（结构类型：只取用到的成员） */
export interface WorktreeTaskRunnerDeps {
  kernel: AgentKernel;
  config?: { general?: { language?: string } };
  clientManager?: { get(providerId: string): { isReady(): boolean } | undefined };
  classifier?: { classify(input: { query: string }): Promise<unknown> };
  modelRouter?: { route(result: unknown): Promise<{ model: { id: string }; providerId: string; originalTier: string }> };
  prompts?: { renderPromptZones(id: string, context: Record<string, unknown>): Promise<{ stable: string; dynamic: string }> };
  /**
   * P1：已渲染的可见工具摘要（装配方从工具注册表生成）。
   * 提示中的工具列表必须与真实 schema 一致——空摘要会造成
   * "工具列表是权威来源"与真实工具面的直接冲突（审查发现）。
   */
  toolSummary?: string;
}

/** 写入型工具：用于收集 worktree 内的修改文件（与 chat-bridge 口径一致） */
const WRITE_TOOLS = new Set(['file_write', 'file_edit', 'file_append', 'git_op']);

/**
 * B-16：worktree 内任务执行器（实现 ExperimentManager 的 ExperimentRunnerLike 插槽）。
 * 未注入完整依赖时返回失败结果并记录原因（fail-open 降级，不抛异常）。
 */
export class WorktreeTaskRunner implements ExperimentRunnerLike {
  constructor(private readonly deps: WorktreeTaskRunnerDeps) {}

  /** 与 ExperimentRunnerLike.runInWorktree 兼容的入口 */
  async runInWorktree(
    worktreePath: string,
    task: string,
    options?: {
      maxIterations?: number;
      onProgress?: (progress: TaskProgress) => void;
      signal?: AbortSignal;
    },
  ): Promise<ExperimentRunResult> {
    const { kernel, classifier, modelRouter, clientManager, prompts } = this.deps;
    if (!kernel || !classifier || !modelRouter || !clientManager || !prompts) {
      const missing = ['kernel', 'classifier', 'modelRouter', 'clientManager', 'prompts']
        .filter((k) => !this.deps[k as keyof WorktreeTaskRunnerDeps])
        .join(', ');
      const msg = `worktree runner 依赖缺失（${missing}），任务未执行`;
      logger.warn('B-16: worktree runner unavailable', { missing });
      return { success: false, result: msg, modifiedFiles: [], error: msg };
    }

    const sessionId = `exp-${Date.now().toString(36)}`;
    try {
      options?.onProgress?.({ phase: 'running', message: '路由决策' });
      const classifyResult = await classifier.classify({ query: task });
      const routeDecision = await modelRouter.route(classifyResult);
      const client = clientManager.get(routeDecision.providerId);
      if (!client || !client.isReady()) {
        const msg = `provider ${routeDecision.providerId} 不可用，任务未执行`;
        return { success: false, result: msg, modifiedFiles: [], error: msg };
      }

      const executionContext = createDefaultExecutionContext(sessionId, {
        triggerSource: 'automation',
        permissionMode: 'auto',
        model: routeDecision.model.id,
      });

      // 渲染稳定/动态提示区（cwd 指向 worktree，保证 Agent 在隔离工作区工作）
      const renderedZones = await prompts.renderPromptZones('main.system', {
        language: this.deps.config?.general?.language === 'zh-CN' ? '中文' : 'English',
        autonomyMode: 'auto',
        availableTools: this.deps.toolSummary ?? '（未注入工具摘要——以工具 schema 为准）',
        projectRules: '',
        projectMemory: '',
        cwd: worktreePath,
        taskShape: 'code',
        userProfile: '',
      });

      options?.onProgress?.({ phase: 'running', message: `在 worktree 中执行任务（${worktreePath}）` });
      const runParams = {
        requestId: sessionId,
        userMessage: task,
        llmClient: client as never,
        routeDecision: routeDecision as never,
        conversationHistory: [],
        context: executionContext,
        systemBlocks: [
          { type: 'text', text: renderedZones.stable, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `${renderedZones.dynamic}\n\n当前路由决策：${routeDecision.model.id} (${routeDecision.originalTier})` },
        ],
        signal: options?.signal,
        autonomyMode: 'auto' as const,
        // B-16（审查 I2 修复）：执行级隔离——工具工作目录与目录边界切换到 worktree，
        // Agent 读写 worktree 而非主工作区；默认本地执行路径不被替换
        workspace: { workingDirectory: worktreePath, allowedDirectories: [worktreePath] },
        onConfirmTool: async () => true,
      };
      // 注意：ReActRunParams 无 maxIterations 字段——迭代上限由 loop 构造时 config 决定，
      // 此处不传（审查 I1 修复：原实现误传无效参数，已被 as never 掩盖）
      void options?.maxIterations;
      if (!kernel.runReAct) {
        const msg = 'AgentKernel 未提供 runReAct（生产适配路径缺失），任务未执行';
        return { success: false, result: msg, modifiedFiles: [], error: msg };
      }

      const modifiedFiles: string[] = [];
      let finalContent = '';
      let tokenUsage = 0;
      let runError: string | null = null;

      for await (const event of kernel.runReAct(executionContext, runParams as never)) {
        switch (event.type) {
          case 'tool_call_start':
            if (WRITE_TOOLS.has(event.toolName)) {
              const filePath = (event.args as Record<string, unknown>)?.path;
              if (typeof filePath === 'string' && !modifiedFiles.includes(filePath)) {
                modifiedFiles.push(filePath);
              }
            }
            break;
          case 'error':
            if (!runError) runError = event.error;
            break;
          case 'done':
            finalContent = event.content;
            tokenUsage = event.usage?.totalTokens ?? 0;
            break;
          default:
            break;
        }
      }

      const outcome: ExperimentRunResult = {
        success: !runError,
        result: runError ? `任务失败: ${runError}` : (finalContent.slice(0, 500) || '任务完成（无文本输出）'),
        tokenUsage,
        modifiedFiles,
        ...(runError ? { error: runError } : {}),
      };
      options?.onProgress?.({
        phase: outcome.success ? 'completed' : 'failed',
        message: outcome.result,
        modifiedFiles,
        tokenUsage,
      });
      return outcome;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('B-16: worktree task failed', { worktreePath, error: msg });
      return { success: false, result: `任务异常: ${msg}`, modifiedFiles: [], error: msg };
    }
  }
}
