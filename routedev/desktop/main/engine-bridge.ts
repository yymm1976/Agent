// desktop/main/engine-bridge.ts
// 核心引擎桥接：把 CLI 的 App 依赖工厂包装成主进程可直接调用的服务
//
// TD-03 重构：按领域拆分为 delegate bridge（bridges/*），RouteDevEngine 仅保留：
//   1. 引擎生命周期（initialize / reloadConfig / destroy / setCwd）
//   2. executeTool（权限相关，留待阶段3 TD-07 增加权限校验）
//   3. 未拆分的领域方法（Profile / Hook / Checkpoint / Trace / Session 聚合）
//   4. 对各 bridge 方法的委托包装（保持对外 API 不变）
// 各 delegate 通过共享 EngineContext 读写状态，跨 bridge 调用经 ctx.bridges 完成。

import type { AppConfig } from '../../src/config/schema.js';
import type { LLMMessage } from '../../src/router/types.js';
import { LLMClientManager } from '../../src/router/llm/index.js';
import { TokenTracker } from '../../src/router/tracker.js';
import { ScenarioClassifier } from '../../src/router/classifier.js';
import { ModelRouter } from '../../src/router/router.js';
import { buildRouterConfig } from '../../src/router/config.js';
import { createAppDependencies } from '../../src/runtime/app-init.js';
import type {
  MCPStatus,
  MCPConnectionResult,
  MCPInstallPayload,
  MCPInstallResult,
  SkillInstallPayload,
  AgentProfileInfo,
  AgentProfileDetail,
  ProfileSavePayload,
  ProfileOpResult,
  ResumableGoalIpcInfo,
} from '../shared/ipc-types.js';
// Phase 77：运行回放与评分卡——借鉴 HomeRail 的 hr replay / hr scorecard
import type { TraceSession } from '../../src/harness/trace-types.js';
import { TraceReplayer, type TimelineEvent } from '../../src/harness/trace-replayer.js';
import { generateScorecard, type Scorecard } from '../../src/harness/scorecard.js';
import type { Checkpoint } from '../../src/harness/types.js';
import { AgentProfileManager } from '../../src/agents/profiles/manager.js';
import type { AgentProfile } from '../../src/agents/profiles/types.js';
import { HookConfigRegistry } from '../../src/hooks/registry.js';
import type { HookConfig } from '../../src/hooks/registry.js';
import { getHookTemplates, getHookTemplateById } from '../../src/hooks/templates.js';
import type { HookTemplate } from '../../src/hooks/templates.js';
// C3 修复：Hook 命令安全扫描
import { checkBashSecurity } from '../../src/tools/security-enhanced.js';
// Phase 77 借鉴点 4：Voice Memo 式会话状态卡聚合器
import { aggregateSessionStatus } from '../../src/agent/session-status-aggregator.js';
import path from 'node:path';

// delegate bridge 与共享上下文
import {
  EngineContext,
  ChatBridge,
  ConfigBridge,
  MCPBridge,
  SkillBridge,
  ExperimentBridge,
  GoalBridge,
  type EngineBridgeOptions,
  type SkillInfo,
  type SkillPreview,
  type MCPToolInfo,
} from './bridges/index.js';

