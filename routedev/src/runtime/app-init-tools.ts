// src/runtime/app-init-tools.ts
// 工具子系统装配：ToolRegistry、ToolExecutor、SecurityChecker、PermissionEngine、PolicyEngine
// 从 app-init.ts 拆分（TD-02），保持功能完全等价
//
// 职责：
//   1. ToolRegistry + 全部内置工具注册（file/shell/git/web/code/vfs/plan/notes/todo/ccr）
//   2. ConfigGuard / CommandSandbox 安全注入
//   3. MCPClientManager + McpSecurityScanner
//   4. SecurityChecker / ToolExecutor / ToolRegistryAdapter / GuardedToolExecutorAdapter
//   5. ReActAgentLoop 创建 + 基础注入（trace/recallInjector/virtualFS/planState/profiler/sanitizer）
//   6. BudgetMonitor 动态 import（fail-open）
//   7. PermissionEngine + TrustGradientManager（动态 import，fail-open）
//   8. PolicyEngine（Intent Guard / Playbook / Tool Guide / Tool Approval）
//   9. SkillsRouter + FilesystemDiscovery
//   10. ToolResultSanitizer + ToolOutputPipeline
//
// 注意：profiler 和 BudgetMonitor 因依赖 agentLoop（本模块创建），暂置于本模块。
// 后续可通过调整调用顺序迁移到 observability 子模块。

import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { SecurityChecker } from '../tools/security.js';
import { ToolRegistryAdapter } from '../tools/adapter.js';
import { FileReadTool } from '../tools/builtin/file-read.js';
import { FileWriteTool } from '../tools/builtin/file-write.js';
import { FileEditTool } from '../tools/builtin/file-edit.js';
import { FileSearchTool } from '../tools/builtin/file-search.js';
import { ListDirectoryTool } from '../tools/builtin/list-directory.js';
import { ShellExecTool } from '../tools/builtin/shell-exec.js';
import { GitOpTool } from '../tools/builtin/git-op.js';
import { WebSearchTool } from '../tools/builtin/web-search.js';
import { WebFetchTool } from '../tools/builtin/web-fetch.js';
import { CodeSearchTool } from '../tools/builtin/code-search.js';
import { CodeGraphQueryTool } from '../tools/builtin/code-graph-query.js';
import { RepoMapTool } from '../tools/builtin/repo-map.js';
import { TodoWriteTool } from '../tools/builtin/todo-write.js';
import { AskUserTool } from '../tools/builtin/ask-user.js';
import { TodoStore } from '../tools/builtin/todo-store.js';
import { NotesTool } from '../tools/builtin/notes-tool.js';
import { NotesManager } from '../agent/memory/notes.js';
import { createVFS } from '../agent/context/virtual-fs.js';
import { VfsReadTool, VfsWriteTool, VfsListTool, VfsDeleteTool } from '../agent/tools/vfs-tool.js';
import { PlanState } from '../agent/context/plan-state.js';
import { PlanGetTool, PlanSetTool, PlanUpdateStepTool, PlanAddStepTool, PlanRemoveStepTool } from '../agent/tools/plan-tool.js';
import { createDefaultEngine, type PermissionEngine } from '../tools/permission-engine.js';
import { MCPClientManager } from '../tools/mcp/client.js';
import { ReActAgentLoop } from '../agent/loop.js';
import { TokenProfiler } from '../agent/token-profiler.js';
import { WorkModeController, GuardedToolExecutorAdapter } from '../agent/work-modes.js';
import { ReadTracker, createReadTracker } from '../tools/read-tracker.js';
import { ToolResultSanitizer, createToolResultSanitizer } from '../tools/result-sanitizer.js';
import { ToolOutputPipeline } from '../agent/context/tool-output-pipeline.js';
import { CCRRetrieveTool } from '../tools/builtin/ccr-retrieve.js';
import { ConfigGuard } from '../tools/builtin/config-guard.js';
import { CommandSandbox } from '../security/sandbox.js';
import { McpSecurityScanner } from '../tools/mcp/security-scanner.js';
import { PolicyEngine } from '../policies/policy-engine.js';
import { createBuiltinIntentGuardPolicies } from '../policies/intent-guard.js';
import { createBuiltinPlaybookPolicies } from '../policies/playbook.js';
import { createBuiltinToolGuidePolicies } from '../policies/tool-guide.js';
import { createBuiltinToolApprovalPolicies } from '../policies/tool-approval.js';
import { SkillsRouter, FilesystemDiscovery } from '../plugins/filesystem-discovery.js';
import { CapabilityPackRegistry } from '../plugins/capability-pack-registry.js';
import { CommandRegistry, PackEventBus } from '../plugins/capability-pack.js';
import type { PackContext } from '../plugins/capability-pack.js';
import { PackDiscovery } from '../plugins/pack-discovery.js';
import { UsageCounter } from '../observability/usage-counter.js';
import { logger } from '../utils/logger.js';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { InitContext, AppDependencies } from './app-init.js';
// F-075：常量提取到 utils/constants.ts
import { TOOL_EXECUTION_TIMEOUT_MS } from '../utils/constants.js';

