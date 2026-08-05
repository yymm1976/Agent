// desktop/main/bridges/chat-bridge.ts
// Chat 领域 delegate：负责对话主流程、命令分发、工具确认/中断、对话标题生成、follow-up 队列
// 原 RouteDevEngine.sendChat / executeCommand / stopGeneration / resolveToolConfirm / resolvePlanEdit /
// generateTitle / followUp / clearAllQueues / setFollowUpMode / getQueueStatus / getFollowUpQueue /
// removeFollowUp / syncConversationHistory 全部委托至此。

import path from 'node:path';
import type { LLMMessage, RoutingResult, TokenUsageInfo } from '../../../src/router/types.js';
import { buildRouterConfig } from '../../../src/router/config.js';
import { VisionAssistant, type ImageInput } from '../../../src/agent/vision.js';
import { notifyRoutingFallback } from '../../../src/runtime/notification.js';
import { estimateTokens } from '../../../src/utils/token-estimate.js';
import type { TrajectorySummary } from '../../../src/harness/trace-types.js';
import { generateMicroSummary } from '../../../src/agent/micro-summary.js';
import { toCompletionStatus, type GateResult } from '../../../src/agent/completion-gate.js';
import { logger } from '../../../src/utils/logger.js';
import { SessionTree } from '../../../src/session/session-tree.js';
import { handleTreeCommand, handleForkCommand, handleCloneCommand } from '../../../src/session/session-commands.js';
import { ConversationPersistence } from '../../../src/session/conversation-persistence.js';
// Phase 97 Part C：统一中断队列（审批/提问/计划审批的公共视图与 reclaim/abort 兜底）
import { InterruptionBroker } from '../../../src/agent/interruption-broker.js';
import type { Interruption } from '../../../src/agent/interruption.js';
// Phase 97 Part B：对话与文件联合快照（turn 结束捕获，供 UI 对话级撤销）
import { TurnSnapshotManager } from '../../../src/harness/turn-snapshot.js';
// Phase 97 Part G：输入框结构化引用解析
import { parseComposerReferences } from '../../../src/agent/context/composer-reference.js';
// Phase 97 Part A Task A4：统一执行上下文（触发来源透传）
import { createDefaultExecutionContext } from '../../../src/agent/execution-context.js';
// Phase 97 Part F：自动化任务预授权白名单匹配（allowlist 前缀语义）
import { isAllowedByAllowlist } from '../../../src/runtime/automation-scheduler.js';
// Phase 97 Part I：轻量用户档案渲染
import { renderUserProfile } from '../../../src/memory/user-profile.js';
import type { SystemBlock } from '../../../src/agent/loop.js';
import type { ReActRunParams } from '../../../src/agent/loop.js';
import { loadProjectDoc, ProjectMemoryManager } from '../../../src/memory/project-memory.js';
import { resolveVisibleTools } from '../../../src/tools/tool-surface-resolver.js';
import { isGitWriteOperation } from '../../../src/tools/git-ops.js';
import { summarizeToolsForPrompt } from '../../../src/prompts/manager.js';
import type { EngineContext, EngineBridges } from './engine-context.js';
import type { PlanEditRequestPayload } from '../../shared/ipc-types.js';
import {
  ChatStreamEventPublisher,
  createRemoteTurnContext,
  type RemoteTurnContextInput,
} from '../remote/chat-stream-event-publisher.js';

// auto 模式已由用户明确授权：除 ask_user 外不在桥接层重复确认。
// 真正危险的操作仍由 PermissionEngine 与 SecurityChecker 的 allowed=false 硬拒绝。
const VERIFY_REQUEST_PATTERN = /验证|测试|检查构建|运行构建|类型检查|\b(?:verify|test|typecheck|lint|build)\b/i;

/**
 * 修复 8（复审）：DeepSeek 思考强度与输出预算的任务形状确定性映射
 * （官方：普通请求 high，复杂 Agent 请求可用 max；多步实现/调查/失败重试取 max）
 */
function reasoningEffortForTaskShape(taskShape?: string): 'low' | 'high' | 'max' | undefined {
  switch (taskShape) {
    case 'multi-step-impl':
    case 'investigation':
      return 'max';
    case 'qa':
    case 'single-step':
    default:
      return 'high';
  }
}

/** 修复 8：输出 token 预算按任务形状映射（多步/调查任务需要更长输出） */
function maxTokensForTaskShape(taskShape?: string): number | undefined {
  switch (taskShape) {
    case 'multi-step-impl':
      return 8192;
    case 'investigation':
      return 8192;
    case 'qa':
    case 'single-step':
    default:
      return undefined; // 保持 loop 默认 4096
  }
}

/**
 * 自动化任务预授权判定：allowlist（read:/write:/run:/tool: 前缀条目）是否覆盖该工具调用。
 * 能力候选从工具名与参数中的路径/命令字段推导；匹配复用 isAllowedByAllowlist 的前缀语义。
 * B-03：git_op 按操作区分——`tool:git_op` 只预授权读操作（status/log/diff 等）；
 *       写操作（commit/push/pull/prune 等）需要显式 `tool:git_op:write`，否则走确认流。
 * 白名单外工具仍走正常确认流，危险操作仍由 PermissionEngine/SecurityChecker 硬拒绝。
 */
