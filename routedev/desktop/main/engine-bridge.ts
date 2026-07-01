// desktop/main/engine-bridge.ts
// 核心引擎桥接：把 CLI 的 App 依赖工厂包装成主进程可直接调用的服务

import type { AppConfig } from '../../src/config/schema.js';
import type { LLMMessage, ScenarioTier } from '../../src/router/types.js';
import { LLMClientManager } from '../../src/router/llm/index.js';
import { TokenTracker } from '../../src/router/tracker.js';
import { ScenarioClassifier } from '../../src/router/classifier.js';
import { ModelRouter } from '../../src/router/router.js';
import { buildRouterConfig } from '../../src/router/config.js';
import { createAppDependencies } from '../../src/cli/app-init.js';
import type { AppDependencies } from '../../src/cli/app-init.js';
import type { ChatStreamPayload, MCPStatus, MCPConnectionResult, MCPInstallResult, MCPInstallPayload, SkillInstallPayload, AgentProfileInfo, AgentProfileDetail, ProfileSavePayload, ProfileOpResult, GoalEvent, PlanEditRequestPayload } from '../shared/ipc-types.js';
import type { TokenProfileSnapshot } from '../../src/agent/token-profiler.js';
import { VisionAssistant, type ImageInput } from '../../src/agent/vision.js';
import { notifyRoutingFallback } from '../../src/cli/notification.js';
import { estimateTokens } from '../../src/utils/token-estimate.js';
import type { TraceSpan } from '../../src/harness/trace-types.js';
import type { SkillStatus } from '../../src/plugins/filesystem-discovery.js';
import { getCatalogEntry } from './mcp-catalog.js';
import type { MCPServerEntry } from '../../src/tools/mcp/types.js';
import path from 'node:path';
import { ExperimentManager } from '../../src/harness/experiment-manager.js';
import { HookConfigRegistry } from '../../src/hooks/registry.js';
import type { HookConfig } from '../../src/hooks/registry.js';
import { getHookTemplates, getHookTemplateById } from '../../src/hooks/templates.js';
import type { HookTemplate } from '../../src/hooks/templates.js';
// C3 修复：Hook 命令安全扫描
import { checkBashSecurity } from '../../src/tools/security-enhanced.js';
import type { Checkpoint } from '../../src/harness/types.js';
// Phase 54：GoalRunner 接入——Electron 端 /goal 命令实际执行入口
import { createGoalRunner } from '../../src/cli/goal-runner.js';
import type { GoalPlan, PlanStep } from '../../src/agent/goal-types.js';
// Phase 37 Skill 市场接线：复用 SkillMarketManager 的 install 能力
import { SkillMarketManager } from '../../src/skills/market-manager.js';
// Phase 53 Task 6：安装前安全门控（仅类型，运行时按需动态 import）
import type { SkillSecurityGate } from '../../src/skills/security-gate.js';
// Phase 48 Task 4 接线修复：AgentProfileManager 用于 UI 编辑 Profile
import { AgentProfileManager } from '../../src/agents/profiles/manager.js';
import type { AgentProfile } from '../../src/agents/profiles/types.js';

/**
 * Phase 54：判断是否为 goal-runner 输出的进度文本（已被 GoalExecutionCard 取代）
 * Electron 端 addSystemMessage 过滤这些文本，避免对话流出现"一大坨文字"
 * 保留错误/用法类文本（如 "❌ 错误: 提供商不可用"、"❌ 用法: /goal ..."）
 */
function isGoalProgressText(content: string): boolean {
  // Phase 54 修复：过滤器曾遗漏 14 类前缀（🔬/✅ 代码/⚠️ 代码/❌ 补救/✅ 补救/🧠/⏭/🔄/❌ 迭代/📋 补救/⚠️ 编排/✅ [/📝/⚠️ 模型回退|降级）
  // 并误杀最终完成摘要（┌─ ✅ 目标完成）——收窄 ┌─ 为 ┌─ 目标: 只匹配过程进度框
  const prefixes = [
    '🎯', '📋 计划', '📋 编排', '📋 补救', '✅ 计划', '✅ 步骤', '✅ 迭代', '✅ 验证',
    '✅ 代码', '✅ 补救', '✅ [', '❌ 步骤', '❌ [', '❌ 补救', '❌ 迭代',
    '⚠️ 验证', '⚠️ 迭代', '⚠️ 任务级', '⚠️ 代码', '⚠️ 编排',
    '⚠️ 模型回退', '⚠️ 模型降级',
    '▶', '🔍', '📐', '⚙️', '🎭', '📦', '💾', '⏸', '📊', '⏹', '⏭', '🔄', '🧠', '🔬', '📝',
    // 过程进度框：┌─ 目标: ...（不含最终完成摘要 ┌─ ✅ 目标完成）
    '┌─ 目标:', '│', '└─',
  ];
  return prefixes.some(p => content.startsWith(p));
}

/** GoalRunner 实例类型（goal-runner.ts 未导出类型，用 ReturnType 推导） */
type GoalRunner = ReturnType<typeof createGoalRunner>;

/** Skill 信息（IPC 传输用，剥离 content 避免大对象） */
export interface SkillInfo {
  name: string;
  description: string;
  routingKeywords: string[];
  enabled: boolean;
  sourcePath: string;
}

/** Skill 预览结果（含完整 content） */
export interface SkillPreview extends SkillInfo {
  content: string;
}

/** MCP 工具信息（IPC 传输用） */
export interface MCPToolInfo {
  /** 工具全名（含命名空间前缀 mcp__serverId__toolName） */
  name: string;
  /** 工具描述 */
  description: string;
  /** 所属 MCP 服务器 ID */
  serverId: string;
}

export interface EngineBridgeOptions {
  cwd: string;
  onStream: (payload: ChatStreamPayload) => void;
  onTokenProfile?: (snapshot: TokenProfileSnapshot) => void;
  onToolConfirmRequest: (toolName: string, params: Record<string, unknown>) => void;
  onConfigReloaded?: (config: AppConfig) => void;
  /** Trace 事件回调：每次 TraceCollector 记录 span 时触发 */
  onTraceEvent?: (span: TraceSpan) => void;
  /** Phase 54：Goal 执行结构化事件回调（驱动渲染层 GoalExecutionCard 就地刷新） */
  onGoalEvent?: (event: GoalEvent) => void;
  /**
   * Phase 54：计划编辑请求回调（semi/manual 模式触发 StepEditor）
   * 主进程通过此回调把 plan 推送到渲染层，渲染层编辑后通过 plan:edit-response 回传
   */
  onPlanEditRequest?: (requestId: string, plan: PlanEditRequestPayload['plan']) => void;
}

/**
 * RouteDev 核心引擎封装
 * 生命周期：initialize() -> sendChat() / executeCommand() / ... -> destroy()
 */
