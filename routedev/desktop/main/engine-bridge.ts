// desktop/main/engine-bridge.ts
// 核心引擎桥接：把 CLI 的 App 依赖工厂包装成主进程可直接调用的服务
//
// TD-03 + G-022a 重构：按领域拆分为 delegate bridge（bridges/*），RouteDevEngine 仅保留：
//   1. 引擎生命周期（initialize / reloadConfig / destroy / setCwd）
//   2. executeTool（权限相关，留待阶段3 TD-07 增加权限校验）
//   3. 跨领域聚合方法（getSessionStatus）
//   4. 对各 bridge 方法的委托包装（保持对外 API 不变）
// 各 delegate 通过共享 EngineContext 读写状态，跨 bridge 调用经 ctx.bridges 完成。

import path from 'node:path';
import type { AppConfig } from '../shared/config-types.js';
import type { LLMMessage } from '../../src/router/types.js';
import { LLMClientManager } from '../../src/router/llm/index.js';
import { TokenTracker } from '../../src/router/tracker.js';
import { CacheStatsTracker } from '../../src/router/cache-optimizer.js';
import { ScenarioClassifier } from '../../src/router/classifier.js';
import { ModelRouter } from '../../src/router/router.js';
import { buildRouterConfig } from '../../src/router/config.js';
import { lookupModelCost } from '../../src/router/model-catalog.js';
import { createAppDependencies } from '../../src/runtime/app-init.js';
// F-058：MCP 自动连接失败汇总日志
import { logger } from '../../src/utils/logger.js';
import type {
  MCPStatus,
  MCPConnectionResult,
  MCPInstallPayload,
  MCPInstallResult,
  SkillInstallPayload,
  AgentProfileSummary,
  AgentProfileDetail,
  ProfileSavePayload,
  ProfileOpResult,
  VersionMeta,
  VersionRecord,
  FieldDiff,
  ResumableGoalIpcInfo,
  ExperimentInfo,
  HookInfo,
} from '../shared/ipc-types.js';
// Phase 77：运行回放与评分卡——借鉴 HomeRail 的 hr replay / hr scorecard
// G-022a：TraceReplayer/generateScorecard/Checkpoint/TraceSession 等已移至 bridges/trace-bridge.ts
import { AgentProfileManager } from '../../src/agents/profiles/manager.js';
// G-022a：HookConfigRegistry/checkBashSecurity/getHookTemplates/HookConfig 等已移至 bridges/hook-bridge.ts
// Phase 77 借鉴点 4：Voice Memo 式会话状态卡聚合器
import { aggregateSessionStatus } from '../../src/agent/session-status-aggregator.js';
// V2-001：统一环境变量脱敏，替代局部 SENSITIVE_ENV_PREFIX 正则
import { sanitizeProcessEnv } from '../../src/security/env-filter.js';
// Phase 97 Part H：常驻 Agent Island 状态聚合服务
import { AgentStatusService, defaultAgentStatusPath } from './agent-status-service.js';

// delegate bridge 与共享上下文
import {
  EngineContext,
  ChatBridge,
  ConfigBridge,
  MCPBridge,
  SkillBridge,
  ExperimentBridge,
  GoalBridge,
  ProfileBridge,
  HookBridge,
  TraceBridge,
  AgentBridge,
  type EngineBridgeOptions,
  type SkillInfo,
  type SkillPreview,
  type MCPToolInfo,
} from './bridges/index.js';

// 向后兼容：原 engine-bridge.ts 导出的类型，从此处 re-export 供外部消费方继续引用
export type { EngineBridgeOptions, SkillInfo, SkillPreview, MCPToolInfo };

/**
 * 从 provider id 或 baseUrl 推断 clientType
 * 让 DeepSeek/Qwen/Ollama 子类生效（继承 OpenAIClient 但有环境变量回退等定制）
 */
function inferClientType(p: { id: string; protocol: string; baseUrl: string }): 'deepseek' | 'qwen' | 'ollama' | undefined {
  const id = p.id.toLowerCase();
  const url = p.baseUrl.toLowerCase();
  if (id.includes('deepseek') || url.includes('deepseek')) return 'deepseek';
  if (id.includes('qwen') || url.includes('dashscope') || url.includes('qwen')) return 'qwen';
  if (id.includes('ollama') || url.includes('ollama') || url.includes('localhost:11434')) return 'ollama';
  return undefined;
}

/**
 * RouteDev 核心引擎封装
 * 生命周期：initialize() -> sendChat() / executeCommand() / ... -> destroy()
 *
 * TD-03：领域方法委托至各 bridge（chat/config/mcp/skill/experiment/goal），
 * RouteDevEngine 持有 EngineContext 与各 bridge 实例，方法调用转发给对应 delegate。
 * 公开方法签名保持不变，确保所有 IPC handler 调用路径不受影响。
 */
export class RouteDevEngine {
  private ctx: EngineContext;
  private chatBridge: ChatBridge;
  private configBridge: ConfigBridge;
  private mcpBridge: MCPBridge;
  private skillBridge: SkillBridge;
  private experimentBridge: ExperimentBridge;
  private goalBridge: GoalBridge;
  // G-022a：从本文件拆分出的领域 delegate
  private profileBridge: ProfileBridge;
  private hookBridge: HookBridge;
  private traceBridge: TraceBridge;
  // Phase 97 Part E：子会话可见性 delegate
  private agentBridge: AgentBridge;
  // Phase 97 Part H：常驻 Agent Island 状态聚合服务（运行状态唯一权威源）
  private agentStatus: AgentStatusService;