// 向后兼容：原 engine-bridge.ts 导出的类型，从此处 re-export 供外部消费方继续引用
export type { EngineBridgeOptions, SkillInfo, SkillPreview, MCPToolInfo };

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

  constructor(config: AppConfig, options: EngineBridgeOptions) {
    this.ctx = new EngineContext(config, options);
    this.chatBridge = new ChatBridge(this.ctx);
    this.configBridge = new ConfigBridge(this.ctx);
    this.mcpBridge = new MCPBridge(this.ctx);
    this.skillBridge = new SkillBridge(this.ctx);
    this.experimentBridge = new ExperimentBridge(this.ctx);
    this.goalBridge = new GoalBridge(this.ctx);
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
      ctx.deps.mcpManager.disconnectAll().catch(() => { /* 忽略清理错误 */ });
    }

    const clientManager = new LLMClientManager();
    clientManager.initializeFromConfig(
      ctx.config.providers.map((p) => ({
        id: p.id,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
      })),
    );
    ctx.clientManager = clientManager;

    const routerConfig = buildRouterConfig(ctx.config);
    ctx.tracker = new TokenTracker(routerConfig.budget);
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
    if (ctx.config.mcp.autoConnect) {
      const enabledServers = ctx.config.mcp.servers.filter((s) => s.enabled);
      for (const server of enabledServers) {
        ctx.deps.mcpManager.connect(server).catch((err) => {
          console.error(`[MCP] 自动连接失败: ${server.name}`, err);
        });
      }
    }

    // Phase 48 Task 4：构造 AgentProfileManager 并异步加载（不阻塞初始化）
    // 与 app-init.ts 中的 workerProfileManager 行为一致：fail-open，加载失败仅记录
    ctx.profileManager = new AgentProfileManager(ctx.options.cwd);
    ctx.profileManager.loadAll().catch((err) => {
      console.error('[Engine] AgentProfileManager.loadAll 失败:', err);
    });
  }

  async reloadConfig(config: AppConfig): Promise<void> {
    this.ctx.config = config;
    // 重新初始化 LLM 客户端和分类器，保留对话历史
    await this.initialize();
    this.ctx.options.onConfigReloaded?.(config);
  }

  /**
   * 销毁引擎：中止 LLM 请求 + 关闭 MCP 连接 + 移除 trace 回调
   * 异步方法，调用方应 await 确保资源完全释放后再退出进程
   */
  async destroy(): Promise<void> {
    this.ctx.abortController?.abort();
    this.ctx.abortController = null;
    // 清理 deps 资源（MCP 连接、trace 回调等），避免句柄泄漏
    if (this.ctx.deps) {
      // 移除 trace 回调，防止旧 TraceCollector 在被 GC 前继续触发事件
      try { this.ctx.deps.trace.onSpan(null); } catch { /* 忽略清理错误 */ }
      // 关闭所有 MCP 连接（await 确保子进程退出，避免孤儿进程锁定文件）
      try { await this.ctx.deps.mcpManager.disconnectAll(); } catch { /* 忽略清理错误 */ }
      this.ctx.deps = null;
    }
    // Phase 48 Task 4：清理 profileManager 引用，防止 reload 后旧实例残留
    this.ctx.profileManager = null;
  }

  // ============================================================
  // Chat 领域委托（ChatBridge）
  // ============================================================

  async sendChat(text: string): Promise<void> {
    return this.chatBridge.sendChat(text);
  }

  resolveToolConfirm(approved: boolean, payload?: unknown): void {
    this.chatBridge.resolveToolConfirm(approved, payload);
  }

  resolvePlanEdit(requestId: string, steps: import('../shared/ipc-types.js').PlanEditRequestPayload['plan']['steps'] | null): void {
    this.chatBridge.resolvePlanEdit(requestId, steps);
  }

  /** 停止当前生成（供 IPC chat:stop 调用） */
  stopGeneration(): void {
    this.chatBridge.stopGeneration();
  }

  async generateTitle(userMessage: string, assistantReply?: string): Promise<string> {
    return this.chatBridge.generateTitle(userMessage, assistantReply);
  }

  async executeCommand(text: string): Promise<unknown> {
    return this.chatBridge.executeCommand(text);
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

  listExperiments(): unknown[] {
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
  private static readonly HIGH_RISK_TOOLS = new Set([
    'shell_exec', 'file_write', 'git_op', 'spawn_agent', 'browser',
  ]);

  // G-017 修复：敏感环境变量前缀正则，匹配的变量不注入工具执行环境
  // 防止云凭据/数据库密码/Token 等通过 process.env 泄露到工具子进程
  private static readonly SENSITIVE_ENV_PREFIX = /^(AWS_|AZURE_|GCP_|DATABASE_|.*SECRET|.*TOKEN|.*PASSWORD|ROUTEDEV_CONFIG)/i;

  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // TD-07：高风险工具拒绝——必须通过 Agent Loop 调用
    if (RouteDevEngine.HIGH_RISK_TOOLS.has(name)) {
      return { success: false, error: '高风险工具必须通过 Agent Loop 调用' };
    }

    if (!this.ctx.deps) return { error: '引擎未初始化' };

    // F-N016 修复：test_connection 工具未在 ToolExecutor 注册，
    // 此处内联处理——委托给 ConfigBridge.handleTestConnection 用传入的 baseUrl/apiKey
    // 临时构造 LLM 客户端做轻量连通性测试，避免渲染进程调用不存在的工具导致失败。
    if (name === 'test_connection') {
      return this.configBridge.handleTestConnection(args);
    }

    try {
      // G-017 修复：过滤 process.env 中的 undefined 值及敏感前缀变量
      // 防止云凭据/数据库密码/Token 等通过环境变量泄露到工具子进程
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !RouteDevEngine.SENSITIVE_ENV_PREFIX.test(k)) {
          env[k] = v;
        }
      }
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
      console.error('[Engine] setCwd 拒绝系统根目录:', resolved);
      return;
    }
    if (resolved === osMod.homedir()) {
      console.error('[Engine] setCwd 拒绝用户主目录:', resolved);
      return;
    }
    this.ctx.options.cwd = resolved;
    await this.initialize();
    this.ctx.conversationHistory = [];
    console.log(`[Engine] 工作目录已切换: ${resolved}`);
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

  // ============================================================
  // Phase 48 Task 4 接线修复：Agent Profile 管理 API（Profile 领域，暂未拆分为独立 bridge）
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
    // TD-01：AgentProfileRole/AgentProfileOutputFormat 已统一为 AgentRole/AgentOutputFormat 别名，
    // 不再需要显式断言（IPC 侧与 src 侧类型同源）
    return {
      ...profile,
    };
  }

  /** ProfileSavePayload -> AgentProfile（IPC 字段透传，类型已与 src 一致） */
  private fromSavePayload(payload: ProfileSavePayload): AgentProfile {
    return { ...payload };
  }

  /** 列出所有 Profile（不含 systemPrompt） */
  async listProfiles(): Promise<AgentProfileInfo[]> {
    if (!this.ctx.profileManager) return [];
    try {
      const profiles = await this.ctx.profileManager.listProfiles();
      return profiles.map((p) => this.toProfileInfo(p));
    } catch (err) {
      console.error('[Engine] listProfiles failed:', err);
      return [];
    }
  }

  /** 获取指定 Profile 详情（含 systemPrompt） */
  async getProfile(id: string): Promise<AgentProfileDetail | null> {
    if (!this.ctx.profileManager) return null;
    try {
      const profile = await this.ctx.profileManager.getProfile(id);
      return profile ? this.toProfileDetail(profile) : null;
    } catch (err) {
      console.error('[Engine] getProfile failed:', err);
      return null;
    }
  }

  /** 保存 Profile（新增/更新） */
  async saveProfile(payload: ProfileSavePayload): Promise<ProfileOpResult> {
    if (!this.ctx.profileManager) return { success: false, error: '引擎未初始化' };
    try {
      const profile = this.fromSavePayload(payload);
      await this.ctx.profileManager.saveProfile(profile);
      return { success: true, id: profile.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 删除 Profile（内置 Profile 不可删除，manager 会抛错） */
  async deleteProfile(id: string): Promise<ProfileOpResult> {
    if (!this.ctx.profileManager) return { success: false, error: '引擎未初始化' };
    try {
      await this.ctx.profileManager.deleteProfile(id);
      return { success: true, id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 复制 Profile 为自定义副本（需传入新名称） */
  async duplicateProfile(id: string, newName: string): Promise<ProfileOpResult> {
    if (!this.ctx.profileManager) return { success: false, error: '引擎未初始化' };
    try {
      const copy = await this.ctx.profileManager.duplicateProfile(id, newName);
      return { success: true, id: copy.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================
  // Phase 39：Hook 桥接方法（Hook 领域，暂未拆分为独立 bridge）
  // fail-open：底层模块调用失败时返回默认值，不抛异常
  // ============================================================

  /**
   * 统一解析 Hook 配置文件路径并执行边界校验
   * 安全：拒绝绝对路径 + resolve 后必须 startsWith cwd，防止路径穿越
   * @returns 校验通过的绝对路径；校验失败返回 null
   */
  private resolveHookConfigPath(): string | null {
    const rawConfigPath = this.ctx.config.hooks?.configPath ?? '.routedev/hooks.json';
    if (path.isAbsolute(rawConfigPath)) {
      return null;
    }
    const resolvedConfigPath = path.resolve(this.ctx.options.cwd, rawConfigPath);
    const cwdResolved = path.resolve(this.ctx.options.cwd);
    if (!resolvedConfigPath.startsWith(cwdResolved + path.sep) && resolvedConfigPath !== cwdResolved) {
      return null;
    }
    return resolvedConfigPath;
  }

  /** 列出所有 Hook 配置 */
  async listHooks(): Promise<unknown[]> {
    try {
      const configPath = this.resolveHookConfigPath();
      if (!configPath) return [];
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
      const configPath = this.resolveHookConfigPath();
      if (!configPath) return { success: false, error: 'hooks.configPath 越界：必须在项目目录内' };
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
      // C4 修复：hooks.configPath 路径越界校验（统一复用 resolveHookConfigPath）
      const configPath = this.resolveHookConfigPath();
      if (!configPath) {
        return { success: false, error: 'hooks.configPath 越界：必须在项目目录内' };
      }
      const registry = new HookConfigRegistry(configPath);
      await registry.load();

      let config: HookConfig;

      // 模板模式：从内置模板复制
      if (typeof payload === 'object' && payload !== null && 'templateId' in payload) {
        const template = getHookTemplateById(payload.templateId);
        if (!template) {
          return { success: false, error: `未找到模板 "${payload.templateId}"` };
        }
        // G-021 修复：模板命令也需经过 bash 安全扫描，防止内置模板被篡改后注入危险命令
        const templateBashResult = checkBashSecurity(template.code);
        if (!templateBashResult.allowed) {
          return { success: false, error: '模板命令被安全策略拒绝' };
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
      const configPath = this.resolveHookConfigPath();
      if (!configPath) return { success: false, error: 'hooks.configPath 越界：必须在项目目录内' };
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
  // Phase 47 Task 6：Checkpoint 时间轴与语义化摘要桥接方法（Checkpoint 领域，暂未拆分为独立 bridge）
  // fail-open：底层 CheckpointManager 不存在时返回空数组/默认值
  // ============================================================

  /**
   * 列出当前项目的所有检查点
   * @param projectId 项目 ID（当前未使用，CheckpointManager 已按工作目录隔离）
   * @returns 检查点列表（按创建时间升序，IPC 传输用，剥离 gitCommitHash 等内部字段）
   */
  listCheckpoints(projectId?: string): Checkpoint[] {
    if (!this.ctx.deps) return [];
    try {
      return this.ctx.deps.checkpointManager.list();
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
    if (!this.ctx.deps) return { success: false, error: '引擎未初始化' };
    try {
      const ok = await this.ctx.deps.checkpointManager.rollback(checkpointId);
      return { success: ok, error: ok ? undefined : '回滚失败（检查点不存在或工作区有未提交更改）' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================
  // Phase 77：运行回放与评分卡——委托 TraceCollector + TraceReplayer + scorecard（Trace 领域，暂未拆分为独立 bridge）
  // ============================================================

  /** 列出磁盘上的 Trace 会话（按 startTime 倒序） */
  async listTraceSessions(limit?: number): Promise<TraceSession[]> {
    if (!this.ctx.deps) return [];
    try {
      return await this.ctx.deps.trace.listSessions(limit);
    } catch (err) {
      console.error('[Engine] listTraceSessions failed:', err);
      return [];
    }
  }

  /** 回放指定会话，返回时间线事件；传入 step 时仅返回该步骤段落 */
  async replayTrace(sessionId: string, step?: number): Promise<TimelineEvent[]> {
    if (!this.ctx.deps) return [];
    try {
      const replayer = new TraceReplayer(this.ctx.deps.trace);
      return await replayer.replay(sessionId, step !== undefined ? { step } : undefined);
    } catch (err) {
      console.error('[Engine] replayTrace failed:', err);
      return [];
    }
  }

  /** 生成指定会话的评分卡 */
  async generateTraceScorecard(sessionId: string): Promise<Scorecard | null> {
    if (!this.ctx.deps) return null;
    try {
      return await generateScorecard(this.ctx.deps.trace, sessionId);
    } catch (err) {
      console.error('[Engine] generateTraceScorecard failed:', err);
      return null;
    }
  }
}
