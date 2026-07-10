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
import type { EngineContext, EngineBridges } from './engine-context.js';
import type { PlanEditRequestPayload } from '../../shared/ipc-types.js';

/**
 * Chat 领域桥接器
 *
 * 持有 EngineContext 引用，所有状态读写通过 ctx 完成。
 * executeCommand 作为命令分发器需要调用其它 bridge（GoalBridge/MCPBridge/SkillBridge），
 * 通过 ctx.bridges 访问。
 */
export class ChatBridge {
  constructor(private ctx: EngineContext) {}

  async sendChat(text: string): Promise<void> {
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
      this.ctx.currentTier = classifyResult.tier;
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

      this.ctx.abortController = new AbortController();
      let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      // Phase 37：Skill 路由——根据用户消息匹配已启用的 Skill，将内容追加到 systemPrompt
      let skillPromptSuffix = '';
      if (deps.skillsRouter) {
        const matchedSkills = deps.skillsRouter.route(actualUserMessage, 3);
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
        signal: this.ctx.abortController.signal,
        onConfirmTool: async (toolName, args) => {
          // 根据当前自主度模式决定是否需要用户确认
          // auto（全自动）：所有工具调用直接批准，不弹确认框
          // semi（半自动）/ manual（手动确认）：弹确认框等待用户操作
          // 注意：实时读取 this.ctx.config，与原 RouteDevEngine 读 this.config 一致，
          // 确保 sendChat 期间 updateConfig 修改的自主度对后续工具确认立即生效
          const currentMode = this.ctx.config.autonomy.defaultMode;
          if (currentMode === 'auto' && toolName !== 'ask_user') {
            return true;
          }
          return new Promise<boolean | { approved: boolean; payload?: unknown }>((resolve) => {
            this.ctx.pendingConfirmRef.current = { resolve, toolName };
            options.onToolConfirmRequest(toolName, args);
          });
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
      this.ctx.abortController = null;

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
    }
  }

  resolveToolConfirm(approved: boolean, payload?: unknown): void {
    if (this.ctx.pendingConfirmRef.current) {
      this.ctx.pendingConfirmRef.current.resolve({ approved, payload });
      this.ctx.pendingConfirmRef.current = null;
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
   * Phase 54 修复：同时 abort 共享的 abortControllerRef，让 GoalRunner 步骤循环检测到 aborted 后中止
   * F4.10 修复：abort 时主动清理 pendingPlanEditResolvers，避免用户中断 /goal 时残留 resolver 导致线程泄漏
   */
  stopGeneration(): void {
    this.ctx.abortController?.abort();
    this.ctx.abortController = null;
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
    if (cmd === '/help') {
      return {
        ok: true,
        message: '可用命令: /clear /status /mcp /compact /skill /goal /replay /scorecard /doctor /help',
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

  /** 安全读取 bridges 集合（executeCommand 跨 bridge 调用入口） */
  private peers(): EngineBridges {
    if (!this.ctx.bridges) {
      throw new Error('EngineContext.bridges 未初始化（RouteDevEngine 构造未完成）');
    }
    return this.ctx.bridges;
  }
}