/**
 * 创建工具子系统
 * 包含：ToolRegistry、全部内置工具、ToolExecutor、SecurityChecker、PermissionEngine、PolicyEngine、AgentLoop
 *
 * @param ctx 共享装配上下文（读取 config/cwd/trace/contextManager/recallInjector/ccrCache/offload*，写入 registry/agentLoop/toolExecutor/...）
 * @returns 工具子系统依赖片段
 */
export function createToolSubsystem(ctx: InitContext): Partial<AppDependencies> {
  const { config, cwd, trace, recallInjector, ccrCache, offloadSessionId, offloadRootDir } = ctx;

  // ===== 工具链 =====
  // Phase 81 Task 1：工具默认注册收口——按 profile 档位注册
  // - core（默认）：仅注册 ≤10 个核心工具，覆盖编程场景基础能力
  // - full：兼容旧行为，注册全部工具（仅调试用）
  const toolProfile = config.tools?.profile ?? 'core';
  const isFullProfile = toolProfile === 'full';

  const registry = new ToolRegistry();
  // Phase 53 Task 7：提取 fileEditTool / fileWriteTool 实例，供 ConfigGuard 注入
  const fileEditTool = new FileEditTool();
  const fileWriteTool = new FileWriteTool();
  // [I-5] 提取 shellExecTool 实例，供 CommandSandbox 注入
  const shellExecTool = new ShellExecTool();

  // --- Core 工具（始终注册，≤10 个） ---
  // file_read / file_search / git_op / code_search
  // fileWriteTool / shellExecTool 已提取为实例变量供后续注入
  [FileReadTool, FileSearchTool, GitOpTool, CodeSearchTool]
    .forEach(T => registry.register(new T()));
  registry.register(fileWriteTool);             // file_write
  registry.register(shellExecTool);              // shell_exec
  registry.register(fileEditTool);               // file_edit
  registry.register(new ListDirectoryTool());    // list_directory
  // P1-5：任务列表工具
  const todoStore = new TodoStore();
  registry.register(new TodoWriteTool(todoStore)); // todo_write
  registry.register(new AskUserTool());             // ask_user

  // --- 非 Core 工具的依赖对象（始终创建，供 agentLoop 注入） ---
  // P0-1：笔记工具需注入 NotesManager（observability 子系统已写入 trace，此处非空）
  // F-031 类型安全：trace 可选，用 ?. 替代 ! 断言
  const sessionDir = path.join(homedir(), '.qoderwork', 'routedev', 'sessions', trace?.getSessionId() ?? `app-${Date.now()}`);
  const notesManager = new NotesManager(sessionDir);
  // Phase 71 Task E1：进程内 VFS（与 agentLoop 共享同一实例，loop 通过 setVirtualFS 注入）
  const virtualFS = createVFS();
  // Phase 71 Task E2：显式 plan 状态（复用 virtualFS，loop 通过 setPlanState 注入）
  const planState = new PlanState(virtualFS);

  // --- 非 Core 工具（仅 full profile 注册，冷处理不删除源码） ---
  if (isFullProfile) {
    // web_search → standard-pack
    registry.register(new WebSearchTool());
    // Phase 34 Task 4：Repo Map 代码检索增强 → standard-pack
    registry.register(new RepoMapTool());
    // 短板 2 修复：代码地图查询工具 → standard-pack
    registry.register(new CodeGraphQueryTool());
    // P1-7：网页抓取工具 → standard-pack
    registry.register(new WebFetchTool());
    // [I-5] BrowserTool（P3.8）：动态 import 注册，避免静态解析失败 → standard-pack
    const browserToolModulePath = '../tools/builtin/browser.js';
    import(browserToolModulePath)
      .then(({ BrowserTool }) => {
        registry.register(new BrowserTool());
        logger.debug('BrowserTool registered');
      })
      .catch((err) => { logger.warn('BrowserTool fail-open', { error: err instanceof Error ? err.message : String(err) }); });
    // notes → standard-pack
    registry.register(new NotesTool(notesManager));
    // VFS 4 工具 → standard-pack
    registry.register(new VfsReadTool(virtualFS));
    registry.register(new VfsWriteTool(virtualFS));
    registry.register(new VfsListTool(virtualFS));
    registry.register(new VfsDeleteTool(virtualFS));
    // Plan 5 工具 → extended-pack
    registry.register(new PlanGetTool(planState));
    registry.register(new PlanSetTool(planState));
    registry.register(new PlanUpdateStepTool(planState));
    registry.register(new PlanAddStepTool(planState));
    registry.register(new PlanRemoveStepTool(planState));
    // Phase 55 Task 9：CCR 取回工具 → standard-pack
    if (config.ccrCompression?.enabled) {
      // memory 子系统在 ccrCompression.enabled 时已写入 ccrCache，此处非空
      registry.register(new CCRRetrieveTool(ccrCache!));
    }
  }

  // Phase 53 Task 7：ConfigGuard 注入（受 config.phase53Integration.configGuard.enabled 守护）
  // 启用后 file_edit / file_write 在执行前会检查是否弱化安全/治理配置
  // Phase 59 Task 2：configGuard 默认 true，加 fail-open 守卫——装配失败不阻塞主流程
  const phase53GuardCfg = config.phase53Integration?.configGuard;
  if (phase53GuardCfg?.enabled) {
    try {
      const configGuard = new ConfigGuard({
        warnOnFirst: phase53GuardCfg.warnOnFirst,
        protectedPatterns: phase53GuardCfg.protectedPatterns,
      });
      fileEditTool.setConfigGuard(configGuard);
      fileWriteTool.setConfigGuard(configGuard);
      logger.debug('ConfigGuard injected', { via: 'setConfigGuard' });
    } catch (err) {
      logger.warn('Phase 59: configGuard 装配失败，fail-open 跳过', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // [I-1 补充] FileEditTool 注入 requireConfirmation 开关（Phase 73）
  // 读取 config.tools.fileEdit.requireConfirmation（默认 false，向后兼容）
  fileEditTool.setRequireConfirmation(config.tools?.fileEdit?.requireConfirmation ?? false);

  // [I-5] CommandSandbox 注入 ShellExecTool
  // 为 shell_exec 增加前置校验：危险命令模式拦截（rm -rf /、format、del /f 等）
  // 默认不配置白/黑名单（仅危险模式检测），避免误拦正常构建命令
  // fail-open：装配失败不阻塞主流程，ShellExecTool 仍可正常工作（仅缺少沙箱前置校验）
  try {
    const sandbox = new CommandSandbox({
      timeout: TOOL_EXECUTION_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
    });
    shellExecTool.setSandbox(sandbox);
    logger.debug('CommandSandbox injected into ShellExecTool', { via: 'setSandbox' });
  } catch (err) {
    logger.warn('[I-5] CommandSandbox 装配失败，fail-open 跳过', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Phase 48 Task 4（Kimi F-025 修复）：传入 lifecyclePolicy 默认值，避免配置僵尸
  const mcpManager = new MCPClientManager(registry, config.mcp.lifecyclePolicy);
  // CONCERN 修复：传入 MCP 配置，使 connectTimeout 和 autoReconnect 生效
  mcpManager.setMcpConfig(config.mcp);
  const securityChecker = new SecurityChecker(cwd, config.security, config.permissionProfile);
  const toolExecutor = new ToolExecutor(registry);
  toolExecutor.setSecurityChecker(securityChecker);
  // Phase 80 Task 2：注入使用计数器到 ToolExecutor（observability 子系统已写入 ctx.usageCounter）
  if (ctx.usageCounter) {
    toolExecutor.setUsageCounter(ctx.usageCounter);
  }
  // 修复：将配置中的 webSearch API Key 注入到工具环境变量，供 web_search 工具读取
  const webSearchEnv: Record<string, string> = {};
  if (config.webSearch?.glmApiKey) webSearchEnv['GLM_WEB_SEARCH_API_KEY'] = config.webSearch.glmApiKey;
  if (config.webSearch?.metasoApiKey) webSearchEnv['METASO_API_KEY'] = config.webSearch.metasoApiKey;
  if (config.webSearch?.baiduApiKey) webSearchEnv['BAIDU_API_KEY'] = config.webSearch.baiduApiKey;
  if (config.webSearch?.tavilyApiKey) webSearchEnv['TAVILY_API_KEY'] = config.webSearch.tavilyApiKey;
  if (config.webSearch?.bingApiKey) webSearchEnv['BING_SEARCH_API_KEY'] = config.webSearch.bingApiKey;
  if (config.webSearch?.perplexityApiKey) webSearchEnv['PERPLEXITY_API_KEY'] = config.webSearch.perplexityApiKey;
  if (config.webSearch?.exaApiKey) webSearchEnv['EXA_API_KEY'] = config.webSearch.exaApiKey;
  if (config.webSearch?.braveApiKey) webSearchEnv['BRAVE_SEARCH_API_KEY'] = config.webSearch.braveApiKey;
  if (config.webSearch?.searxngEndpoint) webSearchEnv['SEARXNG_ENDPOINT'] = config.webSearch.searxngEndpoint;

  const adapter = new ToolRegistryAdapter(registry, toolExecutor, {
    workingDirectory: cwd,
    allowedDirectories: [cwd],
    // F-051 类型安全：过滤 undefined 后再断言，避免 process.env 中 undefined 值混入
    environment: Object.fromEntries(
      Object.entries({ ...process.env, ...webSearchEnv }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
    timeoutMs: TOOL_EXECUTION_TIMEOUT_MS,
  });
  // Phase 34：让工具执行通过 TraceCollector 记录 span
  // setTraceCollector 接受 null 不接受 undefined，用 ?? null 转换
  adapter.setTraceCollector(trace ?? null);
  const workModeController = new WorkModeController();
  // Phase 32 Task 1.3：先创建 ReadTracker，供 GuardedToolExecutorAdapter 使用
  // 配置开关：optimization.safety.readBeforeWrite（默认 true）
  const readTracker = createReadTracker(cwd);
  const readBeforeWriteEnabled = config.optimization?.safety?.readBeforeWrite !== false;
  const guardedAdapter = new GuardedToolExecutorAdapter(adapter, workModeController, readTracker, readBeforeWriteEnabled);
  // 传入 autoApprovePatterns：从 config.autonomy 读取，让只读安全工具自动批准
  // 匹配的工具跳过用户确认，写入/执行类工具仍需确认
  const agentLoop = new ReActAgentLoop(guardedAdapter, {
    maxIterations: 50,
    toolsEnabled: true,
    autoApprovePatterns: config.autonomy?.autoApprovePatterns ?? [],
  });
  // Phase 34：注入 TraceCollector，记录 LLM 调用与循环事件
  // setTraceCollector 接受 null 不接受 undefined，用 ?? null 转换
  agentLoop.setTraceCollector(trace ?? null);

  // Phase 71 Task B3：注入记忆召回注入器到 agentLoop
  // run() 在 systemPrompt 处理完后调用 recallInjector.recallToPrompt(userMessage)
  // 把 KnowledgeGraph 中相关记忆格式化为【相关记忆】片段追加到 systemPrompt
  // setRecallInjector 接受 null 不接受 undefined，用 ?? null 转换
  agentLoop.setRecallInjector(recallInjector ?? null);

  // Phase 71 Task E1：注入 VirtualFS 到 agentLoop
  // loop 持有同一 VFS 实例（与上方注册的 4 个 VFS 工具共享），保证工具层与 loop 状态一致
  agentLoop.setVirtualFS(virtualFS);

  // Phase 71 Task E2：注入 PlanState 到 agentLoop
  // loop 持有同一 PlanState 实例（内部复用 virtualFS），保证工具层与 loop 状态一致
  agentLoop.setPlanState(planState);

  // 任务1：注入 ComposePipeline，让 Compose 模式具备阶段提示词注入和自动流转能力
  // Phase 81 Task 4：packs.compose.enabled 门控（standard-pack，默认 false 退出装配）
  //   未启用时注入 null，loop 走原始行为（无 compose 阶段流转）；enabled:true 恢复装配
  agentLoop.setComposePipeline(
    config.packs?.compose?.enabled === true ? workModeController.getComposePipeline() : null,
  );
  // 任务3：注入简洁思考约束开关（来自 optimization.conciseThinking.enabled，默认 false）
  agentLoop.setConciseThinking(config.optimization?.conciseThinking?.enabled === true);

  // Phase 30 Task 1：Token Profiler（可观测性）
  // 默认开启——可观测性不应是实验性的
  const profiler = config.optimization?.tokenTracking?.enabled !== false
    ? new TokenProfiler()
    : null;
  if (profiler) {
    agentLoop.setProfiler(profiler);
  }

  // Phase 53 Task 9：预算监控（受 config.phase53Integration.budgetMonitor.enabled 守护，fail-open）
  // tokenLimit 取自 config.router.budget.dailyLimit（默认 500000），避免在 BudgetMonitorConfigSchema 重复定义
  const phase53BudgetCfg = config.phase53Integration?.budgetMonitor;
  if (phase53BudgetCfg?.enabled) {
    const budgetMonitorModulePath = '../agent/budget-monitor.js';
    import(budgetMonitorModulePath)
      .then((mod: { BudgetMonitor: new (opts: { tokenLimit: number; costLimit?: number; tokenWarnRatio?: number; toolLoopThreshold?: number }) => import('../agent/budget-monitor.js').BudgetMonitor }) => {
        const monitor = new mod.BudgetMonitor({
          tokenLimit: config.router.budget.dailyLimit,
          costLimit: phase53BudgetCfg.costLimitPerSession,
          tokenWarnRatio: phase53BudgetCfg.tokenWarnRatio,
          toolLoopThreshold: phase53BudgetCfg.toolLoopThreshold,
        });
        // setBudgetMonitor 已在 ReActAgentLoop 声明；保留 typeof 守卫兼容装配顺序
        if (typeof agentLoop.setBudgetMonitor === 'function') {
          agentLoop.setBudgetMonitor(monitor);
          logger.debug('BudgetMonitor injected', {
            via: 'setBudgetMonitor',
            tokenLimit: config.router.budget.dailyLimit,
          });
        }
      })
      .catch((err) => { logger.warn('BudgetMonitor fail-open', { error: err instanceof Error ? err.message : String(err) }); });
  }

  // ===== 权限引擎 =====
  const permissionEngine = createDefaultEngine();
  // Phase 48 Task 1：从配置应用沙箱级与审批级覆盖（交互模式生效）
  if (config.security?.sandbox) {
    permissionEngine.setSandboxLevel(config.security.sandbox);
  }
  if (config.security?.approval) {
    for (const [category, level] of Object.entries(config.security.approval)) {
      permissionEngine.setApproval(category as never, level);
    }
  }

  // ===== Phase 40：渐进式信任 / 质量监测 / 用户经验 接线 =====
  // 4.1 TrustGradientManager 接线
  //     构造函数接受 sessionId，接线后注入 PermissionEngine（若引擎支持）
  // 注：TrustGradient 的 .then() 回调异步执行，permissionEngine 已在上方同步创建
  // Phase 79: TrustGradient Freeze — 仅静态档位配置 + 用户显式临时授权，不做会话内动态升级
  //   setLevel(baseLevel) 一次设定后不再动态调整；PermissionEngine.check() 已旁路 level-based 动态决策
  // Phase 81 Task 3：packs.trustGradient.enabled 门控（freeze 层 F-01，默认 false 退出装配）
  const trustCfg = config.trust;
  if (trustCfg && config.packs?.trustGradient?.enabled) {
    const trustModulePath = '../tools/trust-gradient.js';
    import(trustModulePath)
      .then((mod: { TrustGradientManager: new (sessionId: string, level?: string) => import('../tools/trust-gradient.js').TrustGradientManager }) => {
        const sessionId = trace!.getSessionId() ?? `app-${Date.now()}`;
        const trustManager = new mod.TrustGradientManager(sessionId, trustCfg.baseLevel);
        trustManager.setLevel(trustCfg.baseLevel);
        // setTrustGradientManager 已在 PermissionEngine 声明；保留 typeof 守卫兼容装配顺序
        if (typeof permissionEngine.setTrustGradientManager === 'function') {
          permissionEngine.setTrustGradientManager(trustManager);
        }
        logger.info('TrustGradientManager registered', {
          baseLevel: trustCfg.baseLevel,
          enableTemporaryGrants: trustCfg.enableTemporaryGrants,
          grantTTLMinutes: trustCfg.grantTTLMinutes,
        });
      })
      .catch((err: unknown) => {
        logger.debug('TrustGradientManager not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 42：PolicyEngine 接线（策略引擎） =====
  // Intent Guard + Playbook + Tool Guide + Tool Approval
  // 模块通过静态 import 加载，接线断裂在编译期暴露；运行时仍 try-catch 防止注册逻辑异常阻塞主流程
  const policiesCfg = config.policies;
  const phase53PolicyCfg = config.phase53Integration?.policyEngine;
  if (policiesCfg?.enabled !== false) {
    try {
      const engine = new PolicyEngine();
      // Phase 53 Task 3：设置默认策略（fail-closed 控制）
      // phase53Integration.policyEngine.enabled=false 时 setPolicyEngine 不被调用，loop 不接入策略引擎
      // phase53Integration.policyEngine.enabled=true 时按 defaultPolicy 设置（默认 'deny'）
      if (phase53PolicyCfg?.enabled && typeof engine.setDefaultPolicy === 'function') {
        engine.setDefaultPolicy(phase53PolicyCfg.defaultPolicy ?? 'deny');
      }
      // 根据配置添加内置策略（Intent Guard / Playbook / Tool Guide / Tool Approval）
      if (policiesCfg.intentGuard !== false) {
        for (const p of createBuiltinIntentGuardPolicies()) {
          engine.addPolicy(p);
        }
      }
      if (policiesCfg.playbook !== false) {
        for (const p of createBuiltinPlaybookPolicies()) {
          engine.addPolicy(p);
        }
      }
      if (policiesCfg.toolGuide !== false) {
        for (const p of createBuiltinToolGuidePolicies()) {
          engine.addPolicy(p);
        }
      }
      if (policiesCfg.toolApproval !== false) {
        for (const p of createBuiltinToolApprovalPolicies(policiesCfg.approvalMode)) {
          engine.addPolicy(p);
        }
      }
      // setPolicyEngine 已在 ReActAgentLoop 声明；保留 typeof 守卫兼容装配顺序
      if (typeof agentLoop.setPolicyEngine === 'function') {
        agentLoop.setPolicyEngine(engine);
      }
      logger.info('PolicyEngine registered', {
        intentGuard: policiesCfg.intentGuard,
        playbook: policiesCfg.playbook,
        toolGuide: policiesCfg.toolGuide,
        toolApproval: policiesCfg.toolApproval,
        approvalMode: policiesCfg.approvalMode,
      });
    } catch (err: unknown) {
      // 运行时异常（如策略构造/注册失败）记录但不阻塞主流程；模块缺失已在编译期暴露
      logger.warn('PolicyEngine registration failed, skip policy engine', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ===== Skills 系统（Phase 37：按需加载 Markdown Skill） =====
  // 状态持久化到 ~/.qoderwork/routedev/skill-state.json（与 plugin-state.json 同目录）
  const skillStatePath = path.join(homedir(), '.qoderwork', 'routedev', 'skill-state.json');
  const skillsRouter = new SkillsRouter(skillStatePath);
  const filesystemDiscovery = new FilesystemDiscovery(cwd);
  // 异步发现并注册 Skill（不阻塞 App 初始化）
  filesystemDiscovery.discoverSkills().then((skills) => {
    for (const skill of skills) {
      skillsRouter.register(skill);
    }
    logger.info('Skills discovered and registered', { count: skills.length });
  }).catch((err) => {
    logger.warn('Failed to discover skills', { error: err instanceof Error ? err.message : String(err) });
  });

  // ===== Phase 32 Task 1：工具结果净化 + ToolOutputPipeline =====
  // 2. ToolResultSanitizer——工具结果净化（注入检测 + 智能截断）
  //    maxOutputChars 来自配置 optimization.safety.maxToolOutputChars（默认 16000）
  const maxOutputChars = config.optimization?.safety?.maxToolOutputChars ?? 16000;
  const resultSanitizer = createToolResultSanitizer(maxOutputChars);
  // Phase 32 Task 1.2：将 sanitizer 注入 agentLoop，所有工具结果在注入 LLM 上下文前都会经过净化
  agentLoop.setSanitizer(resultSanitizer);

  // Phase 71 Task D3/D7：注入 ToolOutputPipeline（统一 Sanitizer / Concise Thinking / Budget Offload 三阶段）
  // pipeline 未注入时 loop 走原 sanitizeToolResult 逻辑（零回归）；注入后收拢到一处编排
  // 配置消费链：phase70Integration.toolOutputBudget.enabled + optimization.conciseThinking.enabled
  const p70Cfg = ctx.p70Cfg;
  const toolBudgetCfg = p70Cfg?.toolOutputBudget;
  agentLoop.setToolOutputPipeline(new ToolOutputPipeline({
    sanitizer: resultSanitizer,
    conciseThinkingEnabled: config.optimization?.conciseThinking?.enabled === true,
    budgetEnabled: toolBudgetCfg?.enabled === true,
    // observability 子系统已写入 offloadRootDir，此处非空
    offloadDir: offloadRootDir!,
    maxChars: toolBudgetCfg?.maxCharsPerOutput ?? 2000,
    sessionId: offloadSessionId,
    // Phase 72 Task B2：ContentRouter 按内容类型分派压缩（默认关闭，零回归）
    contentRoutingEnabled: config.optimization?.contentRouting?.enabled === true,
  }));
  // Phase 32 Task 4.2：将 sanitizer 注入 MCPClientManager，检测 MCP 工具描述中的注入模式
  mcpManager.setSanitizer(resultSanitizer);
  // Phase 53 Task 5：McpSecurityScanner 注入（受 config.phase53Integration.mcpSecurityScan.enabled 守护）
  // 启用后 MCP 工具注册前会扫描 4 类威胁（投毒/仿冒/隐藏指令/地毯式替换）
  // Phase 59 Task 2：mcpSecurityScan 默认 true，加 fail-open 守卫——装配失败不阻塞主流程
  const phase53McpScanCfg = config.phase53Integration?.mcpSecurityScan;
  if (phase53McpScanCfg?.enabled) {
    try {
      const scanner = new McpSecurityScanner({
        knownToolNames: phase53McpScanCfg.knownToolNames,
        blockThreshold: phase53McpScanCfg.blockThreshold,
      });
      mcpManager.setSecurityScanner(scanner);
      logger.debug('McpSecurityScanner injected', { via: 'setSecurityScanner' });
    } catch (err) {
      logger.warn('Phase 59: mcpSecurityScan 装配失败，fail-open 跳过', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ===== Phase 82 Task 1：Pack 加载阶段 =====
  // 创建 Pack 注册表和上下文，通过 PackDiscovery 发现所有 Pack（内置 + 用户自建），加载 enabled 的 Pack
  // 约束：
  //   - PackDiscovery 扫描项目级 / 全局 / 内置三处 Pack 目录（fail-open）
  //   - Pack 加载失败不影响 Core 主流程（loadEnabled 内部 fail-open）
  //   - 整个发现+注册+加载流程异步执行（fire-and-forget），不阻塞 App 初始化
  const packRegistry = new CapabilityPackRegistry();
  const commandRegistry = new CommandRegistry();
  const packEventBus = new PackEventBus();
  // 组装 PackContext（observability 子系统已写入 ctx.usageCounter，fallback 防御性兜底）
  const packCtx: PackContext = {
    tools: registry,
    commands: commandRegistry,
    events: packEventBus,
    config,
    logger,
    usage: ctx.usageCounter ?? new UsageCounter(),
  };
  // 异步发现 + 注册 + 加载（不阻塞 App 初始化）
  // PackDiscovery.discover() 读取文件系统 + 动态 import，全部 fail-open
  (async () => {
    // 1. 发现所有 Pack（项目级 > 全局 > 内置，按 id 去重）
    const discovery = new PackDiscovery(process.cwd(), homedir());
    const discovered = await discovery.discover();

    // 2. 注册到 registry（fail-open：单个注册失败不阻断其他）
    for (const { pack } of discovered) {
      try {
        packRegistry.register(pack);
      } catch (err) {
        logger.warn('[app-init-tools] Pack 注册失败，fail-open 跳过', {
          id: pack.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. 加载已启用的 Pack
    await packRegistry.loadEnabled(packCtx);
  })().catch((err) => {
    logger.warn('[app-init-tools] Pack 发现/加载异常，fail-open 跳过', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // 写回共享上下文，供 agent 子系统消费
  ctx.registry = registry;
  ctx.mcpManager = mcpManager;
  ctx.toolExecutor = toolExecutor;
  ctx.securityChecker = securityChecker;
  ctx.adapter = adapter;
  ctx.guardedAdapter = guardedAdapter;
  ctx.workModeController = workModeController;
  ctx.readTracker = readTracker;
  ctx.readBeforeWriteEnabled = readBeforeWriteEnabled;
  ctx.webSearchEnv = webSearchEnv;
  ctx.permissionEngine = permissionEngine;
  ctx.skillsRouter = skillsRouter;
  ctx.filesystemDiscovery = filesystemDiscovery;
  ctx.resultSanitizer = resultSanitizer;
  ctx.virtualFS = virtualFS;
  ctx.planState = planState;
  ctx.agentLoop = agentLoop;
  ctx.profiler = profiler;
  // F-018：packRegistry 不再写入 ctx（对外暴露的僵尸字段已移除）

  return {
    registry,
    mcpManager,
    toolExecutor,
    agentLoop,
    // Phase 79 Task 4：暴露 permissionEngine 供 IPC tool:execute 复用权限校验
    permissionEngine,
    skillsRouter,
    filesystemDiscovery,
    profiler,
    // F-018：packRegistry 不再对外暴露（僵尸字段已移除）
  };
}
