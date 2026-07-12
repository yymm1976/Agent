// desktop/main/bridges/chat-bridge.ts
// Chat 领域 delegate：负责对话主流程、命令分发、工具确认/中断、对话标题生成、follow-up 队列
// 原 RouteDevEngine.sendChat / executeCommand / stopGeneration / resolveToolConfirm / resolvePlanEdit /
// generateTitle / followUp / clearAllQueues / setFollowUpMode / getQueueStatus / getFollowUpQueue /
// removeFollowUp / syncConversationHistory 全部委托至此。

import type { LLMMessage, RoutingResult } from '../../../src/router/types.js';
import { buildRouterConfig } from '../../../src/router/config.js';
import { VisionAssistant, type ImageInput } from '../../../src/agent/vision.js';
import { notifyRoutingFallback } from '../../../src/runtime/notification.js';
import { estimateTokens } from '../../../src/utils/token-estimate.js';
import type { TrajectorySummary } from '../../../src/harness/trace-types.js';
import { generateMicroSummary } from '../../../src/agent/micro-summary.js';
import { logger } from '../../../src/utils/logger.js';
import { SessionTree } from '../../../src/session/session-tree.js';
import { handleTreeCommand, handleForkCommand, handleCloneCommand } from '../../../src/session/session-commands.js';
import type { EngineContext, EngineBridges } from './engine-context.js';
import type { PlanEditRequestPayload } from '../../shared/ipc-types.js';

// TD-09：auto 模式下仍需用户确认的高风险工具集合
// 即使自主度模式为 auto（全自动），这些具备破坏性或副作用的工具仍强制弹出确认框，
// 防止 LLM 在无监督下执行危险操作（删库/覆盖文件/推送代码/派生子 Agent 等）。
// 与 engine-bridge.ts 的 HIGH_RISK_TOOLS 保持一致语义，但此处用于 Agent Loop 内的确认决策，
// HIGH_RISK_TOOLS 用于 IPC 直调拒绝（两道独立防线）。
const AUTO_MODE_CONFIRM_TOOLS = new Set([
  'shell_exec', 'git_op', 'file_write', 'spawn_agent',
]);

/**
 * Chat 领域桥接器
 *
 * 持有 EngineContext 引用，所有状态读写通过 ctx 完成。
 * executeCommand 作为命令分发器需要调用其它 bridge（GoalBridge/MCPBridge/SkillBridge），
 * 通过 ctx.bridges 访问。
 */
export class ChatBridge {
  /** Phase 84：会话树实例（懒初始化，首次使用 /tree /fork /clone 命令时创建） */
  private sessionTree: SessionTree | null = null;

  constructor(private ctx: EngineContext) {}

