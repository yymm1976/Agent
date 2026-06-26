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
import type { ChatStreamPayload, MCPStatus, MCPConnectionResult, MCPInstallResult, MCPInstallPayload } from '../shared/ipc-types.js';
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
import type { Checkpoint } from '../../src/harness/types.js';

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
  private pendingConfirm: { resolve: (result: boolean | { approved: boolean; payload?: unknown }) => void; toolName: string } | null = null;
  private abortController: AbortController | null = null;
  private currentModel = '';
  private currentTier: ScenarioTier = 'simple';
  private isDegraded = false;

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
    this.deps = createAppDependencies(this.config, clientManager, defaultModel, this.options.cwd);

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
            this.pendingConfirm = { resolve, toolName };
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
    if (this.pendingConfirm) {
      this.pendingConfirm.resolve({ approved, payload });
      this.pendingConfirm = null;
    }
  }

  /**
   * 停止当前生成（供 IPC chat:stop 调用）
   * 中止进行中的 LLM 请求与 Agent Loop 迭代
   */
  stopGeneration(): void {
    this.abortController?.abort();
    this.abortController = null;
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
   */
  async setCwd(newCwd: string): Promise<void> {
    if (!newCwd || newCwd === this.options.cwd) return;
    this.options.cwd = newCwd;
    await this.initialize();
    this.conversationHistory = [];
    console.log(`[Engine] 工作目录已切换: ${newCwd}`);
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
  // Phase 39：CodeGraph / Experiment / Hook 桥接方法
  // fail-open：底层模块调用失败时返回默认值，不抛异常
  // ============================================================

  /** 获取 CodeGraph 引擎状态 */
  getCodeGraphStatus(): { available: boolean; indexed: boolean } {
    // Phase 50 Task 8：CodeGraphManager 已作为死代码移除，返回不可用
    return { available: false, indexed: false };
  }

  /** 安装 CodeGraph 引擎到工作区 */
  async installCodeGraph(): Promise<{ success: boolean; error?: string }> {
    // Phase 50 Task 8：CodeGraphManager 已作为死代码移除
    return { success: false, error: 'CodeGraph 模块已移除' };
  }

  /** 启动 CodeGraph 索引 */
  async startIndexCodeGraph(): Promise<{ success: boolean; error?: string }> {
    // Phase 50 Task 8：CodeGraphManager 已作为死代码移除
    return { success: false, error: 'CodeGraph 模块已移除' };
  }

  /** 列出所有实验分支 */
  listExperiments(): unknown[] {
    try {
      const manager = new ExperimentManager(this.options.cwd);
      return manager.listExperiments();
    } catch {
      return [];
    }
  }

  /** 采纳实验分支（合并到主分支） */
  async adoptExperiment(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      const manager = new ExperimentManager(this.options.cwd);
      const result = await manager.adoptExperiment(id);
      return { success: result.success, error: result.success ? undefined : result.message };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 丢弃实验分支（删除 worktree 和分支） */
  async discardExperiment(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      const manager = new ExperimentManager(this.options.cwd);
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
      const manager = new ExperimentManager(this.options.cwd);
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

  /** 通过自然语言描述生成新 Hook */
  async createHook(
    desc: string,
  ): Promise<{ success: boolean; hookId?: string; error?: string }> {
    // Phase 50 Task 8：HookGenerator 已作为死代码移除，Hook 生成功能不可用
    return { success: false, error: 'Hook 生成器已移除' };
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
  }
}