  constructor(config: AppConfig, options: EngineBridgeOptions) {
    this.ctx = new EngineContext(config, options);
    this.chatBridge = new ChatBridge(this.ctx);
    this.configBridge = new ConfigBridge(this.ctx);
    this.mcpBridge = new MCPBridge(this.ctx);
    this.skillBridge = new SkillBridge(this.ctx);
    this.experimentBridge = new ExperimentBridge(this.ctx);
    this.goalBridge = new GoalBridge(this.ctx);
    // G-022a：Profile/Hook/Trace 无需跨 bridge 调用，不注入 ctx.bridges
    this.profileBridge = new ProfileBridge(this.ctx);
    this.hookBridge = new HookBridge(this.ctx);
    this.traceBridge = new TraceBridge(this.ctx);
    // Phase 97 Part E：Agent 领域 delegate（子会话可见性，无需跨 bridge 调用）
    this.agentBridge = new AgentBridge(this.ctx);
    // Phase 97 Part H：状态聚合服务（持久化到 .routedev/agent-status.json，重启重建）
    this.agentStatus = new AgentStatusService(undefined, {
      persistPath: defaultAgentStatusPath(options.cwd),
    });
    // 注入 bridge 互相引用，供跨 bridge 调用（如 ChatBridge.executeCommand → GoalBridge）
    this.ctx.bridges = {
      chat: this.chatBridge,
      config: this.configBridge,
      mcp: this.mcpBridge,
      skill: this.skillBridge,
      experiment: this.experimentBridge,
      goal: this.goalBridge,
    };
  }