export class RouteDevEngine {
  private config: AppConfig;
  private options: EngineBridgeOptions;
  private deps: AppDependencies | null = null;
  private clientManager: LLMClientManager | null = null;
  private classifier: ScenarioClassifier | null = null;
  private modelRouter: ModelRouter | null = null;
  private tracker: TokenTracker | null = null;
  private conversationHistory: LLMMessage[] = [];
  // Phase 48 Task 4：AgentProfileManager 实例（在 initialize() 中创建，懒加载避免阻塞启动）
  private profileManager: AgentProfileManager | null = null;
  // Phase 54 修复：工具确认共享 ref——sendChat 和 GoalRunner 用同一个 ref
  // 原缺陷：GoalRunner 传入独立的 { current: null }，与 this.pendingConfirm 不共享，
  // 导致 GoalRunner 内部设置 pendingConfirmRef.current 后，resolveToolConfirm 读 this.pendingConfirm 为 null，
  // resolve 永远不被调用，Worker 卡死在工具确认处
  private pendingConfirmRef: { current: { resolve: (result: boolean | { approved: boolean; payload?: unknown }) => void; toolName: string } | null } = { current: null };
  // Phase 54 修复：中断控制器共享 ref——sendChat 和 GoalRunner 用同一个 ref
  // stopGeneration 时 abort 共享 ref，GoalRunner 步骤循环检测到 aborted 后中止
  private abortControllerRef: { current: AbortController | null } = { current: null };
  private abortController: AbortController | null = null;
  private currentModel = '';
  private currentTier: ScenarioTier = 'simple';
  private isDegraded = false;
  /**
   * Phase 54：GoalRunner 实例（懒初始化）
   * 首次执行 /goal 命令时创建，复用 deps/classifier/modelRouter/clientManager/tracker
   * addSystemMessage 通过 onStream(text_delta) 推送到渲染进程
   */
  private goalRunner: GoalRunner | null = null;
  /**
   * Phase 54：计划编辑请求的 resolver Map（按 requestId 索引）
   * requestPlanEdit 发送 IPC 请求后存入 resolver，resolvePlanEdit 收到响应时取出并 resolve
   * 渲染层 StepEditor 确认/取消 → IPC plan:edit-response → resolvePlanEdit → goal-runner Promise
   */
  private pendingPlanEditResolvers: Map<string, (result: PlanEditRequestPayload['plan']['steps'] | null) => void> = new Map();

  constructor(config: AppConfig, options: EngineBridgeOptions) {
    this.config = config;
    this.options = options;
  }

  async initialize(): Promise<void> {
    // 清理旧的 trace 监听器与 deps 资源，避免 reload 后事件成倍增长或资源泄漏
    if (this.deps) {
      // 旧 TraceCollector 的回调置空，避免旧实例继续向渲染进程推送事件
      this.deps.trace.onSpan(null);
      // 关闭旧 MCP 连接，防止句柄泄漏（异步执行，不阻塞初始化）
      this.deps.mcpManager.disconnectAll().catch(() => { /* 忽略清理错误 */ });
    }

    const clientManager = new LLMClientManager();
    clientManager.initializeFromConfig(
      this.config.providers.map((p) => ({
        id: p.id,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
      })),
    );
    this.clientManager = clientManager;

    const routerConfig = buildRouterConfig(this.config);
    this.tracker = new TokenTracker(routerConfig.budget);
    this.modelRouter = new ModelRouter(routerConfig, this.tracker, this.config.providers);

    const readyClients = clientManager.getReadyClients();
    const classifierClient = readyClients.length > 0 ? readyClients[0].client : undefined;
    this.classifier = new ScenarioClassifier({
      llmClient: classifierClient,
      classifierModel: routerConfig.classifierModel,
    });

    // 默认使用第一个模型的 id 初始化依赖
    const defaultModel = this.config.providers[0]?.models[0]?.id ?? '';
    // 接线修复：原实现只传 4 个参数，缺少 classifier/modelRouter/tracker，
    // 导致 AgentLoopStepExecutor 在 Electron 端回退到桩模式（步骤执行只返回"已执行（桩模式）"）。
    // 现补传上方已构造的实例，让 Electron 端与 CLI 端走相同的真实执行路径。
    this.deps = createAppDependencies(
      this.config,
      clientManager,
      defaultModel,
      this.options.cwd,
      this.classifier,
      this.modelRouter,
      this.tracker,
    );

    // Phase 47 Task 6：为 CheckpointManager 注入 LLM 客户端用于语义化摘要生成
    // 使用 checkpointClient（辅助模型）生成摘要，失败时 CheckpointManager 自动降级为原始 description
    const checkpointModelId = this.config.checkpoint.modelId || this.config.router.classifierModel || defaultModel;
    if (this.deps.checkpointClient) {
      this.deps.checkpointManager.setLLMClient(this.deps.checkpointClient, checkpointModelId);
    }

    // 桥接 TraceCollector：每次 span 创建/更新时推送给渲染进程
    if (this.options.onTraceEvent) {
      this.deps.trace.onSpan((span) => {
        this.options.onTraceEvent?.(span);
      });
    }

    // 自动连接已启用的 MCP 服务器（与 CLI App.tsx 行为一致）
    // fire-and-forget：不阻塞引擎初始化，连接失败只记录不抛出
    if (this.config.mcp.autoConnect) {
      const enabledServers = this.config.mcp.servers.filter((s) => s.enabled);
      for (const server of enabledServers) {
        this.deps.mcpManager.connect(server).catch((err) => {
          console.error(`[MCP] 自动连接失败: ${server.name}`, err);
        });
      }
    }

    // Phase 48 Task 4：构造 AgentProfileManager 并异步加载（不阻塞初始化）
    // 与 app-init.ts 中的 workerProfileManager 行为一致：fail-open，加载失败仅记录
    this.profileManager = new AgentProfileManager(this.options.cwd);
    this.profileManager.loadAll().catch((err) => {
      console.error('[Engine] AgentProfileManager.loadAll 失败:', err);
    });
  }

  async reloadConfig(config: AppConfig): Promise<void> {
    this.config = config;
    // 重新初始化 LLM 客户端和分类器，保留对话历史
    await this.initialize();
    this.options.onConfigReloaded?.(config);
  }