function isPreAuthorized(
  toolName: string,
  args: Record<string, unknown>,
  allowlist: string[],
): boolean {
  const capabilities = [`tool:${toolName}`];
  if (toolName === 'git_op') {
    // 写操作不因工具名共同预授权：需要显式 tool:git_op:write 条目
    if (isGitWriteOperation(args?.operation)) {
      capabilities.length = 0;
      capabilities.push('tool:git_op:write');
    }
  }
  const pathKeys = ['path', 'filePath', 'target', 'source', 'destination'];
  for (const key of pathKeys) {
    const value = args?.[key];
    if (typeof value === 'string' && value.length > 0) {
      capabilities.push(`read:${value}`, `write:${value}`);
    }
  }
  if (toolName === 'bash' || toolName === 'run_command') {
    const command = args?.command ?? args?.cmd;
    if (typeof command === 'string') {
      const head = command.trim().split(/\s+/)[0];
      if (head) capabilities.push(`run:${head}`);
    }
  }
  return capabilities.some((cap) => isAllowedByAllowlist(allowlist, cap));
}

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
  /** Phase 96 P0-1：对话历史持久化（重启恢复） */
  private readonly persistence: ConversationPersistence;
  /** Phase 97 Part C：统一中断队列（按 requestId 记录审批，供 reclaim/abort 兜底；超时由现有 60s 机制负责，此处不重复计时） */
  private readonly interruptionBroker = new InterruptionBroker({ defaultTimeoutMs: 0 });
  /** Phase 97 Part B：Turn 联合快照管理器（对话级撤销用，随会话保留） */
  private readonly turnSnapshotManager = new TurnSnapshotManager();

  constructor(private ctx: EngineContext) {
    this.persistence = new ConversationPersistence(ctx.options.cwd);
  }

  /**
   * 每轮重新读取项目指令与可自动注入的项目记忆。
   *
   * 项目规则可能在 Agent 工作期间被修改，不能只在引擎启动时读取一次。
   * 任一来源读取失败都 fail-open，避免非关键上下文阻断主对话。
   */
  private async loadProjectPromptContext(): Promise<{
    projectRules: string;
    projectMemory: string;
  }> {
    const { config, options } = this.ctx;
    const projectRulesPromise = loadProjectDoc(options.cwd, config.projectDoc)
      .catch((error) => {
        logger.warn('ChatBridge: project instructions load failed (fail-open)', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

    const projectMemoryPromise = config.projectMemory.enabled && config.projectMemory.autoInject
      ? new ProjectMemoryManager(options.cwd, config.projectMemory)
          .getSummary()
          .catch((error) => {
            logger.warn('ChatBridge: project memory load failed (fail-open)', {
              error: error instanceof Error ? error.message : String(error),
            });
            return '';
          })
      : Promise.resolve('');

    const [projectRules, memorySummary] = await Promise.all([
      projectRulesPromise,
      projectMemoryPromise,
    ]);

    return {
      projectRules: projectRules ?? '',
      projectMemory: memorySummary === '（暂无项目记忆）' ? '' : memorySummary,
    };
  }

  /**
   * Phase 96 P0-1：应用启动时加载历史对话
   * 由 engine-bridge.initialize() 调用，fail-open（加载失败返回空数组）
   */
  async loadHistoryOnStart(): Promise<void> {
    try {
      const history = await this.persistence.load();
      if (history.length > 0) {
        this.ctx.conversationHistory = history;
        logger.info('ConversationPersistence: history restored', {
          messages: history.length,
        });
      }
    } catch (err) {
      logger.warn('ConversationPersistence: loadHistoryOnStart failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Phase 96 P0-1：应用退出前强制持久化
   * 由 engine-bridge.destroy() 调用，跳过防抖立即写盘
   * fail-open，写入失败不阻塞退出
   */
  async flushOnShutdown(): Promise<void> {
    try {
      await this.persistence.flush(this.ctx.conversationHistory);
    } catch (err) {
      logger.warn('ConversationPersistence: flushOnShutdown failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async sendChat(text: string, remoteContext?: RemoteTurnContextInput): Promise<void> {
    // G-004 修复：每次 sendChat 生成唯一 requestId，用于隔离 abortController 和 pendingConfirm，
    // 避免并发 sendChat 互相覆盖导致中断错乱和工具确认张冠李戴
    const requestId = remoteContext?.turnId
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const { deps, classifier, modelRouter, tracker, clientManager, options, config } = this.ctx;
    const stream = new ChatStreamEventPublisher(
      this.ctx.eventHub,
      createRemoteTurnContext(remoteContext),
      (payload) => options.onStream(payload),
    );
    stream.start(text);
    if (!deps || !classifier || !modelRouter || !tracker || !clientManager) {
      // F-014 修复：引擎未就绪时补发 done 事件，避免渲染层永久 loading
      stream.emit({ type: 'error', error: '引擎未初始化' });
      stream.emit({ type: 'done' });
      return;
    }

    // Phase 54：拦截 /goal 命令——交由 GoalRunner 执行目标分解 + 多 Agent 协作
    // 之前 /goal 被当普通文本发给 LLM，导致命令不生效
    const trimmed = text.trim();
    if (trimmed.startsWith('/goal')) {
      await this.executeCommand(text);
      stream.emit({ type: 'done' });
      return;
    }

    // 把以下变量提到 try 外，便于 finally 块中生成 trajectory 汇总和微摘要
    // 与 chat-runner.ts 顶部声明保持一致，确保删除 chat-runner 后 desktop 不丢失可观测性
    let hasTaskError = false;
    let accumulatedContent = '';

    let actualUserMessage = text;
    let routeDecision: RoutingResult | null = null;
    let trajectorySummary: TrajectorySummary | null = null;
    const modifiedFiles = new Set<string>();
    const pendingWrites = new Map<string, string>();
    const pendingTodoActions = new Map<string, unknown>();
    // Phase 97 Part B：记录本 turn 的工具调用（供 TurnSnapshot 联合快照）
    const toolCalls: { name: string; callId: string; approved: boolean }[] = [];
    // Phase 97 Part B：会话与 turn 标识（remote 优先，本地单会话默认 desktop-local）
    const turnId = requestId;
    const sessionId = remoteContext?.sessionId ?? 'desktop-local';

    try {
      const classifyResult = await classifier.classify({ query: text });
      // deterministic 走规则路径，currentTier 仅供 UI 显示，保持默认 'simple'
      if (classifyResult.tier !== 'deterministic') {
        this.ctx.currentTier = classifyResult.tier;
      }
      routeDecision = await modelRouter.route(classifyResult);
      const fallbackNotice = notifyRoutingFallback(routeDecision);
      if (fallbackNotice) {
        stream.emit({ type: 'progress', progress: { label: fallbackNotice, current: 0, total: 1 } });
      }
      this.ctx.currentModel = routeDecision.model.id;
      this.ctx.isDegraded = routeDecision.degraded;
      // Phase 70 修复：模型切换时同步更新 AutoCompactGuardian 的 contextWindow
      // 避免 Guardian 用旧模型窗口判断新模型的压缩时机
      if (typeof routeDecision.model.contextWindow === 'number') {
        deps.contextManager.updateAutoCompactContextWindow(routeDecision.model.contextWindow);
      }

      // 启动 Trace 会话
      deps.trace.startSession(text, routeDecision);

      const client = clientManager.get(routeDecision.providerId);
      if (!client || !client.isReady()) {
        // F-013 修复：provider 不可用时补发 done 事件，避免渲染层永久 loading
        stream.emit({
          type: 'error',
          error: `提供商 ${routeDecision.providerId} 不可用。请检查 API Key 配置。`,
        });
        stream.emit({ type: 'done' });
        return;
      }

      stream.emit({
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
      const loadedImages: ImageInput[] = (remoteContext?.images ?? []).map((image) => ({
        data: image.dataBase64,
        mediaType: image.mediaType,
        fileName: image.filename,
      }));
      if (imageRefs.length > 0 || loadedImages.length > 0) {
        for (const ref of imageRefs) {
          const img = await VisionAssistant.loadImage(ref, options.cwd);
          if (img) loadedImages.push(img);
        }
        if (loadedImages.length > 0) {
          stream.emit({
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
      const requestController = new AbortController();
      if (remoteContext?.schedulerSignal) {
        if (remoteContext.schedulerSignal.aborted) requestController.abort();
        else remoteContext.schedulerSignal.addEventListener('abort', () => requestController.abort(), { once: true });
      }
      this.ctx.setAbortController(requestId, requestController);
      let finalUsage: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      // Skill 渐进披露：这里只注入匹配结果的元数据与来源路径。
      // 模型确认需要后再用 file_read 读取 SKILL.md，避免每轮把多个完整 Skill
      // 塞入 system prompt，挤占项目规则、对话和工具结果的上下文空间。
      let skillPromptSuffix = '';
      if (deps.skillsRouter) {
        const routedSkills = deps.skillsRouter.route(actualUserMessage, 3);
        const explicitSkills = new Set(remoteContext?.skillIds ?? []);
        const matchedSkills = [
          ...deps.skillsRouter.listStatuses()
            .filter((skill) => skill.enabled && explicitSkills.has(skill.name)),
          ...routedSkills,
        ].filter((skill, index, all) =>
          all.findIndex((candidate) => candidate.name === skill.name) === index,
        ).slice(0, Math.max(3, explicitSkills.size));
        // 此时只是发现候选 Skill，尚未读取正文。
        if (matchedSkills.length > 0) {
          for (const skill of matchedSkills) {
            deps.usageCounter?.increment({ kind: 'pack', name: skill.name, action: 'discover' });
          }
        } else {
          deps.usageCounter?.increment({ kind: 'pack', name: '*', action: 'skip' });
        }
        if (matchedSkills.length > 0) {
          const skillBlocks = matchedSkills.map((s) =>
            `- ${s.name}: ${s.description}\n  来源: ${s.sourcePath}${s.whenToUse ? `\n  适用时机: ${s.whenToUse}` : ''}`,
          );
          skillPromptSuffix = `\n\n候选 Skill（尚未加载正文）：
${skillBlocks.join('\n')}
如果任务确实需要其中某项，先用 file_read 完整读取对应来源文件，再严格遵循；不需要则不要读取。`;
        }
      }

      const projectPromptContext = await this.loadProjectPromptContext();
      const registeredTools = deps.registry.list();
      const explicitlyRequestsMcp = /\bmcp\b/i.test(actualUserMessage);
      // B-01A：模型可见工具面由 resolveVisibleTools 解析——
      // 默认 coding 回合只暴露 core 工具（VFS/Plan 等 mode 工具与 deferred 低频工具不可见），
      // QA 回合只保留免审批工具；远程白名单与暴露元数据逐层生效。
      // 说明：deniedTools 参数当前无生产调用方传入（deny 工具在执行层由权限引擎拦截），
      // 调用方有权限结果时可传入以提前从 schema 剔除。
      // 实现/调查任务按默认 core 面运行；用户显式点名 MCP 时 QA 回合也保留 MCP（镜像旧行为）。
      // P2（单一真相源）：boostedTools 直接进 resolver——渲染摘要与 adapter 的 schema
      // 共用同一可见面规则（tool_search 提升的工具两处同时可见）
      const boosted = deps.toolBoost?.names ?? new Set<string>();
      const toolsForThisRun = resolveVisibleTools(registeredTools, {
        mode: classifyResult.taskShape === 'qa' ? 'qa' : 'coding',
        taskShape: classifyResult.taskShape,
        mcpRequested: explicitlyRequestsMcp,
        allowedTools: remoteContext?.allowedToolNames
          ? new Set(remoteContext.allowedToolNames)
          : undefined,
        boostedTools: boosted.size > 0 ? boosted : undefined,
      });
      // P0 修复（复审）：allowedToolNames 只承载"硬白名单"语义（远程设备权限 /
      // 自动化 allowlist / 用户显式限制）。普通桌面对话不传——工具可见性完全交给
      // resolveVisibleTools + TurnToolBoost（每轮 adapter 重新解析）。
      // 此前把"初始可见工具全集"传进去会导致 tool_search 中途提升的工具被
      // loop 的静态 Set 过滤掉（提升成为空头承诺）。
      const allowedToolNames = remoteContext?.allowedToolNames;

      // Phase 97 Part I Task I2：UserProfile 字段引用计数（fail-open，渲染前记一次）
      // 供低触发评估：档案长期未被引用时提示用户更新或停用
      this.recordUserProfileHit();

      const executionContext = createDefaultExecutionContext(sessionId, {
        triggerSource: remoteContext?.triggerSource ?? (remoteContext ? 'remote' : 'user'),
        permissionMode: remoteContext?.autonomyMode ?? config.autonomy.defaultMode,
        ...(remoteContext?.workspaceId ? { workspaceId: remoteContext.workspaceId } : {}),
      });
      // Phase 96+ B4：前缀缓存优化——拆分固定前缀与可变后缀为 systemBlocks
      // B-02A：稳定区（身份/执行纪律/工具协议，跨会话不变）打 cache_control，
      // 动态区（项目规则/记忆/会话/任务形状）+ 路由决策作为独立块追加，
      // 避免项目上下文与路由决策变化导致整个系统提示缓存失效。
      // 工具参数只存在于 function calling schema；系统提示仅保留能力组摘要（不再复述描述）。
      const renderedZones = await deps.prompts.renderPromptZones('main.system', {
        language: config.general.language === 'zh-CN' ? '中文' : 'English',
        autonomyMode: remoteContext?.autonomyMode ?? config.autonomy.defaultMode,
        availableTools: summarizeToolsForPrompt(
          toolsForThisRun.map((tool) => ({ name: tool.definition.name, category: tool.definition.category })),
        ),
        projectRules: projectPromptContext.projectRules,
        projectMemory: projectPromptContext.projectMemory,
        cwd: options.cwd,
        // C3：传入 taskShape 让 <task_shape_guidance> 提示生效
        // taskShape 仅 4 种值（single-step/multi-step-impl/investigation/qa），
        // 相比 routeDecision 稳定；Anthropic ephemeral cache 5 分钟窗口内 4 种值都会被缓存
        taskShape: classifyResult.taskShape ?? 'single-step',
        // Phase 97 Part I：轻量用户档案进入系统提示词（空档案渲染为空，安全降级）
        userProfile: renderUserProfile(config.userProfile ?? null),
      });
      const runParams: ReActRunParams = {
        requestId,
        userMessage: actualUserMessage,
        llmClient: client,
        routeDecision,
        conversationHistory: this.ctx.conversationHistory,
        // Phase 97 Part A Task A4：透传执行上下文——触发来源按调用方显式透传
        // （automation 调度 / remote 远程 / user 本地；requestId 作为会话槽位）
        context: executionContext,
        // 修复 8（复审）：DeepSeek 思考强度按任务形状确定性映射（官方建议
        // 复杂 Agent 任务用 max）——qa/单步实现 high，多步/调查/失败重试 max
        reasoningEffort: reasoningEffortForTaskShape(classifyResult.taskShape),
        maxTokens: maxTokensForTaskShape(classifyResult.taskShape),
        systemBlocks: [
          {
            type: 'text',
            text: renderedZones.stable,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: `${renderedZones.dynamic}\n\n当前路由决策：${routeDecision.model.id} (${routeDecision.originalTier})${skillPromptSuffix}`,
          },
          // Phase 97 Part G：结构化引用上下文——用户输入中的显式引用（文件/会话/任务）
          // 解析为结构化文本注入，而非把原始符号拼进 prompt
          ...(this.buildReferenceContext(actualUserMessage)),
        ] as SystemBlock[],
        // G-004：从 Map 取该 requestId 对应的 signal，避免读到其他并发请求的 controller
        signal: this.ctx.getAbortController(requestId)?.signal,
        // 传递当前自主度模式给权限中间件
        autonomyMode: remoteContext?.autonomyMode ?? config.autonomy.defaultMode,
        allowedToolNames,
        onConfirmTool: async (toolName, args) => {
          // 根据当前自主度模式决定是否需要用户确认
          // auto（全自动）：所有工具调用直接批准，不弹确认框
          // semi（半自动）/ manual（手动确认）：弹确认框等待用户操作
          // 注意：实时读取 this.ctx.config，与原 RouteDevEngine 读 this.config 一致，
          // 确保 sendChat 期间 updateConfig 修改的自主度对后续工具确认立即生效
          const currentMode = remoteContext?.autonomyMode
            ?? this.ctx.config.autonomy.defaultMode;
          if (currentMode === 'auto' && toolName !== 'ask_user') {
            return true;
          }
          // 自动化任务预授权：allowlist 非空且能力匹配时免确认（白名单而非 bypassPermissions——
          // 白名单外工具仍走正常确认流，危险操作仍被 SecurityChecker 硬拒绝）
          const allowlist = remoteContext?.allowlist;
          if (allowlist && allowlist.length > 0 && isPreAuthorized(toolName, args, allowlist)) {
            return true;
          }
          return this.requestUserConfirmation(requestId, toolName, args, stream);
        },
      };
      const kernel = deps.agentKernel;
      if (!kernel.runReAct) {
        throw new Error('AgentKernel 未提供生产 ReAct 适配路径');
      }
      for await (const event of kernel.runReAct(executionContext, runParams)) {
        switch (event.type) {
        case 'text_delta':
          accumulatedContent += event.text;
          stream.emit({ type: 'text_delta', chunk: event.text });
          break;

        case 'reasoning_delta':
          // 转发推理过程增量，供前端显示模型思考过程
          stream.emit({ type: 'reasoning_delta', reasoning: event.text });
          break;
        case 'thinking':
          // 这是循环状态的合成文案，不是模型输出；真实进度由
          // reasoning_delta/text_delta 按实际到达顺序展示。
          break;
        case 'escalation':
          // 达到 maxIterations 等情况下的升级事件：转发给前端显示中断原因
          // 不标记 hasTaskError（这不是错误，是预算耗尽）
          stream.emit({
            type: 'escalation',
            reason: event.reason,
            iterations: event.iterations,
          });
          break;
          case 'tool_call_start': {
            const filePath = event.args?.path;
            if ((event.toolName === 'file_write' || event.toolName === 'file_edit') && typeof filePath === 'string') {
              pendingWrites.set(event.toolCallId, filePath);
            }
            if (event.toolName === 'todo_write') {
              pendingTodoActions.set(event.toolCallId, event.args?.action);
            }
            // Phase 97 Part B：能走到 tool_call_start 说明工具已获批准执行
            toolCalls.push({ name: event.toolName, callId: event.toolCallId, approved: true });
            stream.emit({
              type: 'tool_start',
              toolName: event.toolName,
              toolArgs: event.args,
              toolCallId: event.toolCallId,
            });
            break;
          }
          case 'tool_call_delta': {
            // Phase 96 P1-1：工具执行增量输出（shell_exec 等长任务的实时 stdout/stderr）
            stream.emit({
              type: 'tool_call_delta',
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              chunk: event.chunk,
            });
            break;
          }
          case 'tool_call_result': {
            const filePath = pendingWrites.get(event.toolCallId);
            if (filePath && !event.isError) modifiedFiles.add(filePath);
            pendingWrites.delete(event.toolCallId);
            stream.emit({
              type: 'tool_done',
              toolName: event.toolName,
              toolResult: event.result,
              isError: event.isError,
              toolCallId: event.toolCallId,
            });
            if (event.toolName === 'todo_write') {
              stream.publishTodoResult(
                pendingTodoActions.get(event.toolCallId),
                event.result,
                event.isError,
              );
              pendingTodoActions.delete(event.toolCallId);
            }
            break;
          }
          case 'error':
            // 标记任务错误状态，用于 finally 块生成 trajectory summary 和微摘要时判定 success/failure
            hasTaskError = true;
            stream.emit({ type: 'error', error: event.error });
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
      // Phase 96+ A3.3：缓存命中统计——在 tracker.record 之后同步更新 cacheStatsTracker
      // provider 取自 routeDecision.providerId（DeepSeek/OpenAI/Anthropic 等），归一化多 Provider 缓存字段
      // P0 修复（复审）：DeepSeek 原生 prompt_cache_hit_tokens/miss_tokens 优先；
      // Anthropic 的 cacheReadInputTokens 为回退（此前只读 Anthropic 字段，
      // DeepSeek 真实缓存率被永远记成 hit=0/miss=全部）
      const cacheHit = finalUsage.cacheHitTokens ?? finalUsage.cacheReadInputTokens ?? 0;
      const cacheMiss = finalUsage.cacheMissTokens ?? Math.max(0, finalUsage.inputTokens - cacheHit);
      this.ctx.cacheStatsTracker?.record(cacheHit, cacheMiss, routeDecision.providerId ?? 'unknown');
      // CONCERN 修复：CircuitBreaker 接入——Agent Loop 成功完成时重置模型失败计数
      // 与 chat-runner.ts 内层 try 末尾的 recordModelSuccess 对齐
      modelRouter.recordModelSuccess(routeDecision.model.id);

      let gateResult: GateResult | undefined;
      // B-04：触发条件改为"本 turn 有文件修改"，不再依赖用户是否说出测试/构建关键词。
      // 变更类型的最小验证由 CompletionGate 内部按项目配置探测（typecheck/lint）；
      // 高成本全量测试仅在用户显式要求（命中验证关键词）时运行。
      if (!hasTaskError && modifiedFiles.size > 0) {
        stream.emit({ type: 'progress', progress: { label: '正在验证代码', current: 2, total: 3 } });
        try {
          gateResult = await deps.completionGate.verify({
            modifiedFiles: [...modifiedFiles],
            projectPath: options.cwd,
            planDescription: text,
            includeTests: VERIFY_REQUEST_PATTERN.test(text),
          });
          if (!gateResult.passed) {
            const failed = gateResult.checks.filter((check) => !check.ok && !check.skipped)
              .map((check) => check.name).join('、');
            stream.emit({ type: 'progress', progress: { label: `代码验证未通过${failed ? `：${failed}` : ''}`, current: 3, total: 3 } });
          }
        } catch (error) {
          gateResult = { passed: true, checks: [], warnings: [error instanceof Error ? error.message : String(error)] };
        }
      }

      stream.emit({ type: 'progress', progress: { label: '完成', current: 3, total: 3 } });
      const completionStatus = toCompletionStatus(gateResult, !hasTaskError);

      this.ctx.conversationHistory.push({ role: 'user', content: actualUserMessage });
      // 仅持久化最终文本（DeepSeek 官方：无工具调用的最终 assistant reasoning
      // 在下一轮可忽略；把全程 reasoning 拼接挂到最终消息是错误语义）。
      // 完整工具轨迹持久化（assistant 推理+工具轮次 + tool_result 链）见技术债 TD-21。
      this.ctx.conversationHistory.push({ role: 'assistant', content: accumulatedContent });
      if (this.ctx.conversationHistory.length > 20) {
        this.ctx.conversationHistory = this.ctx.conversationHistory.slice(-20);
      }

      // Checkpoint 与自动压缩解耦：checkpoint 仅在开关开启时写盘
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
            stream.emit({
              type: 'progress',
              progress: { label: `记忆已保存: ${cp.currentIntent}`, current: 3, total: 3 },
            });
          }
        }
      }

      // 自动上下文压缩：不依赖 checkpoint 开关；优先 compressEnhanced，失败降级 compress
      const estimatedTokensCount = this.ctx.conversationHistory.reduce((acc, msg) => {
        const t = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return acc + estimateTokens(t);
      }, 0);
      const compressDecision = deps.contextManager.shouldCompressEnhanced(
        this.ctx.conversationHistory.length,
        estimatedTokensCount,
      );
      if (compressDecision.should) {
        try {
          const { compressed, result } = await deps.contextManager.compressEnhanced(
            this.ctx.conversationHistory,
            { offloadDir: path.join(options.cwd, '.routedev', 'offloaded') },
          );
          if (
            result.messagesCompressed > 0 ||
            result.offloadedOutputs > 0 ||
            result.tokensAfter < result.tokensBefore
          ) {
            this.ctx.conversationHistory = compressed;
            stream.emit({
              type: 'progress',
              progress: {
                label: `上下文已压缩: ${result.tokensBefore} → ${result.tokensAfter} tokens`,
                current: 3,
                total: 3,
              },
            });
          }
        } catch {
          try {
            const { compressed, result } = deps.contextManager.compress(this.ctx.conversationHistory);
            this.ctx.conversationHistory = compressed;
            stream.emit({
              type: 'progress',
              progress: {
                label: `上下文已压缩: ${result.originalCount} → ${result.compressedCount} 条`,
                current: 3,
                total: 3,
              },
            });
          } catch (innerErr) {
            // Phase 96 M-2 修复：双重压缩都失败时记日志，避免无任何诊断信息
            // 不阻塞主流程，对话继续以未压缩历史进行
            logger.warn('chat-bridge: compressEnhanced + compress 双重压缩均失败，跳过压缩', {
              error: innerErr instanceof Error ? innerErr.message : String(innerErr),
              historyLength: this.ctx.conversationHistory.length,
            });
          }
        }
      }
      // Completion is the final ordered timeline event. Checkpoint and
      // compaction progress must never appear after turn.completed.
      stream.emit({ type: 'done', completionStatus });
    } catch (err) {
      // CONCERN 修复：CircuitBreaker 接入——路由或 Agent Loop 抛异常时记录模型失败
      // 与 chat-runner.ts 两层 catch 中的 recordModelFailure 对齐（routeDecision 可能为 null）
      if (routeDecision?.model?.id) modelRouter.recordModelFailure(routeDecision.model.id);
      stream.emit({
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      stream.emit({ type: 'done' });
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
          logger.warn('[Engine] failed to log trajectory summary', { error: err instanceof Error ? err.message : String(err) });
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
            stream.emit({ type: 'micro_summary', microSummary });
          }
        } catch (err) {
          logger.warn('[Engine] failed to generate micro summary', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // F-004：结束 Trace 会话，触发 .session.json/.spans.json 落盘
      // 落盘失败仅 log，不影响主链路
      if (deps?.trace && routeDecision) {
        try {
          await deps.trace.endSession();
        } catch (err) {
          logger.warn('[Engine] trace endSession failed', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Phase 96 P0-1：持久化最新对话历史（防抖写入）
      // 无论成功/失败/压缩与否，都保存当前 ctx.conversationHistory 的最新快照
      // 错误分支下 history 可能未更新，保存的是上一次状态（符合预期）
      this.persistence.save(this.ctx.conversationHistory);

      // Phase 97 Part B：turn 结束后捕获联合快照（对话级撤销用）
      // 快照仅记录授权边界内文件的内容/hash，捕获失败不阻塞主链路
      try {
        const ws = this.ctx.deps?.workspaceManager;
        const wsId = ws?.getActiveWorkspaceId() ?? undefined;
        const boundary = ws && wsId ? ws.getAllowedRoots(wsId) : [];
        await this.turnSnapshotManager.capture({
          turnId,
          sessionId,
          userMessage: actualUserMessage,
          agentOutput: accumulatedContent,
          toolCalls,
          changedFiles: [...modifiedFiles],
          workingDirectory: options.cwd,
          attachmentBoundary: boundary ?? [],
        });
      } catch (err) {
        logger.warn('chat-bridge: turn snapshot capture failed (fail-open)', {
          error: err instanceof Error ? err.message : String(err),
          turnId,
        });
      }
    }
  }

  /**
   * Phase 97 Part B：列出快照（供 UI 对话级撤销入口展示）
   * sessionId 缺省时返回全部会话快照（按时间倒序）
   */
  listTurnSnapshots(sessionId?: string): Promise<import('../../../src/harness/turn-snapshot.js').TurnSnapshot[]> {
    return this.turnSnapshotManager.list(sessionId);
  }

  /**
   * Phase 97 Part G：解析输入框结构化引用（/ @ & ~ 前缀 + accessScope 校验）
   * 供 composer:resolve IPC 使用；解析失败返回空数组（fail-open）
   */
  resolveComposerRefs(text: string): import('../../../src/agent/context/composer-reference.js').ComposerReference[] {
    const ws = this.ctx.deps?.workspaceManager;
    const wsId = ws?.getActiveWorkspaceId() ?? undefined;
    const workspace = ws && wsId ? ws.getWorkspace(wsId) : undefined;
    return parseComposerReferences(text, {
      cwd: this.ctx.options.cwd,
      workspaceRoot: workspace?.projectRoot,
      attachedRoots: [
        ...(workspace?.attachedDirectories ?? []),
        ...(workspace?.attachedFiles ?? []),
      ],
    });
  }

  /**
   * Phase 97 Part G：构建结构化引用上下文块（供 systemBlocks 注入）
   * 引用解析结果转为可读文本；无引用时返回空数组（零开销）
   */
  private buildReferenceContext(text: string): import('../../../src/agent/loop.js').SystemBlock[] {
    try {
      const refs = this.resolveComposerRefs(text);
      if (refs.length === 0) return [];
      const lines = refs.map((r) => {
        const scope = r.accessScope === 'workspace' ? '工作区' : r.accessScope === 'attached' ? '附加目录' : '系统';
        return `- [${r.type}] ${r.displayName}（${scope}${r.resolvedPath ? `，${r.resolvedPath}` : ''}）`;
      });
      return [{
        type: 'text',
        text: `用户输入中显式引用的上下文：\n${lines.join('\n')}\n请优先基于这些引用完成任务；引用仅作上下文提示，不替代任务指令。`,
      }];
    } catch (err) {
      logger.debug('chat-bridge: buildReferenceContext failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Phase 97 Part I Task I2：UserProfile 字段引用计数
   *
   * 每轮渲染系统提示词前记录一次 userProfile 引用，
   * 供低触发评估（档案长期未被引用时提示更新或停用）。
   * fail-open：deps 未初始化或 hitStat 未装配时静默跳过。
   */
  private recordUserProfileHit(): void {
    try {
      this.ctx.deps?.hitStat?.record('userProfile', 'userProfile');
    } catch (err) {
      logger.debug('chat-bridge: recordUserProfileHit failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Phase 97 Part B：恢复指定 turn 的快照（对话级撤销：回退对话时同步恢复文件）
   * @returns 恢复结果；快照不存在返回 null
   */
  restoreTurn(
    turnId: string,
    sessionId?: string,
  ): Promise<import('../../../src/harness/turn-snapshot.js').RestoreResult | null> {
    return this.turnSnapshotManager.restore(turnId, sessionId ?? 'desktop-local');
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
    stream: ChatStreamEventPublisher,
  ): Promise<boolean | { approved: boolean; payload?: unknown }> {
    // V2-T02 修复：添加 60s 超时机制，防止用户不响应时 Promise 永不 resolve
    const timeoutMs = 60_000;
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
    stream.publishApprovalRequired(requestId, toolName, args, expiresAt);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 超时视为拒绝，清理 pendingConfirm 防止后续 resolveToolConfirm 误触已 resolve 的 Promise
        this.ctx.clearPendingConfirm(requestId);
        logger.warn('requestUserConfirmation 超时', { requestId, toolName, timeoutMs });
        stream.publishApprovalResolved(requestId, false, 'desktop');
        resolve(false);
      }, timeoutMs);
      // 包装 resolve：实际确认到达时先清除 timer 再 resolve，避免超时与确认竞争
      const wrappedResolve = (
        value: boolean | { approved: boolean; payload?: unknown },
        resolvedBy: 'desktop' | 'android' = 'desktop',
      ) => {
        clearTimeout(timer);
        const approved = typeof value === 'boolean' ? value : value.approved;
        stream.publishApprovalResolved(requestId, approved, resolvedBy);
        resolve(value);
      };
      // G-004：按 requestId 存入 Map，避免并发覆盖
      this.ctx.setPendingConfirm(requestId, { resolve: wrappedResolve, toolName });
      // Phase 97 Part C：登记到统一中断队列（requestId 作为会话槽位，供 reclaim/abort 兜底）
      this.interruptionBroker.submit(
        'permission_request',
        requestId,
        { toolName, args, reason: '需要确认工具调用' },
        (resolution) => wrappedResolve({ approved: resolution.approved, payload: resolution.payload }),
      );
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
  resolveToolConfirm(
    requestId: string,
    approved: boolean,
    payload?: unknown,
    resolvedBy: 'desktop' | 'android' = 'desktop',
  ): void {
    const entry = this.ctx.getPendingConfirm(requestId);
    if (entry) {
      entry.resolve({ approved, payload }, resolvedBy);
      this.ctx.clearPendingConfirm(requestId);
    }
    // Phase 97 Part C：同步统一中断队列（存在则解析，不存在静默跳过）
    this.interruptionBroker.resolve(requestId, { approved, payload });
  }

  /**
   * Phase 97 Part C：重新取回未处理中断（渲染层重载后恢复用）
   * @param sessionId 可选，按会话过滤；不传返回全部 pending 中断
   */
  reclaimInterruptions(sessionId?: string): Interruption[] {
    return this.interruptionBroker.reclaim(sessionId);
  }

  /** Phase 97 Part C：列出中断（可按会话过滤，含超时自动标记） */
  listInterruptions(sessionId?: string): Interruption[] {
    return this.interruptionBroker.list(sessionId);
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
      // Phase 97 Part C：统一中断队列同步中止该会话的未处理中断
      this.interruptionBroker.abortSession(requestId);
    } else {
      // G-004：无 requestId 时中断全部并发请求（向后兼容）
      this.ctx.clearAllAbortControllers();
      this.ctx.clearAllPendingConfirms();
      // Phase 97 Part C：统一中断队列全量中止
      this.interruptionBroker.abortAll();
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
    // Phase 97 Part A Task A3：内核插槽 abort 消费点（routedev-native 薄适配）
    // 有活跃 run 时中止；无活跃 run 时由内核记为 pending，该会话下次 run 启动立即中止
    // fail-open：内核未装配或调用异常不影响现有停止流程
    try {
      const kernel = this.ctx.deps?.agentKernel;
      if (kernel) {
        if (requestId) {
          void kernel.abort(requestId);
        } else {
          for (const sessionId of kernel.listSessions()) {
            void kernel.abort(sessionId);
          }
        }
      }
    } catch (err) {
      logger.warn('agentKernel.abort failed (fail-open)', { error: err instanceof Error ? err.message : String(err) });
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
      logger.error('[Engine] 生成标题失败', { error: err instanceof Error ? err.message : String(err) });
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
      // Phase 96 P0-1：清空持久化文件，避免重启后恢复已清空的对话
      this.persistence.clear().catch((err) => {
        logger.warn('ConversationPersistence: clear failed on /clear', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
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
        const history = this.ctx.conversationHistory;
        const estimateHistoryTokens = (messages: typeof history) => messages.reduce((total, message) => {
          const content = typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content);
          return total + estimateTokens(content);
        }, 0);
        try {
          const { compressed, result } = await deps.contextManager.compressEnhanced(
            history,
            {
              offloadDir: path.join(options.cwd, '.routedev', 'offloaded'),
              force: true,
              preserveLast: 4,
            },
          );
          this.ctx.conversationHistory = compressed;
          this.persistence.save(compressed);
          return {
            ok: true,
            message: `上下文已压缩：${result.tokensBefore} → ${result.tokensAfter} tokens` +
              (result.messagesCompressed > 0 ? `（摘要 ${result.messagesCompressed} 条）` : '') +
              (result.offloadedOutputs > 0 ? `，卸载 ${result.offloadedOutputs} 条工具输出` : ''),
            compaction: {
              tokensBefore: result.tokensBefore,
              tokensAfter: result.tokensAfter,
              messagesCompressed: result.messagesCompressed,
              offloadedOutputs: result.offloadedOutputs,
            },
          };
        } catch (enhancedError) {
          logger.warn('Enhanced manual context compression failed; falling back', {
            error: enhancedError instanceof Error ? enhancedError.message : String(enhancedError),
          });
          const tokensBefore = estimateHistoryTokens(history);
          const { compressed, result } = deps.contextManager.compress(history);
          const tokensAfter = estimateHistoryTokens(compressed);
          this.ctx.conversationHistory = compressed;
          this.persistence.save(compressed);
          return {
            ok: true,
            message: `上下文已压缩：${result.originalCount} → ${result.compressedCount} 条`,
            compaction: {
              tokensBefore,
              tokensAfter,
              messagesCompressed: Math.max(0, result.originalCount - result.compressedCount),
              offloadedOutputs: 0,
            },
          };
        }
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
    logger.info('[Engine] 对话历史已同步', { count: this.ctx.conversationHistory.length });
    // Phase 96 P0-1：外部同步后立即持久化，避免重启丢失
    this.persistence.save(this.ctx.conversationHistory);
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
      logger.warn('[Engine] agentLoop 未就绪，followUp 调用被忽略');
      return false;
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      logger.warn('[Engine] followUp 内容为空，调用被忽略');
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
      logger.warn('[Engine] agentLoop 未就绪，clearAllQueues 调用被忽略');
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
      logger.warn('[Engine] agentLoop 未就绪，setFollowUpMode 调用被忽略');
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