  async initialize(): Promise<void> {
    const { ctx } = this;
    // 清理旧的 trace 监听器与 deps 资源，避免 reload 后事件成倍增长或资源泄漏
    if (ctx.deps) {
      // 旧 TraceCollector 的回调置空，避免旧实例继续向渲染进程推送事件
      ctx.deps.trace.onSpan(null);
      // 关闭旧 MCP 连接，防止句柄泄漏（异步执行，不阻塞初始化）
      ctx.deps.mcpManager.disconnectAll().catch((err) => {
        logger.warn('Failed to disconnect MCP servers before engine reinitialization', { err });
      });
    }

    const clientManager = new LLMClientManager();
    clientManager.initializeFromConfig(
      ctx.config.providers.map((p) => ({
        id: p.id,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        // 从 provider id 或 baseUrl 推断 clientType，让 DeepSeek/Qwen/Ollama 子类生效
        clientType: inferClientType(p),
      })),
    );
    ctx.clientManager = clientManager;

    const routerConfig = buildRouterConfig(ctx.config);
    ctx.tracker = new TokenTracker(routerConfig.budget);
    // Phase 96+ A3.3：缓存命中统计追踪器（与 tracker 同生命周期，destroy 时一并置 null）
    ctx.cacheStatsTracker = new CacheStatsTracker();
    ctx.modelRouter = new ModelRouter(routerConfig, ctx.tracker, ctx.config.providers);

    const readyClients = clientManager.getReadyClients();
    const classifierClient = readyClients.length > 0 ? readyClients[0].client : undefined;
    ctx.classifier = new ScenarioClassifier({
      llmClient: classifierClient,
      classifierModel: routerConfig.classifierModel,
    });

    // 默认使用第一个模型的 id 初始化依赖
    const defaultModel = ctx.config.providers[0]?.models[0]?.id ?? '';
    // 接线修复：原实现只传 4 个参数，缺少 classifier/modelRouter/tracker，
    // 导致 AgentLoopStepExecutor 在 Electron 端回退到桩模式（步骤执行只返回"已执行（桩模式）"）。
    // 现补传上方已构造的实例，让 Electron 端与 CLI 端走相同的真实执行路径。
    ctx.deps = createAppDependencies(
      ctx.config,
      clientManager,
      defaultModel,
      ctx.options.cwd,
      ctx.classifier,
      ctx.modelRouter,
      ctx.tracker,
    );

    // Phase 47 Task 6：为 CheckpointManager 注入 LLM 客户端用于语义化摘要生成
    // 使用 checkpointClient（辅助模型）生成摘要，失败时 CheckpointManager 自动降级为原始 description
    const checkpointModelId = ctx.config.checkpoint.modelId || ctx.config.router.classifierModel || defaultModel;
    if (ctx.deps.checkpointClient) {
      ctx.deps.checkpointManager.setLLMClient(ctx.deps.checkpointClient, checkpointModelId);
    }

    // 桥接 TraceCollector：每次 span 创建/更新时推送给渲染进程
    if (ctx.options.onTraceEvent) {
      ctx.deps.trace.onSpan((span) => {
        ctx.options.onTraceEvent?.(span);
      });
    }

    // 自动连接已启用的 MCP 服务器（与 CLI App.tsx 行为一致）
    // fire-and-forget：不阻塞引擎初始化，连接失败只记录不抛出
    // F-058 修复：用 Promise.allSettled 聚合结果，失败时输出汇总日志
    if (ctx.config.mcp.autoConnect && ctx.deps) {
      const deps = ctx.deps;
      const enabledServers = ctx.config.mcp.servers.filter((s) => s.enabled);
      Promise.allSettled(
        enabledServers.map((server) => deps.mcpManager.connect(server)),
      ).then((results) => {
        const failures = results
          .map((r, i) => (r.status === 'rejected' ? { server: enabledServers[i].name, reason: r.reason } : null))
          .filter((r): r is { server: string; reason: unknown } => r !== null);
        if (failures.length > 0) {
          logger.error('MCP auto-connect failures', { failures });
        }
      });
    }

    // Phase 48 Task 4：构造 AgentProfileManager 并异步加载（不阻塞初始化）
    // 与 app-init.ts 中的 workerProfileManager 行为一致：fail-open，加载失败仅记录
    ctx.profileManager = new AgentProfileManager(ctx.options.cwd);
    ctx.profileManager.loadAll().catch((err) => {
      logger.error('[Engine] AgentProfileManager.loadAll 失败', { error: err instanceof Error ? err.message : String(err) });
    });

    // Phase 96 P0-1：加载上次对话历史（重启恢复）
    // fail-open，加载失败不阻塞初始化
    this.chatBridge.loadHistoryOnStart().catch((err) => {
      logger.warn('[Engine] loadHistoryOnStart failed', { err });
    });

    // Phase 97 Part F：注入自动化调度器 executor——定时触发复用统一 Session 执行
    // 权限白名单：触发时以任务 prompt 走 sendChat（权限模式由任务定义，非 bypassPermissions）
    const scheduler = ctx.deps?.automationScheduler;
    if (scheduler) {
      scheduler.setExecutor(async (task) => {
        try {
          await this.sendChat(task.prompt, {
            sessionId: `automation:${task.id}`,
            autonomyMode: task.permissionMode === 'auto' ? 'auto' : 'semi',
            // Phase 97 Part A Task A4：自动化调度触发来源透传
            triggerSource: 'automation',
          });
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });
      scheduler.start();
      logger.info('[Engine] automation scheduler executor wired', {
        tasks: scheduler.listTasks().length,
      });
    }

    // Phase 97 Part H：重启后从快照重建 Agent 状态（fail-open，无快照则空）
    try {
      // 注入聚合数据源：子会话可见性 + 中断队列 + 内核会话状态（deps 已就绪）
      this.agentStatus.setSources({
        subagent: ctx.deps?.subagentRegistry
          ? { list: () => ctx.deps!.subagentRegistry.list() }
          : undefined,
        interruption: {
          list: () => this.chatBridge.listInterruptions(),
        },
        // Phase 97 Part A Task A3：内核状态源（getSessionState/listSessions 生产消费点）
        kernel: ctx.deps?.agentKernel
          ? {
              listSessions: () => ctx.deps!.agentKernel.listSessions(),
              getSessionState: (sessionId) => ctx.deps!.agentKernel.getSessionState(sessionId),
            }
          : undefined,
      });
      const restored = this.agentStatus.restore();
      logger.info('[Engine] agent status restored from snapshot', {
        sessions: restored.sessions.length,
      });
    } catch (err) {
      logger.warn('[Engine] agent status restore failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async reloadConfig(config: AppConfig): Promise<void> {
    this.ctx.config = config;
    // G-007 修复：先销毁旧依赖（释放 timer/handle/MCP 连接等资源），再重新初始化
    // 原实现直接调用 initialize() 不先 destroy()，导致旧依赖泄漏
    await this.destroy();
    // 重新初始化 LLM 客户端和分类器，保留对话历史
    await this.initialize();
    this.ctx.options.onConfigReloaded?.(config);
  }

  /**
   * 销毁引擎：中止 LLM 请求 + 调用 deps.dispose() + 关闭 MCP 连接 + 移除 trace 回调
   * 异步方法，调用方应 await 确保资源完全释放后再退出进程
   */
  async destroy(): Promise<void> {
    // G-004：中断并清除所有并发请求的 abortController
    this.ctx.clearAllAbortControllers();
    this.ctx.clearAllPendingConfirms();
    // 清理 deps 资源（MCP 连接、trace 回调等），避免句柄泄漏
    if (this.ctx.deps) {
      // G-007：先调用 AppDependencies.dispose() 释放各子系统资源（按逆序调用 dispose）
      try { await this.ctx.deps.dispose(); } catch (err) { logger.warn('[Engine] dispose cleanup error', { err }); }
      // 移除 trace 回调，防止旧 TraceCollector 在被 GC 前继续触发事件
      try { this.ctx.deps.trace.onSpan(null); } catch (err) { logger.warn('[Engine] trace.onSpan cleanup error', { err }); }
      // 关闭所有 MCP 连接（await 确保子进程退出，避免孤儿进程锁定文件）
      try {
        await this.ctx.deps.mcpManager.disconnectAll();
      } catch (err) {
        logger.warn('Failed to disconnect MCP servers during engine destruction', { err });
      }
      this.ctx.deps = null;
    }
    // Phase 96 P0-1：退出前强制持久化对话历史，跳过防抖
    await this.chatBridge.flushOnShutdown();
    // Phase 97 Part H：退出前持久化 Agent 状态快照（重启重建 UI）
    try {
      this.agentStatus.persist();
    } catch (err) {
      logger.warn('[Engine] agent status persist failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Phase 48 Task 4：清理 profileManager 引用，防止 reload 后旧实例残留
    this.ctx.profileManager = null;
  }

  // ============================================================
  // Chat 领域委托（ChatBridge）
  // ============================================================

  async sendChat(
    text: string,
    remoteContext?: import('./remote/chat-stream-event-publisher.js').RemoteTurnContextInput,
  ): Promise<void> {
    // Phase 97 Part H：标记 session 运行中（主进程唯一权威状态源）
    const sessionId = remoteContext?.sessionId ?? 'desktop-local';
    this.agentStatus.markRunning(sessionId, text.slice(0, 80));
    try {
      await this.chatBridge.sendChat(text, remoteContext);
      this.agentStatus.markCompleted(sessionId);
    } catch (err) {
      // chatBridge.sendChat 内部已捕获错误并 emit，此处兜底（不向上抛）
      this.agentStatus.markError(sessionId, err instanceof Error ? err.message : String(err));
    }
    // 每轮结束后持久化快照，重启可重建
    this.agentStatus.persist();
  }

  /** Ordered event fan-out and replay journal used by the remote gateway. */
  getEventHub(): import('./remote/engine-event-hub.js').EngineEventHub {
    return this.ctx.eventHub;
  }

  isReady(): boolean {
    return this.ctx.deps !== null;
  }

  getProjectInfo(): { id: string; name: string; cwd: string } {
    const normalized = path.resolve(this.ctx.options.cwd);
    return {
      id: normalized,
      name: path.basename(normalized),
      cwd: normalized,
    };
  }

  listRemoteTools(): import('../shared/remote-protocol.js').RemoteTool[] {
    if (!this.ctx.deps) return [];
    return this.ctx.deps.registry.list().map((tool) => {
      const name = tool.definition.name;
      const mcpParts = name.startsWith('mcp__') ? name.split('__') : [];
      const mcpServerId = mcpParts.length >= 3 ? mcpParts[1] : null;
      return {
        name,
        description: tool.definition.description ?? '',
        source: mcpServerId ? 'mcp' : 'builtin',
        mcpServerId,
        allowed: true,
      };
    });
  }

  /** G-004 修复：按 requestId 解析工具确认 */
  resolveToolConfirm(
    requestId: string,
    approved: boolean,
    payload?: unknown,
    resolvedBy: 'desktop' | 'android' = 'desktop',
  ): void {
    this.chatBridge.resolveToolConfirm(requestId, approved, payload, resolvedBy);
  }

  resolvePlanEdit(requestId: string, steps: import('../shared/ipc-types.js').PlanEditRequestPayload['plan']['steps'] | null): void {
    this.chatBridge.resolvePlanEdit(requestId, steps);
  }

  /** 停止当前生成（供 IPC chat:stop 调用）；G-004：支持可选 requestId 精准中断 */
  stopGeneration(requestId?: string): void {
    this.chatBridge.stopGeneration(requestId);
  }

  /** Phase 97 Part C：重新取回未处理中断（渲染层重载恢复用） */
  reclaimInterruptions(sessionId?: string): import('../../src/agent/interruption.js').Interruption[] {
    return this.chatBridge.reclaimInterruptions(sessionId);
  }

  /** Phase 97 Part C：列出中断（可按会话过滤） */
  listInterruptions(sessionId?: string): import('../../src/agent/interruption.js').Interruption[] {
    return this.chatBridge.listInterruptions(sessionId);
  }

  /** Phase 97 Part B：列出 Turn 快照（对话级撤销入口） */
  listTurnSnapshots(sessionId?: string): Promise<import('../../src/harness/turn-snapshot.js').TurnSnapshot[]> {
    return this.chatBridge.listTurnSnapshots(sessionId);
  }

  /** Phase 97 Part B：恢复指定 turn 的快照（回退对话时同步恢复文件） */
  restoreTurn(
    turnId: string,
    sessionId?: string,
  ): Promise<import('../../src/harness/turn-snapshot.js').RestoreResult | null> {
    return this.chatBridge.restoreTurn(turnId, sessionId);
  }

  /** Phase 97 Part E：列出子会话（可按父会话过滤） */
  listSubagents(parentSessionId?: string): import('./bridges/agent-bridge.js').SubagentView[] {
    return this.agentBridge.listSubagents(parentSessionId);
  }

  /** Phase 97 Part E：获取单个子会话详情 */
  getSubagent(childSessionId: string): import('./bridges/agent-bridge.js').SubagentView | null {
    return this.agentBridge.getSubagent(childSessionId);
  }

  /** Phase 97 Part E：停止运行中的子会话 */
  stopSubagent(childSessionId: string): boolean {
    return this.agentBridge.stopSubagent(childSessionId);
  }

  /** Phase 97 Part G：解析输入框结构化引用（/ @ & ~ 前缀 + accessScope 校验） */
  resolveComposerRefs(
    text: string,
  ): import('../../src/agent/context/composer-reference.js').ComposerReference[] {
    return this.chatBridge.resolveComposerRefs(text);
  }

  async generateTitle(userMessage: string, assistantReply?: string): Promise<string> {
    return this.chatBridge.generateTitle(userMessage, assistantReply);
  }

  async executeCommand(text: string): Promise<unknown> {
    const cmd = text.trim();

    // Phase 80 Task 2：slash 命令计数（fail-open，increment 内部 catch）
    // 仅对 / 开头的命令计数，提取首个 token 作为命令名（如 /help、/clear）
    if (cmd.startsWith('/')) {
      const commandName = cmd.split(/\s+/)[0] ?? cmd;
      this.ctx.deps?.usageCounter?.increment({ kind: 'command', name: commandName });
    }

    // Phase 80 Task 2：/usage 导出命令——导出本地使用计数摘要到 .routedev/usage/ 目录
    if (cmd === '/usage') {
      return this.handleUsageExport();
    }

    return this.chatBridge.executeCommand(text);
  }

  /**
   * Phase 80 Task 2：处理 /usage 命令
   * 将本地使用计数快照导出为 JSON 文件（7 天摘要窗口），返回文件路径
   * fail-open：usageCounter 不存在或导出失败时返回友好提示
   */
  private async handleUsageExport(): Promise<{ ok: boolean; message: string; filePath?: string }> {
    const usageCounter = this.ctx.deps?.usageCounter;
    if (!usageCounter) {
      return { ok: false, message: '使用计数器未初始化' };
    }
    try {
      const pathMod = await import('node:path');
      const osMod = await import('node:os');
      // 写入项目目录下的 .routedev/usage/ 子目录（与 offload 等本地数据一致）
      const usageDir = pathMod.resolve(this.ctx.options.cwd, '.routedev', 'usage');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = pathMod.join(usageDir, `usage-${timestamp}.json`);
      await usageCounter.flushToFile(filePath);

      // 构造摘要文本（统计窗口内的计数快照）
      const snapshot = usageCounter.snapshot();
      const keyCount = Object.keys(snapshot).length;
      const totalCalls = Object.values(snapshot).reduce((sum, n) => sum + n, 0);
      const summary = `使用计数已导出（7 天摘要窗口）\n` +
        `  统计起始: ${new Date().toISOString()}\n` +
        `  计数维度: ${keyCount} 个\n` +
        `  总调用数: ${totalCalls} 次\n` +
        `  文件路径: ${filePath}\n` +
        `  主目录: ${osMod.homedir()}`;
      return { ok: true, message: summary, filePath };
    } catch (err) {
      return {
        ok: false,
        message: `导出使用计数失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  syncConversationHistory(messages: LLMMessage[]): void {
    this.chatBridge.syncConversationHistory(messages);
  }

  followUp(content: string): boolean {
    return this.chatBridge.followUp(content);
  }

  clearAllQueues(): void {
    this.chatBridge.clearAllQueues();
  }

  setFollowUpMode(mode: 'all' | 'one-at-a-time'): boolean {
    return this.chatBridge.setFollowUpMode(mode);
  }

  getQueueStatus(): { followUp: number } {
    return this.chatBridge.getQueueStatus();
  }

  getFollowUpQueue(): { role: 'follow_up'; content: string; enqueuedAt: number }[] {
    return this.chatBridge.getFollowUpQueue();
  }

  removeFollowUp(index: number): boolean {
    return this.chatBridge.removeFollowUp(index);
  }

  // ============================================================
  // Config 领域委托（ConfigBridge）
  // ============================================================

  getConfig(): AppConfig {
    return this.configBridge.getConfig();
  }

  updateConfig(newConfig: AppConfig): void {
    this.configBridge.updateConfig(newConfig);
  }

  // ============================================================
  // MCP 领域委托（MCPBridge）
  // ============================================================

  getMCPStatus(): MCPStatus {
    return this.mcpBridge.getMCPStatus();
  }

  listMCPTools(): MCPToolInfo[] {
    return this.mcpBridge.listMCPTools();
  }

  async connectServer(serverId: string): Promise<MCPConnectionResult> {
    return this.mcpBridge.connectServer(serverId);
  }

  async disconnectServer(serverId: string): Promise<MCPConnectionResult> {
    return this.mcpBridge.disconnectServer(serverId);
  }

  async installServer(payload: MCPInstallPayload): Promise<MCPInstallResult> {
    return this.mcpBridge.installServer(payload);
  }

  // ============================================================
  // Skill 领域委托（SkillBridge）
  // ============================================================

  listSkills(): SkillInfo[] {
    return this.skillBridge.listSkills();
  }

  previewSkill(name: string): SkillPreview | null {
    return this.skillBridge.previewSkill(name);
  }

  toggleSkill(name: string, enabled: boolean): boolean {
    return this.skillBridge.toggleSkill(name, enabled);
  }

  async createSkill(
    name: string,
    description: string,
    keywords: string[],
    content: string,
  ): Promise<{ success: boolean; error?: string; path?: string }> {
    return this.skillBridge.createSkill(name, description, keywords, content);
  }

  async installSkill(payload: SkillInstallPayload): Promise<{ success: boolean; error?: string; path?: string }> {
    return this.skillBridge.installSkill(payload);
  }

  async deleteSkill(name: string): Promise<{ success: boolean; error?: string }> {
    return this.skillBridge.deleteSkill(name);
  }

  async reloadSkills(): Promise<{ count: number }> {
    return this.skillBridge.reloadSkills();
  }

  routeSkills(taskDescription: string): SkillInfo[] {
    return this.skillBridge.routeSkills(taskDescription);
  }

  // ============================================================
  // Experiment 领域委托（ExperimentBridge）
  // ============================================================

  listExperiments(): ExperimentInfo[] {
    return this.experimentBridge.listExperiments();
  }

  async adoptExperiment(id: string): Promise<{ success: boolean; error?: string }> {
    return this.experimentBridge.adoptExperiment(id);
  }

  async discardExperiment(id: string): Promise<{ success: boolean; error?: string }> {
    return this.experimentBridge.discardExperiment(id);
  }

  async getExperimentDiff(
    id: string,
  ): Promise<{ diff: string; filesChanged: number; error?: string }> {
    return this.experimentBridge.getExperimentDiff(id);
  }

  // ============================================================
  // Goal 领域委托（GoalBridge）
  // ============================================================

  async listResumableGoals(): Promise<ResumableGoalIpcInfo[]> {
    return this.goalBridge.listResumableGoals();
  }

  async resumeGoal(goalId: string): Promise<{ success: boolean; error?: string }> {
    return this.goalBridge.resumeGoal(goalId);
  }

  async discardGoal(goalId: string): Promise<{ success: boolean; error?: string }> {
    return this.goalBridge.discardGoal(goalId);
  }

  async checkOmissions(goalId: string): Promise<{
    omissions: Array<{ category: string; description: string; severity: string; suggestedStep?: string }>;
    summary: string;
  }> {
    return this.goalBridge.checkOmissions(goalId);
  }

  // ============================================================
  // executeTool（保留在 RouteDevEngine，阶段3 TD-07 增加权限校验）
  // ============================================================

  // TD-07：高风险工具不允许通过 IPC 直接调用（必须经 Agent Loop）
  // 这些工具具备破坏性或副作用（执行任意命令/写文件/Git 操作/派生子 Agent/浏览器自动化），
  // 必须经过 Agent Loop 的权限确认流程，防止渲染进程被劫持后绕过确认直接调用
  // F-035 修复：加入 file_edit（文件编辑同样具备破坏性，需经 Agent Loop 确认）
  private static readonly HIGH_RISK_TOOLS = new Set([
    'shell_exec', 'file_write', 'file_edit', 'git_op', 'spawn_agent', 'browser',
  ]);

  // G-017 修复：敏感环境变量过滤已迁移至 src/security/env-filter.ts（V2-001 统一）
  // 防止云凭据/数据库密码/Token 等通过 process.env 泄露到工具子进程

  /**
   * F-080：executeTool 文档说明
   *
   * IPC 路径 intentionally 跳过 LoopDetection/Hook 中间件，因渲染进程无对话上下文；
   * 权限校验通过 PermissionEngine 直接调用。
   *
   * 安全防线：
   * 1. callContext.source === 'ipc' 校验（防止绕过 IPC 直接调）
   * 2. HIGH_RISK_TOOLS 拒绝（破坏性工具必须经 Agent Loop）
   * 3. PermissionEngine.check() 权限决策（deny/confirm 均 fail-closed）
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
    callContext?: { source: 'ipc'; requestId?: string },
  ): Promise<unknown> {
    // Phase 79 Task 4：无上下文时拒绝执行（防止绕过 Loop 直接调 IPC）
    if (!callContext || callContext.source !== 'ipc') {
      return { success: false, error: '拒绝执行：缺少有效调用上下文（必须通过 IPC 调用）' };
    }

    // TD-07：高风险工具拒绝——必须通过 Agent Loop 调用
    if (RouteDevEngine.HIGH_RISK_TOOLS.has(name)) {
      return { success: false, error: '高风险工具必须通过 Agent Loop 调用' };
    }

    if (!this.ctx.deps) return { error: '引擎未初始化' };

    // Phase 79 Task 4：复用 PermissionEngine 进行权限校验
    // IPC 无用户确认通道，deny/confirm 决策均拒绝执行；仅 auto 放行
    // Phase 94 修复：permissionEngine 未注入时 fail-closed（之前为 fail-open 跳过校验）
    const permissionEngine = this.ctx.deps.permissionEngine;
    if (!permissionEngine) {
      this.ctx.deps.audit?.log('user_deny', name, { reason: '权限引擎未初始化', source: 'ipc' }, 'failure', 'ipc');
      return { success: false, error: '权限引擎未初始化，拒绝执行（fail-closed）' };
    }
    try {
      const mode = this.ctx.config.autonomy?.defaultMode ?? 'semi';
      const decision = permissionEngine.check(name, args, mode);
      if (decision.decision === 'deny') {
        // F-069 修复：记录权限拒绝审计日志
        this.ctx.deps.audit?.log('user_deny', name, { reason: decision.reason, source: 'ipc' }, 'denied', 'ipc');
        return { success: false, error: `权限拒绝: ${decision.reason}` };
      }
      if (decision.decision === 'confirm') {
        // IPC 无确认通道，confirm 决策 fail-closed 拒绝
        // F-069 修复：记录 confirm 拒绝审计日志
        this.ctx.deps.audit?.log('user_deny', name, { reason: decision.reason, source: 'ipc', detail: 'confirm not supported via IPC' }, 'denied', 'ipc');
        return { success: false, error: `权限要求确认（IPC 不支持确认通道）: ${decision.reason}` };
      }
      // auto → 放行
    } catch (err) {
      // fail-closed：权限引擎异常时拒绝
      // F-069 修复：记录权限校验异常审计日志
      this.ctx.deps.audit?.log('user_deny', name, { error: err instanceof Error ? err.message : String(err), source: 'ipc' }, 'failure', 'ipc');
      return { success: false, error: `权限校验异常 (fail-closed): ${err instanceof Error ? err.message : String(err)}` };
    }

    // F-N016 修复：test_connection 工具未在 ToolExecutor 注册，
    // 此处内联处理——委托给 ConfigBridge.handleTestConnection 用传入的 baseUrl/apiKey
    // 临时构造 LLM 客户端做轻量连通性测试，避免渲染进程调用不存在的工具导致失败。
    if (name === 'test_connection') {
      return this.configBridge.handleTestConnection(args);
    }

    // Phase 96 P1-4：list_models 同样未在 ToolExecutor 注册，内联委托给 ConfigBridge.handleListModels
    // 临时构造 LLM 客户端调用 provider 的 list models API，返回模型 ID 列表供 UI 展示。
    if (name === 'list_models') {
      return this.configBridge.handleListModels(args);
    }

    try {
      // V2-001：统一调用 sanitizeProcessEnv 过滤敏感环境变量（替代原局部正则）
      // 防止云凭据/数据库密码/Token 等通过环境变量泄露到工具子进程
      const env = sanitizeProcessEnv(process.env);
      const result = await this.ctx.deps.toolExecutor.execute(name, args, {
        workingDirectory: this.ctx.options.cwd,
        allowedDirectories: [this.ctx.options.cwd],
        environment: env,
        timeoutMs: 30000,
      });
      return { output: result.output, success: result.success, error: result.error };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================
  // 工作目录（生命周期相关，保留在 RouteDevEngine）
  // ============================================================

  /**
   * 动态更新工作目录（用户切换项目时调用）
   * 更新后所有工具调用和系统提示词中的 cwd 都会使用新路径
   *
   * C2 修复：主进程 IPC 层已做授权校验，这里再做防御性 realpath 归一化，
   * 防止符号链接或路径绕过导致工具以非预期目录为根执行。
   */
  async setCwd(newCwd: string): Promise<void> {
    if (!newCwd || newCwd === this.ctx.options.cwd) return;
    // 防御性校验：必须是绝对路径且非系统根目录
    const pathMod = await import('node:path');
    const osMod = await import('node:os');
    const resolved = pathMod.resolve(newCwd);
    if (resolved === pathMod.parse(resolved).root) {
      logger.error('[Engine] setCwd 拒绝系统根目录', { resolved });
      return;
    }
    if (resolved === osMod.homedir()) {
      logger.error('[Engine] setCwd 拒绝用户主目录', { resolved });
      return;
    }
    this.ctx.options.cwd = resolved;
    await this.initialize();
    this.ctx.conversationHistory = [];
    logger.info('[Engine] 工作目录已切换', { resolved });
  }

  /** 获取当前工作目录 */
  getCwd(): string {
    return this.ctx.options.cwd;
  }

  // ============================================================
  // Phase 77 借鉴点 4：Voice Memo 式会话状态卡 API（跨领域聚合，保留在 RouteDevEngine）
  // ============================================================

  /**
   * 获取当前会话状态快照（驱动渲染层 SessionStatusCard 渲染）
   *
   * 数据流：renderer → IPC session:get-status → 此方法 → aggregateSessionStatus
   * 聚合源：
   *   - goalPersistence.load(currentGoalId)：取 goal.spec / plan.steps / status / token
   *   - blackboard.getSnapshot()：取 projectFacts
   * 无活跃 goal 或 goalPersistence 未启用时返回 idle 状态
   */
  async getSessionStatus(): Promise<import('../shared/ipc-types.js').SessionStatus> {
    return aggregateSessionStatus({
      goalPersistence: this.ctx.deps?.goalPersistence ?? undefined,
      currentGoalId: this.ctx.currentGoalId,
      blackboard: this.ctx.deps?.blackboard,
    });
  }

  /**
   * Phase 97 Part H：获取 Agent 状态聚合快照（驱动 AgentIsland 渲染）
   *
   * 数据源：
   *   - 内存显式标记（sendChat 生命周期 + 中断更新）
   *   - subagentRegistry：running 子会话
   *   - interruptionBroker：pending 中断 → waiting_interruption + 计数
   * 渲染层只消费此快照，不做二次推导。
   */
  getAgentStatus(): import('./agent-status-service.js').AgentStatusSnapshot {
    return this.agentStatus.getSnapshot();
  }

  /**
   * Phase 96+ A3.3：实时费用 + 缓存命中率统计快照（驱动 UI StatsBar）
   *
   * 聚合源：
   *   - tracker.getStats()：token 多维度统计
   *   - tracker.getSessionCost(costResolver)：会话费用（美元）
   *   - tracker.getUsagePercent()：日预算使用百分比
   *   - cacheStatsTracker.getStats()：缓存命中 session/turn 两层视图
   *
   * costResolver 由 AppConfig.providers 构造，合并用户配置 cost 与 catalog 默认值
   *
   * @returns stats 快照（结构见 ipc-types.ts StatsSnapshot），engine 未就绪时返回 zero 快照
   */
  async getStatsSnapshot(): Promise<import('../shared/ipc-types.js').StatsSnapshot> {
    const tracker = this.ctx.tracker;
    const cacheStats = this.ctx.cacheStatsTracker;

    // 引擎未就绪时返回 zero 快照（IPC fail-open 默认值）
    if (!tracker || !cacheStats) {
      return {
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        cost: { totalUsd: 0, byModel: {} },
        cache: {
          session: { hit: 0, miss: 0, total: 0, hitRate: 0 },
          turn: { hit: 0, miss: 0, total: 0, hitRate: 0 },
        },
        budgetUsagePercent: 0,
        activeModels: [],
        updatedAt: new Date().toISOString(),
      };
    }

    // 构造 costResolver：遍历 providers[*].models，对每个 modelId 解析 ModelCostInfo
    // 优先级：用户在 ModelConfig 中显式配置的 cost → catalog 默认值
    const providerModels = new Map<string, { input?: number; output?: number; cacheRead?: number }>();
    for (const provider of this.ctx.config.providers ?? []) {
      for (const model of provider.models ?? []) {
        // 仅取第一个匹配的同名模型（避免重复定义互相覆盖）
        if (!providerModels.has(model.id)) {
          providerModels.set(model.id, {
            input: model.inputCostPerMillion,
            output: model.outputCostPerMillion,
            cacheRead: model.cacheReadCostPerMillion,
          });
        }
      }
    }
    const costResolver = (modelId: string) => {
      const userCfg = providerModels.get(modelId);
      if (userCfg && (userCfg.input !== undefined || userCfg.output !== undefined)) {
        return {
          input: userCfg.input ?? 0,
          output: userCfg.output ?? 0,
          cacheRead: userCfg.cacheRead,
        };
      }
      // 回退到 model-catalog（内置常见模型定价）
      return lookupModelCost(modelId);
    };

    const tokenStats = tracker.getStats();
    const cost = tracker.getSessionCost(costResolver);
    const cache = cacheStats.getStats();

    return {
      tokens: tokenStats.total,
      cost,
      cache,
      budgetUsagePercent: tracker.getUsagePercent(),
      activeModels: Object.keys(tokenStats.byModel),
      updatedAt: new Date().toISOString(),
    };
  }

  // ============================================================
  // Profile 领域委托（ProfileBridge）
  // G-022a：从本文件拆分至 bridges/profile-bridge.ts
  // ============================================================

  /** 列出所有 Profile（不含 systemPrompt） */
  async listProfiles(): Promise<AgentProfileSummary[]> {
    return this.profileBridge.listProfiles();
  }

  /** 获取指定 Profile 详情（含 systemPrompt） */
  async getProfile(id: string): Promise<AgentProfileDetail | null> {
    return this.profileBridge.getProfile(id);
  }

  /** 保存 Profile（新增/更新） */
  async saveProfile(payload: ProfileSavePayload): Promise<ProfileOpResult> {
    return this.profileBridge.saveProfile(payload);
  }

  /** 删除 Profile（内置 Profile 不可删除，manager 会抛错） */
  async deleteProfile(id: string): Promise<ProfileOpResult> {
    return this.profileBridge.deleteProfile(id);
  }

  /** 复制 Profile 为自定义副本（需传入新名称） */
  async duplicateProfile(id: string, newName: string): Promise<ProfileOpResult> {
    return this.profileBridge.duplicateProfile(id, newName);
  }

  /** 从 SKILL.md 文件导入 Profile（自动分配新 id 避免冲突） */
  async importProfile(inputPath: string): Promise<ProfileOpResult> {
    return this.profileBridge.importProfile(inputPath);
  }

  /** 列出指定 Profile 的所有版本元数据（按时间倒序） */
  async listProfileVersions(profileId: string): Promise<VersionMeta[]> {
    return this.profileBridge.listVersions(profileId);
  }

  /** 获取指定版本完整记录（含 snapshot） */
  async getProfileVersion(profileId: string, versionId: string): Promise<VersionRecord | null> {
    return this.profileBridge.getVersion(profileId, versionId);
  }

  /** 回滚到指定版本 */
  async rollbackProfile(profileId: string, versionId: string): Promise<ProfileOpResult> {
    return this.profileBridge.rollbackProfile(profileId, versionId);
  }

  /** 比较两个版本的字段差异 */
  async diffProfileVersions(
    profileId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<FieldDiff[]> {
    return this.profileBridge.diffVersions(profileId, fromVersionId, toVersionId);
  }

  /** 比较当前 Profile 与指定历史版本的字段差异 */
  async diffProfileCurrentWith(
    profileId: string,
    targetVersionId: string,
  ): Promise<FieldDiff[]> {
    return this.profileBridge.diffCurrentWith(profileId, targetVersionId);
  }

  // ============================================================
  // Hook 领域委托（HookBridge）
  // G-022a：从本文件拆分至 bridges/hook-bridge.ts
  // fail-open：底层模块调用失败时返回默认值，不抛异常
  // ============================================================

  /** 列出所有 Hook 配置 */
  async listHooks(): Promise<HookInfo[]> {
    return this.hookBridge.listHooks();
  }

  /** 启用/禁用 Hook */
  async toggleHook(
    id: string,
    enabled: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    return this.hookBridge.toggleHook(id, enabled);
  }

  /**
   * 创建新 Hook（模板模式 / 自定义模式）
   * 模板模式：{ templateId: string }
   * 自定义模式：{ name, event, code, description?, priority?, condition?, failBehavior? }
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
    return this.hookBridge.createHook(payload);
  }

  /** 列出所有内置 Hook 模板（供 UI 选择） */
  listHookTemplates(): import('../../src/hooks/templates.js').HookTemplate[] {
    return this.hookBridge.listHookTemplates();
  }

  /** 删除自定义 Hook */
  async deleteHook(id: string): Promise<{ success: boolean; error?: string }> {
    return this.hookBridge.deleteHook(id);
  }

  // ============================================================
  // Checkpoint 领域委托（TraceBridge）
  // G-022a：从本文件拆分至 bridges/trace-bridge.ts
  // fail-open：底层 CheckpointManager 不存在时返回空数组/默认值
  // ============================================================

  /**
   * 列出当前项目的所有检查点
   * @param projectId 项目 ID（当前未使用，CheckpointManager 已按工作目录隔离）
   */
  listCheckpoints(projectId?: string): import('../../src/harness/types.js').Checkpoint[] {
    return this.traceBridge.listCheckpoints(projectId);
  }

  /**
   * 回滚到指定检查点
   * 注意：这是破坏性操作（git reset --hard），调用方（UI）必须在执行前获得用户确认
   */
  async rollbackCheckpoint(checkpointId: string): Promise<{ success: boolean; error?: string }> {
    return this.traceBridge.rollbackCheckpoint(checkpointId);
  }

  // ============================================================
  // Trace 领域委托（TraceBridge）——Phase 77 运行回放与评分卡
  // G-022a：从本文件拆分至 bridges/trace-bridge.ts
  // ============================================================

  /** 列出磁盘上的 Trace 会话（按 startTime 倒序） */
  async listTraceSessions(limit?: number): Promise<import('../../src/harness/trace-types.js').TraceSession[]> {
    return this.traceBridge.listTraceSessions(limit);
  }

  /** 回放指定会话，返回时间线事件；传入 step 时仅返回该步骤段落 */
  async replayTrace(sessionId: string, step?: number): Promise<import('../../src/harness/trace-replayer.js').TimelineEvent[]> {
    return this.traceBridge.replayTrace(sessionId, step);
  }

  /** 生成指定会话的评分卡 */
  async generateTraceScorecard(sessionId: string): Promise<import('../../src/harness/scorecard.js').Scorecard | null> {
    return this.traceBridge.generateTraceScorecard(sessionId);
  }
}