  async sendChat(text: string): Promise<void> {
    if (!this.deps || !this.classifier || !this.modelRouter || !this.tracker || !this.clientManager) {
      this.options.onStream({ type: 'error', error: '引擎未初始化' });
      return;
    }

    // Phase 54：拦截 /goal 命令——交由 GoalRunner 执行目标分解 + 多 Agent 协作
    // 之前 /goal 被当普通文本发给 LLM，导致命令不生效
    const trimmed = text.trim();
    if (trimmed.startsWith('/goal')) {
      await this.executeCommand(text);
      this.options.onStream({ type: 'done' });
      return;
    }

    try {
      const classifyResult = await this.classifier.classify({ query: text });
      this.currentTier = classifyResult.tier;
      const routeDecision = await this.modelRouter.route(classifyResult);
      const fallbackNotice = notifyRoutingFallback(routeDecision);
      if (fallbackNotice) {
        this.options.onStream({ type: 'progress', progress: { label: fallbackNotice, current: 0, total: 1 } });
      }
      this.currentModel = routeDecision.model.id;
      this.isDegraded = routeDecision.degraded;

      // 启动 Trace 会话
      this.deps.trace.startSession(text, routeDecision);

      const client = this.clientManager.get(routeDecision.providerId);
      if (!client || !client.isReady()) {
        this.options.onStream({
          type: 'error',
          error: `提供商 ${routeDecision.providerId} 不可用。请检查 API Key 配置。`,
        });
        return;
      }

      this.options.onStream({
        type: 'progress',
        progress: {
          label: `路由: ${routeDecision.model.id}`,
          current: 1,
          total: 3,
          modelId: routeDecision.model.id,
          tier: routeDecision.originalTier,
        },
      });

      let actualUserMessage = text;
      const imageRefs = VisionAssistant.extractImageReferences(text);
      if (imageRefs.length > 0) {
        const loadedImages: ImageInput[] = [];
        for (const ref of imageRefs) {
          const img = await VisionAssistant.loadImage(ref, this.options.cwd);
          if (img) loadedImages.push(img);
        }
        if (loadedImages.length > 0) {
          this.options.onStream({
            type: 'progress',
            progress: { label: `正在分析 ${loadedImages.length} 张图片`, current: 2, total: 3 },
          });
          const visionResult = await this.deps.visionAssistant.analyze(loadedImages, `用户问题: ${text}`);
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

      this.abortController = new AbortController();
      let accumulatedContent = '';
      let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      // Phase 37：Skill 路由——根据用户消息匹配已启用的 Skill，将内容追加到 systemPrompt
      let skillPromptSuffix = '';
      if (this.deps?.skillsRouter) {
        const matchedSkills = this.deps.skillsRouter.route(actualUserMessage, 3);
        if (matchedSkills.length > 0) {
          const skillBlocks = matchedSkills.map((s) =>
            `## Skill: ${s.name}\n${s.content}`,
          );
          skillPromptSuffix = `\n\n---\n# 已激活的 Skill（根据任务自动匹配）\n${skillBlocks.join('\n\n')}`;
        }
      }

      for await (const event of this.deps.agentLoop.run({
        userMessage: actualUserMessage,
        llmClient: client,
        routeDecision,
        conversationHistory: this.conversationHistory,
        systemPrompt: (await this.deps.prompts.render('main.system', {
          language: this.config.general.language === 'zh-CN' ? '中文' : 'English',
          autonomyMode: this.config.autonomy.defaultMode,
          routeDecision: `${routeDecision.model.id} (${routeDecision.originalTier})`,
          availableTools: this.deps.registry.list().map(t => t.definition.name).join(', '),
          cwd: this.options.cwd,
        })) + skillPromptSuffix,
        signal: this.abortController.signal,
        onConfirmTool: async (toolName, args) => {
          // 根据当前自主度模式决定是否需要用户确认
          // auto（全自动）：所有工具调用直接批准，不弹确认框
          // semi（半自动）/ manual（手动确认）：弹确认框等待用户操作
          const currentMode = this.config.autonomy.defaultMode;
          if (currentMode === 'auto' && toolName !== 'ask_user') {
            return true;
          }
          return new Promise<boolean | { approved: boolean; payload?: unknown }>((resolve) => {
            this.pendingConfirmRef.current = { resolve, toolName };
            this.options.onToolConfirmRequest(toolName, args);
          });
        },
      })) {
        switch (event.type) {
        case 'text_delta':
          accumulatedContent += event.text;
          this.options.onStream({ type: 'text_delta', chunk: event.text });
          break;

        case 'reasoning_delta':
          // 转发推理过程增量，供前端显示模型思考过程
          this.options.onStream({ type: 'reasoning_delta', reasoning: event.text });
          break;
          case 'tool_call_start':
            this.options.onStream({ type: 'tool_start', toolName: event.toolName, toolArgs: event.args });
            break;
          case 'tool_call_result':
            this.options.onStream({
              type: 'tool_done',
              toolName: event.toolName,
              toolResult: event.result,
            });
            break;
          case 'error':
            this.options.onStream({ type: 'error', error: event.error });
            break;
          case 'done':
            finalUsage = event.usage;
            break;
          case 'token_profile':
            if (event.snapshot) this.options.onTokenProfile?.(event.snapshot);
            break;
        }
      }

      this.tracker.record(finalUsage, { modelId: routeDecision.model.id, agentId: 'default', stepId: 'chat' });
      this.options.onStream({ type: 'progress', progress: { label: '完成', current: 3, total: 3 } });
      this.options.onStream({ type: 'done' });

      this.conversationHistory.push({ role: 'user', content: actualUserMessage });
      this.conversationHistory.push({ role: 'assistant', content: accumulatedContent });
      if (this.conversationHistory.length > 20) {
        this.conversationHistory = this.conversationHistory.slice(-20);
      }

      if (this.config.checkpoint.enabled) {
        const usagePercent = this.tracker.getUsagePercent();
        const triggers = this.config.checkpoint.triggers.map((t) => ({
          level: t.level,
          action: t.action as 'initial' | 'incremental' | 'compress',
        }));
        const triggerAction = this.deps.contextManager.shouldTriggerCheckpoint(usagePercent, triggers);
        if (triggerAction) {
          const cp = await this.deps.contextManager.triggerCheckpoint(
            triggerAction,
            this.conversationHistory,
            usagePercent,
          );
          if (cp) {
            await this.deps.contextManager.saveCheckpoint();
            this.options.onStream({
              type: 'progress',
              progress: { label: `记忆已保存: ${cp.currentIntent}`, current: 3, total: 3 },
            });
          }
        }
        const estimatedTokens = this.conversationHistory.reduce((acc, msg) => {
          const t = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          return acc + estimateTokens(t);
        }, 0);
        if (this.deps.contextManager.shouldCompress(this.conversationHistory.length, estimatedTokens)) {
          const { compressed, result } = this.deps.contextManager.compress(this.conversationHistory);
          this.conversationHistory = compressed;
          this.options.onStream({
            type: 'progress',
            progress: { label: `上下文已压缩: ${result.originalCount} → ${result.compressedCount} 条`, current: 3, total: 3 },
          });
        }
      }
    } catch (err) {
      this.options.onStream({
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      this.options.onStream({ type: 'done' });
    } finally {
      this.abortController = null;
    }
  }

  resolveToolConfirm(approved: boolean, payload?: unknown): void {
    if (this.pendingConfirmRef.current) {
      this.pendingConfirmRef.current.resolve({ approved, payload });
      this.pendingConfirmRef.current = null;
    }
  }

  /**
   * Phase 54：解析计划编辑响应（渲染层 StepEditor 确认/取消后调用）
   * @param requestId 关联的请求 ID
   * @param steps 编辑后的步骤列表；null 表示用户取消
   */
  resolvePlanEdit(requestId: string, steps: PlanEditRequestPayload['plan']['steps'] | null): void {
    const resolver = this.pendingPlanEditResolvers.get(requestId);
    if (resolver) {
      this.pendingPlanEditResolvers.delete(requestId);
      resolver(steps);
    }
  }

  /**
   * 停止当前生成（供 IPC chat:stop 调用）
   * 中止进行中的 LLM 请求与 Agent Loop 迭代
   * Phase 54 修复：同时 abort 共享的 abortControllerRef，让 GoalRunner 步骤循环检测到 aborted 后中止
   */
  stopGeneration(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.abortControllerRef.current?.abort();
    this.abortControllerRef.current = null;
  }

  /**
   * 获取当前配置（供主进程 IPC 处理器读取安全策略等）
   */
  getConfig(): AppConfig {
    return this.config;
  }

  /**
   * 更新引擎配置（用户在设置页面修改配置后调用，确保自主度等设置实时生效）
   */
  updateConfig(newConfig: AppConfig): void {
    this.config = newConfig;
    console.log(`[Engine] 配置已更新，自主度: ${newConfig.autonomy.defaultMode}`);
  }

  /**
   * 使用路由模型（杂活模型）生成对话标题
   * 在用户发送第一条消息后调用，避免标题过长或截断
   */
  async generateTitle(userMessage: string, assistantReply?: string): Promise<string> {
    if (!this.clientManager || !this.classifier) {
      // 无可用 LLM 时回退到截断策略
      const fallback = userMessage.trim().slice(0, 30);
      return fallback.length < userMessage.trim().length ? fallback + '…' : fallback;
    }
    try {
      const readyClients = this.clientManager.getReadyClients();
      if (readyClients.length === 0) {
        return userMessage.trim().slice(0, 30) + (userMessage.length > 30 ? '…' : '');
      }
      const client = readyClients[0].client;
      const routerConfig = buildRouterConfig(this.config);
      // 使用分类器模型（杂活模型），回退到配置中的第一个模型
      const model = routerConfig.classifierModel || this.config.providers[0]?.models[0]?.id || '';
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

    // Phase 54：/goal 命令——目标分解 + 多 Agent 协作执行
    // 之前缺失此分支，导致 /goal 走 sendChat 当普通消息发给 LLM
    if (cmd.startsWith('/goal')) {
      return this.executeGoalCommand(text);
    }

    // GUI 支持的快捷命令
    if (cmd === '/clear') {
      this.conversationHistory = [];
      return { ok: true, message: '对话历史已清空' };
    }
    if (cmd === '/status') {
      return {
        ok: true,
        message: `模型: ${this.currentModel}\n层级: ${this.currentTier}\n降级: ${this.isDegraded}\n历史: ${this.conversationHistory.length} 条`,
      };
    }
    if (cmd === '/mcp') {
      return { ok: true, message: JSON.stringify(this.getMCPStatus(), null, 2) };
    }
    if (cmd === '/compact' || cmd === '/compress') {
      if (this.deps && this.conversationHistory.length > 4) {
        const { compressed, result } = this.deps.contextManager.compress(this.conversationHistory);
        this.conversationHistory = compressed;
        return { ok: true, message: `上下文已压缩: ${result.originalCount} → ${result.compressedCount} 条` };
      }
      return { ok: true, message: '对话历史较短，无需压缩' };
    }
    if (cmd === '/help') {
      return {
        ok: true,
        message: '可用命令: /clear /status /mcp /compact /skill /help',
      };
    }
    // Phase 37：/skill 和 /skills 命令
    if (cmd === '/skill' || cmd === '/skills') {
      const skills = this.listSkills();
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
    return { ok: false, message: `GUI 中暂不支持命令: ${text}` };
  }

  /**
   * Phase 54：执行 /goal 命令
   *
   * 接线说明：
   *   - 懒初始化 GoalRunner（首次调用时创建，复用 engine 已有的 classifier/modelRouter/clientManager/tracker/deps）
   *   - addSystemMessage 映射到 onStream(text_delta)——把 GoalRunner 的系统消息推送到渲染进程显示
   *   - setIsProcessing 空实现（engine 自己管理 done 事件）
   *   - requestPlanEdit 返回原计划步骤（auto 模式本就跳过；semi/manual 模式后续可通过 IPC 双向通信实现 UI 编辑）
   *   - nextId 用 Date.now()+递增计数保证唯一
   */
  private async executeGoalCommand(text: string): Promise<{ ok: boolean; message?: string }> {
    if (!this.deps || !this.classifier || !this.modelRouter || !this.tracker || !this.clientManager) {
      return { ok: false, message: '引擎未初始化' };
    }

    // Phase 54：每次 /goal 生成新 goalId 并重新创建 GoalRunner
    // 原因：gid 在 createGoalRunner 顶部固定，复用实例会导致多次 /goal 共用同一 goalId
    // createGoalRunner 仅组装闭包，重建成本极低，且保证 goalId 隔离
    const goalId = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      this.goalRunner = createGoalRunner({
        classifier: this.classifier,
        modelRouter: this.modelRouter,
        clientManager: this.clientManager,
        tracker: this.tracker,
        agentLoop: this.deps.agentLoop,
        checkpointManager: this.deps.checkpointManager,
        contextManager: this.deps.contextManager,
        config: this.config,
        systemPromptRef: this.deps.sharedSystemPromptRef,
        conversationHistoryRef: { current: this.conversationHistory },
        pendingConfirmRef: this.pendingConfirmRef,
        // Phase 54 修复：用共享 abortControllerRef，stopGeneration 可中止 GoalRunner
        abortControllerRef: this.abortControllerRef,
        currentPlanRef: { current: null },
        awaitingGoalConfirmRef: { current: null },
        // addSystemMessage：把 GoalRunner 的系统消息通过 IPC 推送到渲染进程
        // Phase 54：过滤进度文本（已被 GoalExecutionCard 取代），保留错误/用法类文本
        addSystemMessage: (content: string) => {
          if (isGoalProgressText(content)) return;
          this.options.onStream({ type: 'text_delta', chunk: content + '\n' });
        },
        // Phase 54：工具确认/用户提问触发器（复用 sendChat 的 onToolConfirmRequest）
        onToolConfirmRequest: this.options.onToolConfirmRequest,
        // Phase 54：计划编辑——发送 IPC 到渲染层 StepEditor，等待用户确认/取消
        // semi/manual 模式触发；auto 模式 goal-runner 已在上层跳过此调用
        requestPlanEdit: async (plan: GoalPlan): Promise<PlanStep[] | null> => {
          // 无 onPlanEditRequest 回调时降级为原计划（兼容旧版 main 进程）
          if (!this.options.onPlanEditRequest) return plan.steps;
          const requestId = `plan-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          // 把 GoalStep 简化为 IPC 传输格式（剥离运行时字段，保留 id/description/acceptanceCriteria/dependencies）
          const planSnapshot: PlanEditRequestPayload['plan'] = {
            description: plan.description,
            verificationCriteria: plan.verificationCriteria,
            steps: plan.steps.map(s => ({
              id: s.id,
              description: s.description,
              acceptanceCriteria: s.acceptanceCriteria,
              dependencies: s.dependencies,
              suggestedRole: s.suggestedRole,
            })),
          };
          // 等待渲染层响应（resolvePlanEdit 在 IPC plan:edit-response 触发时调用 resolver）
          const edited = await new Promise<PlanEditRequestPayload['plan']['steps'] | null>((resolve) => {
            this.pendingPlanEditResolvers.set(requestId, resolve);
            this.options.onPlanEditRequest!(requestId, planSnapshot);
          });
          if (edited === null) return null;
          // 把编辑后的简化格式 merge 回完整 PlanStep（保留原 status/startedAt 等运行时字段）
          return plan.steps.map(orig => {
            const editedStep = edited.find(e => e.id === orig.id);
            if (!editedStep) return orig;
            return {
              ...orig,
              description: editedStep.description,
              acceptanceCriteria: editedStep.acceptanceCriteria,
              dependencies: editedStep.dependencies,
              suggestedRole: editedStep.suggestedRole,
            };
          });
        },
        setIsProcessing: () => { /* engine 自己管理 done 事件，此处空实现 */ },
        nextId: () => `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        // Phase 54 Task 1/4：多 Agent 编排 + 统一审查器
        orchestrator: this.deps.orchestrator,
        workerExecutor: this.deps.workerExecutor,
        blackboard: this.deps.blackboard,
        unifiedReviewer: this.deps.unifiedReviewer,
        // Phase 50/32：Goal 流程核心模块
        goalAuditor: this.deps.goalAuditor ?? undefined,
        goalPersistence: this.deps.goalPersistence ?? undefined,
        goalPromptBuilder: this.deps.goalPromptBuilder ?? undefined,
        completionGate: this.deps.completionGate,
        profiler: this.deps.profiler ?? undefined,
        // Phase 54：结构化事件回调 + goalId（驱动渲染层 GoalExecutionCard）
        onGoalEvent: this.options.onGoalEvent,
        goalId,
        // Phase 53 P5：步骤级钩子运行器（与 CLI App.tsx 对齐，触发 pre-step/post-step/on-complete）
        hookRunner: this.deps.hookRunner,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.options.onStream({ type: 'error', error: `GoalRunner 初始化失败: ${errMsg}` });
      return { ok: false, message: errMsg };
    }

    try {
      await this.goalRunner.handleGoalCommand(text);
      return { ok: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.options.onStream({ type: 'error', error: `/goal 执行失败: ${errMsg}` });
      return { ok: false, message: errMsg };
    }
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.deps) return { error: '引擎未初始化' };
    try {
      const result = await this.deps.toolExecutor.execute(name, args, {
        workingDirectory: this.options.cwd,
        allowedDirectories: [this.options.cwd],
        environment: process.env as Record<string, string>,
        timeoutMs: 30000,
      });
      return { output: result.output, success: result.success, error: result.error };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 动态更新工作目录（用户切换项目时调用）
   * 更新后所有工具调用和系统提示词中的 cwd 都会使用新路径
   *
   * C2 修复：主进程 IPC 层已做授权校验，这里再做防御性 realpath 归一化，
   * 防止符号链接或路径绕过导致工具以非预期目录为根执行。
   */
  async setCwd(newCwd: string): Promise<void> {
    if (!newCwd || newCwd === this.options.cwd) return;
    // 防御性校验：必须是绝对路径且非系统根目录
    const pathMod = await import('node:path');
    const osMod = await import('node:os');
    const resolved = pathMod.resolve(newCwd);
    if (resolved === pathMod.parse(resolved).root) {
      console.error('[Engine] setCwd 拒绝系统根目录:', resolved);
      return;
    }
    if (resolved === osMod.homedir()) {
      console.error('[Engine] setCwd 拒绝用户主目录:', resolved);
      return;
    }
    this.options.cwd = resolved;
    await this.initialize();
    this.conversationHistory = [];
    console.log(`[Engine] 工作目录已切换: ${resolved}`);
  }

  /** 获取当前工作目录 */
  getCwd(): string {
    return this.options.cwd;
  }

  syncConversationHistory(messages: LLMMessage[]): void {
    this.conversationHistory = messages.slice(-20);
    console.log(`[Engine] 对话历史已同步: ${this.conversationHistory.length} 条`);
  }

  getMCPStatus(): MCPStatus {
    if (!this.deps) return { connected: false, servers: [] };
    const servers = this.deps.mcpManager.listConnections().map((s) => ({
      id: s.serverId,
      connected: s.status === 'connected',
      error: s.error,
    }));
    return {
      connected: servers.some((s) => s.connected),
      servers,
    };
  }

  // ============================================================
  // Phase 37：Skill 管理 API
  // ============================================================

  /** 列出所有 Skill（含启用/禁用状态，不含 content） */
  listSkills(): SkillInfo[] {
    if (!this.deps) return [];
    return this.deps.skillsRouter.listStatuses().map((s) => ({
      name: s.name,
      description: s.description,
      routingKeywords: s.routingKeywords,
      enabled: s.enabled,
      sourcePath: s.sourcePath,
    }));
  }

  /** 预览指定 Skill（含完整 content） */
  previewSkill(name: string): SkillPreview | null {
    if (!this.deps) return null;
    const status = this.deps.skillsRouter.listStatuses().find((s) => s.name === name);
    if (!status) return null;
    return {
      name: status.name,
      description: status.description,
      routingKeywords: status.routingKeywords,
      enabled: status.enabled,
      sourcePath: status.sourcePath,
      content: status.content,
    };
  }

  /** 启用/禁用 Skill */
  toggleSkill(name: string, enabled: boolean): boolean {
    if (!this.deps) return false;
    return this.deps.skillsRouter.setEnabled(name, enabled);
  }

  /** 创建新 Skill（写入 .routedev/skills/<name>/SKILL.md） */
  async createSkill(
    name: string,
    description: string,
    keywords: string[],
    content: string,
  ): Promise<{ success: boolean; error?: string; path?: string }> {
    if (!this.deps) return { success: false, error: '引擎未初始化' };
    try {
      const skillPath = await this.deps.filesystemDiscovery.createSkill(name, description, keywords, content);
      // 重新发现并注册
      const skills = await this.deps.filesystemDiscovery.discoverSkills();
      this.deps.skillsRouter.unregister(name);
      const newSkill = skills.find((s) => s.name === name);
      if (newSkill) {
        this.deps.skillsRouter.register(newSkill);
      }
      return { success: true, path: skillPath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 从市场安装 Skill
   * 1. 调用 SkillMarketManager.install 把 market/<name>/<version>/SKILL.md 拷贝到 .routedev/skills/<name>/SKILL.md
   * 2. 通过 filesystemDiscovery 重新发现并注册到 skillsRouter
   * 失败时返回 { success: false, error }
   */
  async installSkill(payload: SkillInstallPayload): Promise<{ success: boolean; error?: string; path?: string }> {
    if (!this.deps) return { success: false, error: '引擎未初始化' };
    try {
      // Phase 53 Task 6：安装前注入安全门控（未启用时 undefined，SkillMarketManager fail-open 跳过）
      const securityGate = await this.createSecurityGateFromConfig();
      const marketManager = new SkillMarketManager(this.options.cwd, securityGate);
      await marketManager.install(payload.name, payload.version);

      // 重新发现并注册（与 createSkill 后处理一致，避免重启引擎才生效）
      const skills = await this.deps.filesystemDiscovery.discoverSkills();
      this.deps.skillsRouter.unregister(payload.name);
      const newSkill = skills.find((s) => s.name === payload.name);
      if (newSkill) {
        this.deps.skillsRouter.register(newSkill);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Phase 53 Task 6：根据配置创建技能安全门控
   *
   * - config.phase53Integration.skillSecurityGate.enabled=true → 创建门控实例
   * - 未启用或模块不可用 → 返回 undefined（SkillMarketManager fail-open 跳过 scan）
   *
   * 与 app-init.ts 保持一致的 config 守护与动态 import 模式，避免未启用时加载模块。
   */
  private async createSecurityGateFromConfig(): Promise<SkillSecurityGate | undefined> {
    const cfg = this.config.phase53Integration?.skillSecurityGate;
    if (!cfg?.enabled) return undefined;
    try {
      const mod = await import('../../src/skills/security-gate.js');
      return new mod.SkillSecurityGate({ autoInstallThreshold: cfg.autoInstallThreshold });
    } catch (err) {
      // fail-open：模块不可用时不阻塞安装
      console.warn('SkillSecurityGate module not available, install will skip scan', err);
      return undefined;
    }
  }

  /** 删除 Skill */
  async deleteSkill(name: string): Promise<{ success: boolean; error?: string }> {
    if (!this.deps) return { success: false, error: '引擎未初始化' };
    try {
      const ok = await this.deps.filesystemDiscovery.deleteSkill(name);
      if (ok) {
        this.deps.skillsRouter.unregister(name);
        return { success: true };
      }
      return { success: false, error: '删除失败' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 重新发现 Skill（从文件系统重新加载） */
  async reloadSkills(): Promise<{ count: number }> {
    if (!this.deps) return { count: 0 };
    const skills = await this.deps.filesystemDiscovery.discoverSkills();
    // 清除旧注册（保留启用/禁用状态，因为 SkillsRouter 持久化了 disabledSkills）
    const oldNames = this.deps.skillsRouter.list().map((s) => s.name);
    for (const name of oldNames) {
      this.deps.skillsRouter.unregister(name);
    }
    for (const skill of skills) {
      this.deps.skillsRouter.register(skill);
    }
    return { count: skills.length };
  }

  /** 根据任务描述测试 Skill 路由匹配 */
  routeSkills(taskDescription: string): SkillInfo[] {
    if (!this.deps) return [];
    return this.deps.skillsRouter.route(taskDescription, 5).map((s) => ({
      name: s.name,
      description: s.description,
      routingKeywords: s.routingKeywords,
      enabled: true,
      sourcePath: s.sourcePath,
    }));
  }

  // ============================================================
  // Phase 48 Task 4 接线修复：Agent Profile 管理 API
  // 内部使用 AgentProfileManager（在 initialize() 中创建并异步 loadAll）
  // ============================================================

  /** AgentProfile -> AgentProfileInfo（剥离 systemPrompt，列表传输用） */
  private toProfileInfo(profile: AgentProfile): AgentProfileInfo {
    // 显式列出字段，避免 systemPrompt 进入选型后造成 IPC 大对象传输
    return {
      id: profile.id,
      name: profile.name,
      type: 'agent-profile',
      version: profile.version,
      role: profile.role,
      modelId: profile.modelId,
      description: profile.description,
      allowedTools: profile.allowedTools,
      forbiddenTools: profile.forbiddenTools,
      canChallenge: profile.canChallenge,
      challengeSeverity: profile.challengeSeverity,
      outputFormat: profile.outputFormat,
      boundSkills: profile.boundSkills,
      maxTokens: profile.maxTokens,
      maxSteps: profile.maxSteps,
      isBuiltin: profile.isBuiltin,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  /** AgentProfile -> AgentProfileDetail（含完整字段） */
  private toProfileDetail(profile: AgentProfile): AgentProfileDetail {
    return profile as unknown as AgentProfileDetail;
  }

  /** ProfileSavePayload -> AgentProfile（IPC 字段透传，类型已与 src 一致） */
  private fromSavePayload(payload: ProfileSavePayload): AgentProfile {
    return payload as unknown as AgentProfile;
  }

  /** 列出所有 Profile（不含 systemPrompt） */
  async listProfiles(): Promise<AgentProfileInfo[]> {
    if (!this.profileManager) return [];
    try {
      const profiles = await this.profileManager.listProfiles();
      return profiles.map((p) => this.toProfileInfo(p));
    } catch (err) {
      console.error('[Engine] listProfiles failed:', err);
      return [];
    }
  }

  /** 获取指定 Profile 详情（含 systemPrompt） */
  async getProfile(id: string): Promise<AgentProfileDetail | null> {
    if (!this.profileManager) return null;
    try {
      const profile = await this.profileManager.getProfile(id);
      return profile ? this.toProfileDetail(profile) : null;
    } catch (err) {
      console.error('[Engine] getProfile failed:', err);
      return null;
    }
  }

  /** 保存 Profile（新增/更新） */
  async saveProfile(payload: ProfileSavePayload): Promise<ProfileOpResult> {
    if (!this.profileManager) return { success: false, error: '引擎未初始化' };
    try {
      const profile = this.fromSavePayload(payload);
      await this.profileManager.saveProfile(profile);
      return { success: true, id: profile.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 删除 Profile（内置 Profile 不可删除，manager 会抛错） */
  async deleteProfile(id: string): Promise<ProfileOpResult> {
    if (!this.profileManager) return { success: false, error: '引擎未初始化' };
    try {
      await this.profileManager.deleteProfile(id);
      return { success: true, id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 复制 Profile 为自定义副本（需传入新名称） */
  async duplicateProfile(id: string, newName: string): Promise<ProfileOpResult> {
    if (!this.profileManager) return { success: false, error: '引擎未初始化' };
    try {
      const copy = await this.profileManager.duplicateProfile(id, newName);
      return { success: true, id: copy.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================
  // Phase 37：MCP 工具查询 API
  // ============================================================

  /** 列出所有已连接 MCP 服务器的工具 */
  listMCPTools(): MCPToolInfo[] {
    if (!this.deps) return [];
    const tools: MCPToolInfo[] = [];
    for (const tool of this.deps.registry.list()) {
      const name = tool.definition.name;
      // MCP 工具命名规则：mcp__<serverId>__<toolName>
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        if (parts.length >= 3) {
          tools.push({
            name,
            description: tool.definition.description ?? '',
            serverId: parts[1],
          });
        }
      }
    }
    return tools;
  }

  // ============================================================
  // MCP 插件市场：连接/断开/安装 API
  // ============================================================

  /** 连接指定 MCP 服务器（根据 config 中的 server 配置） */
  async connectServer(serverId: string): Promise<MCPConnectionResult> {
    if (!this.deps) return { success: false, error: '引擎未初始化' };
    const server = this.config.mcp.servers.find((s) => s.id === serverId);
    if (!server) return { success: false, error: `未找到服务器配置: ${serverId}` };
    try {
      const info = await this.deps.mcpManager.connect(server);
      return {
        success: info.status === 'connected',
        error: info.error,
        status: this.getMCPStatus(),
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 断开指定 MCP 服务器 */
  async disconnectServer(serverId: string): Promise<MCPConnectionResult> {
    if (!this.deps) return { success: false, error: '引擎未初始化' };
    try {
      await this.deps.mcpManager.disconnect(serverId);
      return { success: true, status: this.getMCPStatus() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 一键安装：从市场目录安装 MCP 服务器
   * 1. 从目录获取服务器规格
   * 2. 构造 MCPServerEntry 配置
   * 3. 添加到 config.mcp.servers（去重）
   * 4. 立即连接
   * 5. 返回安装结果（调用方负责持久化 config）
   */
  async installServer(payload: MCPInstallPayload): Promise<MCPInstallResult> {
    if (!this.deps) return { success: false, error: '引擎未初始化' };

    const entry = getCatalogEntry(payload.catalogId);
    if (!entry) return { success: false, error: `目录中未找到: ${payload.catalogId}` };

    const serverId = payload.customId || payload.catalogId;

    // 检查是否已安装（同 id）
    if (this.config.mcp.servers.some((s) => s.id === serverId)) {
      return { success: false, error: `服务器已存在: ${serverId}（请先删除或使用自定义 id）` };
    }

    // 构造 MCPServerEntry
    let serverEntry: MCPServerEntry;
    if (entry.transport === 'stdio') {
      // 替换 args 中的占位符（如 ${WORKSPACE}、${DATABASE_URL}）
      const args = (entry.args ?? []).map((a) => {
        if (a === '${WORKSPACE}') return this.options.cwd;
        return a;
      });
      // 构造 env（从用户填写的值中提取）
      const env: Record<string, string> = {};
      for (const key of entry.requiredEnv ?? []) {
        const val = payload.envValues?.[key];
        if (val) env[key] = val;
      }
      serverEntry = {
        id: serverId,
        name: entry.displayName,
        enabled: true,
        config: {
          transport: 'stdio',
          command: entry.command ?? 'npx',
          args,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        },
      };
    } else {
      // http 传输
      const headers: Record<string, string> = {};
      for (const key of entry.requiredHeaders ?? []) {
        const val = payload.headerValues?.[key];
        if (val) headers[key] = val;
      }
      serverEntry = {
        id: serverId,
        name: entry.displayName,
        enabled: true,
        config: {
          transport: 'http',
          url: entry.url ?? '',
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      };
    }

    // 添加到 config（内存中，调用方负责持久化）
    this.config.mcp.servers.push(serverEntry);

    // 立即连接
    try {
      const info = await this.deps.mcpManager.connect(serverEntry);
      return {
        success: info.status === 'connected',
        error: info.error,
        serverId,
        connected: info.status === 'connected',
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        serverId,
        connected: false,
      };
    }
  }

  // ============================================================
  // Phase 39：Experiment / Hook 桥接方法
  // fail-open：底层模块调用失败时返回默认值，不抛异常
  // ============================================================

  /** 列出所有实验分支 */
  listExperiments(): unknown[] {
    try {
      // E9-B 修复：优先复用 AppDependencies.experimentManager 单例（含 ExperimentRunner 注入）
      // 仅在引擎未初始化（this.deps === null）时回退到本地实例化（保持向后兼容）
      const manager = this.deps?.experimentManager ?? new ExperimentManager(this.options.cwd);
      return manager.listExperiments();
    } catch {
      return [];
    }
  }

  /** 采纳实验分支（合并到主分支） */
  async adoptExperiment(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      // E9-B 修复：优先复用 AppDependencies.experimentManager 单例（含 ExperimentRunner 注入）
      // 仅在引擎未初始化（this.deps === null）时回退到本地实例化（保持向后兼容）
      const manager = this.deps?.experimentManager ?? new ExperimentManager(this.options.cwd);
      const result = await manager.adoptExperiment(id);
      return { success: result.success, error: result.success ? undefined : result.message };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 丢弃实验分支（删除 worktree 和分支） */
  async discardExperiment(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      // E9-B 修复：优先复用 AppDependencies.experimentManager 单例（含 ExperimentRunner 注入）
      // 仅在引擎未初始化（this.deps === null）时回退到本地实例化（保持向后兼容）
      const manager = this.deps?.experimentManager ?? new ExperimentManager(this.options.cwd);
      await manager.discardExperiment(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 获取实验分支 diff */
  async getExperimentDiff(
    id: string,
  ): Promise<{ diff: string; filesChanged: number; error?: string }> {
    try {
      // E9-B 修复：优先复用 AppDependencies.experimentManager 单例（含 ExperimentRunner 注入）
      // 仅在引擎未初始化（this.deps === null）时回退到本地实例化（保持向后兼容）
      const manager = this.deps?.experimentManager ?? new ExperimentManager(this.options.cwd);
      const diff = await manager.getExperimentDiff(id);
      // 从 diff 内容统计变更文件数
      const filesChanged = (diff.match(/^diff --git/gm) || []).length;
      return { diff, filesChanged };
    } catch (err) {
      return { diff: '', filesChanged: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 列出所有 Hook 配置 */
  async listHooks(): Promise<unknown[]> {
    try {
      const configPath = path.join(
        this.options.cwd,
        this.config.hooks?.configPath ?? '.routedev/hooks.json',
      );
      const registry = new HookConfigRegistry(configPath);
      await registry.load();
      return registry.list();
    } catch {
      return [];
    }
  }

  /** 启用/禁用 Hook */
  async toggleHook(
    id: string,
    enabled: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const configPath = path.join(
        this.options.cwd,
        this.config.hooks?.configPath ?? '.routedev/hooks.json',
      );
      const registry = new HookConfigRegistry(configPath);
      await registry.load();
      const ok = registry.toggle(id, enabled);
      if (!ok) return { success: false, error: `未找到 Hook "${id}"` };
      await registry.save();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 创建新 Hook（模板模式 / 自定义模式）
   *
   * 替代已移除的 HookGenerator（LLM 生成模式），改为：
   *   - 模板模式：传入 templateId，从内置模板库复制创建
   *   - 自定义模式：传入 name + event + code（shell 命令），直接保存
   *
   * @param payload
   *   - 模板模式：{ templateId: string }
   *   - 自定义模式：{ name: string, event: HookEvent, code: string, description?, priority?, condition?, failBehavior? }
   *   - 兼容旧调用：传入 string 时视为描述，但缺少 code 无法创建（返回错误提示）
   *
   * @returns 创建结果，成功时返回 hookId
   */
  async createHook(
    payload: { templateId: string } | {
      name: string;
      event: string;
      code: string;
      description?: string;
      priority?: number;
      condition?: { toolName?: string; filePattern?: string };
      failBehavior?: 'warn' | 'block' | 'silent';
    },
  ): Promise<{ success: boolean; hookId?: string; error?: string }> {
    try {
      // C4 修复：hooks.configPath 路径越界校验
      // 拒绝绝对路径和 .. 越界，确保 Hook 注册表只能写到项目目录内
      const rawConfigPath = this.config.hooks?.configPath ?? '.routedev/hooks.json';
      if (path.isAbsolute(rawConfigPath)) {
        return { success: false, error: 'hooks.configPath 不能使用绝对路径' };
      }
      const resolvedConfigPath = path.resolve(this.options.cwd, rawConfigPath);
      const cwdResolved = path.resolve(this.options.cwd);
      if (!resolvedConfigPath.startsWith(cwdResolved + path.sep) && resolvedConfigPath !== cwdResolved) {
        return { success: false, error: 'hooks.configPath 越界：必须在项目目录内' };
      }
      const configPath = resolvedConfigPath;
      const registry = new HookConfigRegistry(configPath);
      await registry.load();

      let config: HookConfig;

      // 模板模式：从内置模板复制
      if (typeof payload === 'object' && payload !== null && 'templateId' in payload) {
        const template = getHookTemplateById(payload.templateId);
        if (!template) {
          return { success: false, error: `未找到模板 "${payload.templateId}"` };
        }
        // 生成唯一 ID：模板 id + 时间戳后缀，避免重复创建时 ID 冲突
        const hookId = `${template.id}-${Date.now()}`;
        config = {
          id: hookId,
          name: template.name,
          event: template.event,
          enabled: template.enabled,
          condition: template.condition,
          command: template.code,
          failBehavior: template.failBehavior,
          isTemplate: true,
        };
      } else if (
        typeof payload === 'object' &&
        payload !== null &&
        'name' in payload &&
        'event' in payload &&
        'code' in payload
      ) {
        // 自定义模式：C3 修复——创建前强制安全扫描，拒绝危险命令
        const p = payload as {
          name: string;
          event: string;
          code: string;
          description?: string;
          priority?: number;
          condition?: { toolName?: string; filePattern?: string };
          failBehavior?: 'warn' | 'block' | 'silent';
        };
        const bashResult = checkBashSecurity(p.code);
        if (!bashResult.allowed) {
          return { success: false, error: `Hook 命令被安全策略拒绝：${bashResult.reason}` };
        }
        const hookId = `custom-${Date.now()}`;
        config = {
          id: hookId,
          name: p.name,
          event: p.event as HookConfig['event'],
          enabled: true,
          condition: p.condition,
          command: p.code,
          failBehavior: p.failBehavior ?? 'warn',
          isTemplate: false,
        };
      } else {
        return {
          success: false,
          error: '参数错误：需提供 templateId 或 { name, event, code }',
        };
      }

      registry.add(config);
      await registry.save();
      return { success: true, hookId: config.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 列出所有内置 Hook 模板（供 UI 选择） */
  listHookTemplates(): HookTemplate[] {
    return getHookTemplates();
  }

  /** 删除自定义 Hook */
  async deleteHook(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      const configPath = path.join(
        this.options.cwd,
        this.config.hooks?.configPath ?? '.routedev/hooks.json',
      );
      const registry = new HookConfigRegistry(configPath);
      await registry.load();
      const ok = registry.remove(id);
      if (!ok) return { success: false, error: `未找到 Hook "${id}"` };
      await registry.save();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================
  // Phase 47 Task 6：Checkpoint 时间轴与语义化摘要桥接方法
  // fail-open：底层 CheckpointManager 不存在时返回空数组/默认值
  // ============================================================

  /**
   * 列出当前项目的所有检查点
   * @param projectId 项目 ID（当前未使用，CheckpointManager 已按工作目录隔离）
   * @returns 检查点列表（按创建时间升序，IPC 传输用，剥离 gitCommitHash 等内部字段）
   */
  listCheckpoints(projectId?: string): Checkpoint[] {
    if (!this.deps) return [];
    try {
      return this.deps.checkpointManager.list();
    } catch (err) {
      console.error('[Engine] listCheckpoints failed:', err);
      return [];
    }
  }

  /**
   * 回滚到指定检查点
   * 注意：这是破坏性操作（git reset --hard），调用方（UI）必须在执行前获得用户确认
   * @param checkpointId 检查点 ID
   * @returns 回滚结果
   */
  async rollbackCheckpoint(checkpointId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.deps) return { success: false, error: '引擎未初始化' };
    try {
      const ok = await this.deps.checkpointManager.rollback(checkpointId);
      return { success: ok, error: ok ? undefined : '回滚失败（检查点不存在或工作区有未提交更改）' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 销毁引擎：中止 LLM 请求 + 关闭 MCP 连接 + 移除 trace 回调
   * 异步方法，调用方应 await 确保资源完全释放后再退出进程
   */
  async destroy(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    // 清理 deps 资源（MCP 连接、trace 回调等），避免句柄泄漏
    if (this.deps) {
      // 移除 trace 回调，防止旧 TraceCollector 在被 GC 前继续触发事件
      try { this.deps.trace.onSpan(null); } catch { /* 忽略清理错误 */ }
      // 关闭所有 MCP 连接（await 确保子进程退出，避免孤儿进程锁定文件）
      try { await this.deps.mcpManager.disconnectAll(); } catch { /* 忽略清理错误 */ }
      this.deps = null;
    }
    // Phase 48 Task 4：清理 profileManager 引用，防止 reload 后旧实例残留
    this.profileManager = null;
  }
}