  async sendChat(text: string): Promise<void> {
    // G-004 修复：每次 sendChat 生成唯一 requestId，用于隔离 abortController 和 pendingConfirm，
    // 避免并发 sendChat 互相覆盖导致中断错乱和工具确认张冠李戴
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const { deps, classifier, modelRouter, tracker, clientManager, options, config } = this.ctx;
    if (!deps || !classifier || !modelRouter || !tracker || !clientManager) {
      // F-014 修复：引擎未就绪时补发 done 事件，避免渲染层永久 loading
      options.onStream({ type: 'error', error: '引擎未初始化' });
      options.onStream({ type: 'done' });
      return;
    }

    // Phase 54：拦截 /goal 命令——交由 GoalRunner 执行目标分解 + 多 Agent 协作
    // 之前 /goal 被当普通文本发给 LLM，导致命令不生效
    const trimmed = text.trim();
    if (trimmed.startsWith('/goal')) {
      await this.executeCommand(text);
      options.onStream({ type: 'done' });
      return;
    }

    // 把以下变量提到 try 外，便于 finally 块中生成 trajectory 汇总和微摘要
    // 与 chat-runner.ts 顶部声明保持一致，确保删除 chat-runner 后 desktop 不丢失可观测性
    let hasTaskError = false;
    let accumulatedContent = '';
    let actualUserMessage = text;
    let routeDecision: RoutingResult | null = null;
    let trajectorySummary: TrajectorySummary | null = null;

    try {
      const classifyResult = await classifier.classify({ query: text });
      // deterministic 走规则路径，currentTier 仅供 UI 显示，保持默认 'simple'
      if (classifyResult.tier !== 'deterministic') {
        this.ctx.currentTier = classifyResult.tier;
      }
      routeDecision = await modelRouter.route(classifyResult);
      const fallbackNotice = notifyRoutingFallback(routeDecision);
      if (fallbackNotice) {
        options.onStream({ type: 'progress', progress: { label: fallbackNotice, current: 0, total: 1 } });
      }
      this.ctx.currentModel = routeDecision.model.id;
      this.ctx.isDegraded = routeDecision.degraded;

      // 启动 Trace 会话
      deps.trace.startSession(text, routeDecision);

      const client = clientManager.get(routeDecision.providerId);
      if (!client || !client.isReady()) {
        // F-013 修复：provider 不可用时补发 done 事件，避免渲染层永久 loading
        options.onStream({
          type: 'error',
          error: `提供商 ${routeDecision.providerId} 不可用。请检查 API Key 配置。`,
        });
        options.onStream({ type: 'done' });
        return;
      }

      options.onStream({
        type: 'progress',
        progress: {
          label: `路由: ${routeDecision.model.id}`,
          current: 1,
          total: 3,
          modelId: routeDecision.model.id,
          tier: routeDecision.originalTier,
        },
      });

      const imageRefs = VisionAssistant.extractImageReferences(text);
      if (imageRefs.length > 0) {
        const loadedImages: ImageInput[] = [];
        for (const ref of imageRefs) {
          const img = await VisionAssistant.loadImage(ref, options.cwd);
          if (img) loadedImages.push(img);
        }
        if (loadedImages.length > 0) {
          options.onStream({
            type: 'progress',
            progress: { label: `正在分析 ${loadedImages.length} 张图片`, current: 2, total: 3 },
          });
          const visionResult = await deps.visionAssistant?.analyze(loadedImages, `用户问题: ${text}`);
          if (visionResult) {
            for (const img of loadedImages) {
              if (img.fileName) {
                actualUserMessage = actualUserMessage.replace(`@${img.fileName}`, `[图片:${img.fileName}]`);
              }
            }
            actualUserMessage = `[图片分析结果]\n${visionResult.description}\n\n[用户原问题]\n${actualUserMessage}`;
          }
        }
      }

      // G-004：按 requestId 绑定中断控制器到 Map，避免并发覆盖
      this.ctx.setAbortController(requestId, new AbortController());
      let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      // Phase 37：Skill 路由——根据用户消息匹配已启用的 Skill，将内容追加到 systemPrompt
      let skillPromptSuffix = '';
      if (deps.skillsRouter) {
        const matchedSkills = deps.skillsRouter.route(actualUserMessage, 3);
        // Phase 80 Task 2：Pack 加载计数（fail-open）
        // 匹配到的 Skill 计为 load，未匹配到任何 Skill 时计为 skip
        if (matchedSkills.length > 0) {
          for (const skill of matchedSkills) {
            deps.usageCounter?.increment({ kind: 'pack', name: skill.name, action: 'load' });
          }
        } else {
          deps.usageCounter?.increment({ kind: 'pack', name: '*', action: 'skip' });
        }
        if (matchedSkills.length > 0) {
          const skillBlocks = matchedSkills.map((s) =>
            `## Skill: ${s.name}\n${s.content}`,
          );
          skillPromptSuffix = `\n\n---\n# 已激活的 Skill（根据任务自动匹配）\n${skillBlocks.join('\n\n')}`;
        }
      }

      for await (const event of deps.agentLoop.run({
        userMessage: actualUserMessage,
        llmClient: client,
        routeDecision,
        conversationHistory: this.ctx.conversationHistory,
        systemPrompt: (await deps.prompts.render('main.system', {
          language: config.general.language === 'zh-CN' ? '中文' : 'English',
          autonomyMode: config.autonomy.defaultMode,
          routeDecision: `${routeDecision.model.id} (${routeDecision.originalTier})`,
          availableTools: deps.registry.list().map(t => t.definition.name).join(', '),
          cwd: options.cwd,
        })) + skillPromptSuffix,
        // G-004：从 Map 取该 requestId 对应的 signal，避免读到其他并发请求的 controller
        signal: this.ctx.getAbortController(requestId)?.signal,
        onConfirmTool: async (toolName, args) => {
          // 根据当前自主度模式决定是否需要用户确认
          // auto（全自动）：所有工具调用直接批准，不弹确认框
          // semi（半自动）/ manual（手动确认）：弹确认框等待用户操作
          // 注意：实时读取 this.ctx.config，与原 RouteDevEngine 读 this.config 一致，
          // 确保 sendChat 期间 updateConfig 修改的自主度对后续工具确认立即生效
          const currentMode = this.ctx.config.autonomy.defaultMode;
          if (currentMode === 'auto' && toolName !== 'ask_user') {
            // TD-09：auto 模式下高风险工具仍需用户确认
            // 防止 LLM 在无监督下执行 shell_exec/git_op/file_write/spawn_agent 等危险操作
            if (AUTO_MODE_CONFIRM_TOOLS.has(toolName)) {
              return this.requestUserConfirmation(requestId, toolName, args);
            }
            return true;
          }
          return this.requestUserConfirmation(requestId, toolName, args);
        },
      })) {
        switch (event.type) {
        case 'text_delta':
          accumulatedContent += event.text;
          options.onStream({ type: 'text_delta', chunk: event.text });
          break;

        case 'reasoning_delta':
          // 转发推理过程增量，供前端显示模型思考过程
          options.onStream({ type: 'reasoning_delta', reasoning: event.text });
          break;
          case 'tool_call_start':
            options.onStream({ type: 'tool_start', toolName: event.toolName, toolArgs: event.args });
            break;
          case 'tool_call_result':
            options.onStream({
              type: 'tool_done',
              toolName: event.toolName,
              toolResult: event.result,
            });
            break;
          case 'error':
            // 标记任务错误状态，用于 finally 块生成 trajectory summary 和微摘要时判定 success/failure
            hasTaskError = true;
            options.onStream({ type: 'error', error: event.error });
            break;
          case 'done':
            finalUsage = event.usage;
            break;
          case 'token_profile':
            if (event.snapshot) options.onTokenProfile?.(event.snapshot);
            break;
        }
      }

      tracker.record(finalUsage, { modelId: routeDecision.model.id, agentId: 'default', stepId: 'chat' });
      // CONCERN 修复：CircuitBreaker 接入——Agent Loop 成功完成时重置模型失败计数
      // 与 chat-runner.ts 内层 try 末尾的 recordModelSuccess 对齐
      modelRouter.recordModelSuccess(routeDecision.model.id);
      options.onStream({ type: 'progress', progress: { label: '完成', current: 3, total: 3 } });
      options.onStream({ type: 'done' });

      this.ctx.conversationHistory.push({ role: 'user', content: actualUserMessage });
      this.ctx.conversationHistory.push({ role: 'assistant', content: accumulatedContent });
      if (this.ctx.conversationHistory.length > 20) {
        this.ctx.conversationHistory = this.ctx.conversationHistory.slice(-20);
      }

      if (config.checkpoint.enabled) {
        const usagePercent = tracker.getUsagePercent();
        const triggers = config.checkpoint.triggers.map((t) => ({
          level: t.level,
          action: t.action as 'initial' | 'incremental' | 'compress',
        }));
        const triggerAction = deps.contextManager.shouldTriggerCheckpoint(usagePercent, triggers);
        if (triggerAction) {
          const cp = await deps.contextManager.triggerCheckpoint(
            triggerAction,
            this.ctx.conversationHistory,
            usagePercent,
          );
          if (cp) {
            await deps.contextManager.saveCheckpoint();
            options.onStream({
              type: 'progress',
              progress: { label: `记忆已保存: ${cp.currentIntent}`, current: 3, total: 3 },
            });
          }
        }
        const estimatedTokensCount = this.ctx.conversationHistory.reduce((acc, msg) => {
          const t = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          return acc + estimateTokens(t);
        }, 0);
        if (deps.contextManager.shouldCompress(this.ctx.conversationHistory.length, estimatedTokensCount)) {
          const { compressed, result } = deps.contextManager.compress(this.ctx.conversationHistory);
          this.ctx.conversationHistory = compressed;
          options.onStream({
            type: 'progress',
            progress: { label: `上下文已压缩: ${result.originalCount} → ${result.compressedCount} 条`, current: 3, total: 3 },
          });
        }
      }
    } catch (err) {
      // CONCERN 修复：CircuitBreaker 接入——路由或 Agent Loop 抛异常时记录模型失败
      // 与 chat-runner.ts 两层 catch 中的 recordModelFailure 对齐（routeDecision 可能为 null）
      if (routeDecision?.model?.id) modelRouter.recordModelFailure(routeDecision.model.id);
      options.onStream({
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      options.onStream({ type: 'done' });
    } finally {
      // G-004：清除该 requestId 对应的中断控制器（已完成或出错，不再需要中断）
      this.ctx.clearAbortController(requestId);

      // Phase 34：任务结束时记录 trajectory 级过程评测汇总
      // 与 chat-runner.ts finally 块对齐，确保删除 chat-runner 后 desktop 不丢失可观测性
      if (deps?.trace && deps?.audit && routeDecision) {
        try {
          trajectorySummary = deps.trace.summarizeTrajectory({
            success: !hasTaskError,
            terminationReason: hasTaskError ? 'error' : 'completed',
            modelId: routeDecision.model.id,
            tier: routeDecision.originalTier,
          });
          deps.audit.logTrajectorySummary(trajectorySummary);
        } catch (err) {
          console.warn('[Engine] failed to log trajectory summary:', err);
        }
      }

      // Phase 34 Task 2：生成微摘要并推送到渲染进程
      // 与 chat-runner.ts finally 块对齐，仅在存在工具调用/关键决策等有意义内容时推送
      if (deps?.trace && routeDecision) {
        try {
          const status: 'success' | 'failure' = hasTaskError ? 'failure' : 'success';
          const microSummary = generateMicroSummary(
            actualUserMessage,
            accumulatedContent,
            deps.trace.getSpans(),
            trajectorySummary,
            status,
          );
          // 只有确实存在工具调用或关键决策时才推送微摘要，避免空卡片
          const hasMeaningfulSummary =
            microSummary.stepCount > 0 ||
            microSummary.keyDecisions.length > 0 ||
            microSummary.fileChanges.length > 0;
          if (hasMeaningfulSummary) {
            options.onStream({ type: 'micro_summary', microSummary });
          }
        } catch (err) {
          console.warn('[Engine] failed to generate micro summary:', err);
        }
      }

      // F-004：结束 Trace 会话，触发 .session.json/.spans.json 落盘
      // 落盘失败仅 log，不影响主链路
      if (deps?.trace && routeDecision) {
        try {
          await deps.trace.endSession();
        } catch (err) {
          console.warn('[Engine] trace endSession failed:', err);
        }
      }
    }
  }

  /**
   * TD-09：请求用户确认工具调用
   *
   * G-004 修复：通过 requestId 在 pendingConfirms Map 中隔离不同并发请求的确认 entry，
   * 避免并发 sendChat 的工具确认张冠李戴。
   *
   * 通过 onToolConfirmRequest 回调把确认请求（含 requestId）推送到渲染进程，
   * 同时把 resolver 存入 pendingConfirms Map，等待 resolveToolConfirm 在
   * IPC chat:confirm-tool 触发时按 requestId 精准 resolve。
   *
   * 抽取为独立方法供 onConfirmTool 在 auto/semi 两条路径复用，
   * 避免重复内联 Promise 逻辑。
   */
  private requestUserConfirmation(
    requestId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean | { approved: boolean; payload?: unknown }> {
    // V2-T02 修复：添加 60s 超时机制，防止用户不响应时 Promise 永不 resolve
    const timeoutMs = 60_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 超时视为拒绝，清理 pendingConfirm 防止后续 resolveToolConfirm 误触已 resolve 的 Promise
        this.ctx.clearPendingConfirm(requestId);
        logger.warn('requestUserConfirmation 超时', { requestId, toolName, timeoutMs });
        resolve(false);
      }, timeoutMs);
      // 包装 resolve：实际确认到达时先清除 timer 再 resolve，避免超时与确认竞争
      const wrappedResolve = (value: boolean | { approved: boolean; payload?: unknown }) => {
        clearTimeout(timer);
        resolve(value);
      };
      // G-004：按 requestId 存入 Map，避免并发覆盖
      this.ctx.setPendingConfirm(requestId, { resolve: wrappedResolve, toolName });
      // G-004：回调携带 requestId，前端在 confirm-tool 回传中带上以实现精准 resolve
      this.ctx.options.onToolConfirmRequest(requestId, toolName, args);
    });
  }

  /**
   * 解析工具确认（供 IPC chat:confirm-tool 调用）
   * G-004 修复：按 requestId 从 Map 中精准取 entry，避免张冠李戴
   * @param requestId 关联的聊天请求 ID
   * @param approved 用户是否批准
   * @param payload 附加载荷（如 ask_user 的回答内容）
   */
  resolveToolConfirm(requestId: string, approved: boolean, payload?: unknown): void {
    const entry = this.ctx.getPendingConfirm(requestId);
    if (entry) {
      entry.resolve({ approved, payload });
      this.ctx.clearPendingConfirm(requestId);
    }
  }

  /**
   * Phase 54：解析计划编辑响应（渲染层 StepEditor 确认/取消后调用）
   * @param requestId 关联的请求 ID
   * @param steps 编辑后的步骤列表；null 表示用户取消
   */
  resolvePlanEdit(requestId: string, steps: PlanEditRequestPayload['plan']['steps'] | null): void {
    const resolver = this.ctx.pendingPlanEditResolvers.get(requestId);
    if (resolver) {
      this.ctx.pendingPlanEditResolvers.delete(requestId);
      resolver(steps);
    }
  }

  /**
   * 停止当前生成（供 IPC chat:stop 调用）
   * 中止进行中的 LLM 请求与 Agent Loop 迭代
   *
   * G-004 修复：支持按 requestId 精准中断指定请求；
   * 未传入 requestId 时中断全部并发请求（向后兼容）。
   *
   * Phase 54 修复：同时 abort 共享的 abortControllerRef，让 GoalRunner 步骤循环检测到 aborted 后中止
   * F4.10 修复：abort 时主动清理 pendingPlanEditResolvers，避免用户中断 /goal 时残留 resolver 导致线程泄漏
   *
   * @param requestId 可选，指定要中断的聊天请求 ID；不传则中断全部
   */
  stopGeneration(requestId?: string): void {
    if (requestId) {
      // G-004：精准中断指定 requestId
      const controller = this.ctx.getAbortController(requestId);
      if (controller) {
        try { controller.abort(); } catch { /* 忽略 abort 异常 */ }
        this.ctx.clearAbortController(requestId);
      }
      // F-066 修复：清理该 requestId 的 pending confirm，resolve({ approved: false }) 释放 Promise
      // 与 clearAbortController 配对，避免 stopGeneration 后残留 pending confirm 导致线程泄漏
      const pendingConfirm = this.ctx.getPendingConfirm(requestId);
      if (pendingConfirm) {
        try { pendingConfirm.resolve({ approved: false }); } catch { /* 忽略 resolve 异常 */ }
        this.ctx.clearPendingConfirm(requestId);
      }
    } else {
      // G-004：无 requestId 时中断全部并发请求（向后兼容）
      this.ctx.clearAllAbortControllers();
      this.ctx.clearAllPendingConfirms();
    }
    // 同时 abort GoalRunner 的共享 ref，让 GoalRunner 步骤循环检测到 aborted 后中止
    this.ctx.abortControllerRef.current?.abort();
    this.ctx.abortControllerRef.current = null;
    // F4.10：清理挂起的 plan edit resolvers，resolve([]) 与超时行为一致（取消编辑，保留原计划）
    if (this.ctx.pendingPlanEditResolvers.size > 0) {
      for (const resolver of this.ctx.pendingPlanEditResolvers.values()) {
        try {
          resolver([]);
        } catch (err) {
          logger.warn('Failed to resolve pending plan edit on stopGeneration', { error: err instanceof Error ? err.message : String(err) });
        }
      }
      this.ctx.pendingPlanEditResolvers.clear();
    }
  }

  /**
   * 使用路由模型（杂活模型）生成对话标题
   * 在用户发送第一条消息后调用，避免标题过长或截断
   */
  async generateTitle(userMessage: string, assistantReply?: string): Promise<string> {
    const { clientManager, classifier, config } = this.ctx;
    if (!clientManager || !classifier) {
      // 无可用 LLM 时回退到截断策略
      const fallback = userMessage.trim().slice(0, 30);
      return fallback.length < userMessage.trim().length ? fallback + '…' : fallback;
    }
    try {
      const readyClients = clientManager.getReadyClients();
      if (readyClients.length === 0) {
        return userMessage.trim().slice(0, 30) + (userMessage.length > 30 ? '…' : '');
      }
      const client = readyClients[0].client;
      const routerConfig = buildRouterConfig(config);
      // 使用分类器模型（杂活模型），回退到配置中的第一个模型
      const model = routerConfig.classifierModel || config.providers[0]?.models[0]?.id || '';
      if (!model) {
        // 无可用模型，回退到截断
        return userMessage.trim().slice(0, 30) + (userMessage.length > 30 ? '…' : '');
      }

      const systemPrompt = `你是一个对话标题生成器。根据用户的消息生成一个简洁的对话标题。
要求：
- 标题不超过 20 个字
- 概括用户的核心意图
- 不要使用引号、书名号等符号
- 直接返回标题文本，不要任何额外说明`;

      const messages: LLMMessage[] = [
        { role: 'user', content: `用户消息: ${userMessage}${assistantReply ? `\n助手回复摘要: ${assistantReply.slice(0, 200)}` : ''}` },
      ];

      const response = await client.complete({
        model,
        messages,
        systemPrompt,
        maxTokens: 50,
        temperature: 0,
      });

      const title = response.content.trim().split('\n')[0].trim();
      // 限制标题长度
      return title.length > 30 ? title.slice(0, 30) + '…' : title;
    } catch (err) {
      console.error('[Engine] 生成标题失败:', err);
      const fallback = userMessage.trim().slice(0, 30);
      return fallback.length < userMessage.trim().length ? fallback + '…' : fallback;
    }
  }

  async executeCommand(text: string): Promise<unknown> {
    const cmd = text.trim();
    const { deps, options, config } = this.ctx;

    // Phase 54：/goal 命令——目标分解 + 多 Agent 协作执行
    // 之前缺失此分支，导致 /goal 走 sendChat 当普通消息发给 LLM
    if (cmd.startsWith('/goal')) {
      return this.peers().goal.executeGoalCommand(text);
    }

    // GUI 支持的快捷命令
    if (cmd === '/clear') {
      this.ctx.conversationHistory = [];
      // Phase 84：清空对话时同步重置会话树，下次 /tree 重新从空历史懒初始化
      this.sessionTree = null;
      return { ok: true, message: '对话历史已清空' };
    }
    if (cmd === '/status') {
      return {
        ok: true,
        message: `模型: ${this.ctx.currentModel}\n层级: ${this.ctx.currentTier}\n降级: ${this.ctx.isDegraded}\n历史: ${this.ctx.conversationHistory.length} 条`,
      };
    }
    if (cmd === '/mcp') {
      return { ok: true, message: JSON.stringify(this.peers().mcp.getMCPStatus(), null, 2) };
    }
    if (cmd === '/compact' || cmd === '/compress') {
      if (deps && this.ctx.conversationHistory.length > 4) {
        const { compressed, result } = deps.contextManager.compress(this.ctx.conversationHistory);
        this.ctx.conversationHistory = compressed;
        return { ok: true, message: `上下文已压缩: ${result.originalCount} → ${result.compressedCount} 条` };
      }
      return { ok: true, message: '对话历史较短，无需压缩' };
    }
    // Phase 84：/tree /fork /clone 会话分支命令
    if (cmd === '/tree' || cmd.startsWith('/tree ')) {
      const tree = this.getOrCreateSessionTree();
      if (!tree) {
        return { ok: true, message: '🌳 会话树为空，发送消息开始对话。' };
      }
      const args = cmd.slice('/tree'.length).trim();
      const result = handleTreeCommand(tree, args || undefined);
      return { ok: true, message: result.text };
    }
    if (cmd === '/fork' || cmd.startsWith('/fork ')) {
      const tree = this.getOrCreateSessionTree();
      if (!tree) {
        return { ok: true, message: '❌ 会话树为空，无法 fork。请先发送消息建立对话。' };
      }
      const args = cmd.slice('/fork'.length).trim();
      const result = handleForkCommand(tree, args || undefined);
      return { ok: true, message: result.text };
    }
    if (cmd === '/clone') {
      const tree = this.getOrCreateSessionTree();
      if (!tree) {
        return { ok: true, message: '❌ 会话树为空，无法 clone。请先发送消息建立对话。' };
      }
      const result = handleCloneCommand(tree);
      return { ok: true, message: result.text };
    }
    if (cmd === '/help') {
      return {
        ok: true,
        message: '可用命令: /clear /status /mcp /compact /skill /goal /replay /scorecard /doctor /usage /tree /fork /clone /help',
      };
    }
    // Phase 37：/skill 和 /skills 命令
    if (cmd === '/skill' || cmd === '/skills') {
      const skills = this.peers().skill.listSkills();
      if (skills.length === 0) {
        return { ok: true, message: '未发现任何 Skill。Skill 文件约定放在 .routedev/skills/<name>/SKILL.md' };
      }
      const lines = skills.map((s) =>
        `${s.enabled ? '[ON] ' : '[OFF]'} ${s.name} — ${s.description.slice(0, 60)}`,
      );
      return {
        ok: true,
        message: `Skill 列表（${skills.length} 个）:\n${lines.join('\n')}\n\n在设置页面的 "Skill 技能" Tab 可管理 Skill`,
      };
    }
    // Grok F-016 修复：/doctor 手动入口——按需运行 Doctor 探测，输出格式化报告
    // 复用 src/runtime/doctor.ts 的 Doctor 类（与 app-init.ts 启动检查同源），runOnStartup=false 表示手动触发
    if (cmd === '/doctor') {
      try {
        const { Doctor } = await import('../../../src/runtime/doctor.js');
        const probeTimeout = config.phase53Integration?.doctor?.probeTimeout ?? 10000;
        const doctor = new Doctor(
          { probeTimeout, runOnStartup: false },
          {
            providers: config.providers.map((p) => ({ id: p.id, baseUrl: p.baseUrl })),
            mcpServers: config.mcp.servers.map((s) => ({ id: s.id, command: (s as { command?: string }).command ?? '' })),
            cwd: options.cwd,
          },
        );
        const results = await doctor.runAllChecks();
        return { ok: true, message: doctor.formatReport(results) };
      } catch (err) {
        return { ok: false, message: `Doctor 探测失败: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return { ok: false, message: `GUI 中暂不支持命令: ${text}` };
  }

  syncConversationHistory(messages: LLMMessage[]): void {
    this.ctx.conversationHistory = messages.slice(-20);
    console.log(`[Engine] 对话历史已同步: ${this.ctx.conversationHistory.length} 条`);
  }

  // ============================================================
  // Phase 73 Part C：Steering / Follow-up 双消息队列桥接方法
  // 直接调用 agentLoop 的 API（fail-open：deps 未就绪时记录但不抛异常）
  // ============================================================

  /**
   * 排队 follow-up 消息
   *
   * 调用时机：用户在 Agent 工作期间排队后续任务。Agent 完成当前工作后，
   * run() 内层 ReAct 循环自然退出时取出 follow-up 注入 messages，开启新一轮 ReAct。
   *
   * @param content 后续任务内容（不能为空字符串）
   * @returns 是否成功入队（deps 未就绪或内容为空时返回 false）
   */
  followUp(content: string): boolean {
    if (!this.ctx.deps?.agentLoop) {
      console.warn('[Engine] agentLoop 未就绪，followUp 调用被忽略');
      return false;
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      console.warn('[Engine] followUp 内容为空，调用被忽略');
      return false;
    }
    this.ctx.deps.agentLoop.followUp(content);
    return true;
  }

  /**
   * 清空所有队列（steering + follow-up）
   *
   * 调用时机：用户主动取消 / 会话重置 / 切换项目。
   * 避免残留消息在下次 run() 时被错误注入。
   */
  clearAllQueues(): void {
    if (!this.ctx.deps?.agentLoop) {
      console.warn('[Engine] agentLoop 未就绪，clearAllQueues 调用被忽略');
      return;
    }
    this.ctx.deps.agentLoop.clearAllQueues();
  }

  /**
   * Phase 73 Part C 修复：设置 follow-up 出队模式
   *
   * 调用时机：用户在 UI 切换"逐条 / 全部"模式。
   *   - 'one-at-a-time'（默认）：内层循环退出时仅注入第一条 follow-up，剩余保留
   *   - 'all'：内层循环退出时一次性注入全部 follow-up 消息
   *
   * @param mode 出队模式
   * @returns 是否设置成功（deps 未就绪时返回 false）
   */
  setFollowUpMode(mode: 'all' | 'one-at-a-time'): boolean {
    if (!this.ctx.deps?.agentLoop) {
      console.warn('[Engine] agentLoop 未就绪，setFollowUpMode 调用被忽略');
      return false;
    }
    this.ctx.deps.agentLoop.setFollowUpMode(mode);
    return true;
  }

  /**
   * 查询队列状态（UI 展示用）
   *
   * @returns follow-up 队列当前长度（deps 未就绪时返回 0）
   */
  getQueueStatus(): { followUp: number } {
    if (!this.ctx.deps?.agentLoop) {
      return { followUp: 0 };
    }
    return this.ctx.deps.agentLoop.getQueueStatus();
  }

  /**
   * 查询 follow-up 队列内容（UI 展示列表用，只读快照）
   *
   * @returns follow-up 队列内容的浅拷贝（deps 未就绪时返回空数组）
   */
  getFollowUpQueue(): { role: 'follow_up'; content: string; enqueuedAt: number }[] {
    if (!this.ctx.deps?.agentLoop) return [];
    return this.ctx.deps.agentLoop.getFollowUpQueue();
  }

  /**
   * 删除指定索引的 follow-up 消息（UI 单条删除用）
   *
   * @param index 队列索引（0 表示最早入队的）
   * @returns 是否删除成功（deps 未就绪或索引越界时返回 false）
   */
  removeFollowUp(index: number): boolean {
    if (!this.ctx.deps?.agentLoop) return false;
    return this.ctx.deps.agentLoop.removeFollowUp(index);
  }

  /**
   * Phase 84：获取或创建会话树实例（懒初始化）
   *
   * 首次调用时从 conversationHistory 导入为单分支树（向后兼容线性消息）。
   * conversationHistory 为空时返回 null，命令调用方应返回友好提示。
   * 后续 fork/clone 产生的分支结构保留在 sessionTree 中，不再从线性历史重建。
   *
   * @returns SessionTree 实例；无对话历史时返回 null
   */
  private getOrCreateSessionTree(): SessionTree | null {
    if (this.sessionTree) return this.sessionTree;
    if (this.ctx.conversationHistory.length === 0) return null;
    this.sessionTree = SessionTree.fromLinear(this.ctx.conversationHistory);
    return this.sessionTree;
  }

  /** 安全读取 bridges 集合（executeCommand 跨 bridge 调用入口） */
  private peers(): EngineBridges {
    if (!this.ctx.bridges) {
      throw new Error('EngineContext.bridges 未初始化（RouteDevEngine 构造未完成）');
    }
    return this.ctx.bridges;
  }
}
