// src/runtime/app-init-tools.ts
// 工具子系统装配：ToolRegistry、ToolExecutor、SecurityChecker、PermissionEngine、PolicyEngine
// 从 app-init.ts 拆分（TD-02），保持功能完全等价
//
// 职责：
//   1. ToolRegistry + 全部内置工具注册（file/shell/git/web/code/vfs/plan/notes/todo/ccr）
//   2. ConfigGuard / CommandSandbox 安全注入
//   3. MCPClientManager + McpSecurityScanner
//   4. SecurityChecker / ToolExecutor / ToolRegistryAdapter / GuardedToolExecutorAdapter
//   5. PermissionEngine + TrustGradientManager（动态 import，fail-open）
//   6. PolicyEngine（Intent Guard / Playbook / Tool Guide / Tool Approval）→ 写入 ctx 供 agent 子系统注入
//   7. SkillsRouter + FilesystemDiscovery
//   8. ToolResultSanitizer + ToolOutputPipeline → 写入 ctx 供 agent 子系统注入
//
// Phase 94 Task 3：ReActAgentLoop 创建 + 所有 setXxx 注入（含 BudgetMonitor）已迁移至 agent 子系统
// （app-init-agent-loop.ts setupAgentLoop 开头）。profiler 仍由本模块创建（作为返回值 + 写入 ctx.profiler）。

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
// Phase 97 Part D：工作区管理器
import { WorkspaceManager } from '../workspace/manager.js';
import { MCPClientManager } from '../tools/mcp/client.js';
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
// V2-002：统一环境变量白名单过滤，防止 process.env 敏感信息透传到工具子进程
import { filterProcessEnvByWhitelist } from '../security/env-filter.js';

/**
 * 创建工具子系统
 * 包含：ToolRegistry、全部内置工具、ToolExecutor、SecurityChecker、PermissionEngine、PolicyEngine
 *
 * @param ctx 共享装配上下文（读取 config/cwd/trace/contextManager/recallInjector/ccrCache/offload*，写入 registry/toolExecutor/policyEngine/toolOutputPipeline/...）
 * @returns 工具子系统依赖片段
 */
export function createToolSubsystem(ctx: InitContext): Partial<AppDependencies> {
  const { config, cwd, trace, ccrCache, offloadSessionId, offloadRootDir } = ctx;

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
    // Phase 55 Task 9：CCR 取回工具 → standard-pack
    // G-F016 修复：受 config.packs.ccrCompression.enabled 门控
    if (config.ccrCompression?.enabled && config.packs?.ccrCompression?.enabled) {
      // memory 子系统在 ccrCompression.enabled 时已写入 ccrCache，此处非空
      registry.register(new CCRRetrieveTool(ccrCache!));
    }
  }

  // --- VFS / Plan 工具（Core，默认可用，无需 Pack 门控） ---
  // G-F017 修复：对齐 CAPABILITY_LAYERS.md 为 Core，从 isFullProfile 块移出
  // VFS 4 工具 → Core
  registry.register(new VfsReadTool(virtualFS));
  registry.register(new VfsWriteTool(virtualFS));
  registry.register(new VfsListTool(virtualFS));
  registry.register(new VfsDeleteTool(virtualFS));
  // Plan 5 工具 → Core
  registry.register(new PlanGetTool(planState));
  registry.register(new PlanSetTool(planState));
  registry.register(new PlanUpdateStepTool(planState));
  registry.register(new PlanAddStepTool(planState));
  registry.register(new PlanRemoveStepTool(planState));

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
  // Phase 89：注入安全配置，启用工具黑白名单检查（在 SecurityChecker 之前的额外拦截）
  toolExecutor.setSecurityConfig(config.security);
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
    // V2-002：先用白名单过滤 process.env，再合并 webSearchEnv（已过白名单的 web search 相关 env）
    environment: {
      ...filterProcessEnvByWhitelist(process.env),
      ...webSearchEnv,
    },
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
  // Phase 94 Task 3：agentLoop 创建 + 所有 setXxx 注入（trace/recallInjector/contextManager/virtualFS/
  //   planState/composePipeline/conciseThinking/profiler/budgetMonitor/policyEngine/sanitizer/
  //   toolOutputPipeline）已迁移至 agent 子系统（app-init-agent-loop.ts setupAgentLoop 开头）
  // 此处仅保留 tools 子系统需要的中间产物创建：
  //   - profiler：仍由 tools 子系统创建（作为返回值 + 写入 ctx.profiler 供 agent 子系统注入）
  //   - PolicyEngine：tools 子系统创建，写入 ctx.policyEngine 供 agent 子系统注入
  //   - ToolOutputPipeline：tools 子系统创建，写入 ctx.toolOutputPipeline 供 agent 子系统注入

  // Phase 30 Task 1：Token Profiler（可观测性）
  // 默认开启——可观测性不应是实验性的
  // Phase 94 Task 3：setProfiler 调用已迁移至 agent 子系统，此处仅创建实例
  const profiler = config.optimization?.tokenTracking?.enabled !== false
    ? new TokenProfiler()
    : null;

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

  // ===== Phase 97 Part D：工作区管理器 + 路径边界注入 =====
  // 工作区作为 Skill/MCP/记忆/权限的统一作用域；文件类工具先过工作区授权范围校验。
  // 未激活工作区时 isPathAllowed 返回 true（fail-open，不改变现有行为）。
  const workspaceManager = new WorkspaceManager();
  void workspaceManager.load(); // fire-and-forget，load 幂等且未加载时 fail-open
  permissionEngine.setPathBoundaryResolver((absPath) => ({
    allowed: workspaceManager.isPathAllowed(workspaceManager.getActiveWorkspaceId(), absPath),
  }));
  ctx.workspaceManager = workspaceManager;

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
      // Phase 94 Task 3：PolicyEngine 实例写入 ctx，供 agent 子系统注入到 agentLoop
      ctx.policyEngine = engine;
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
  // P2-5：注册内置 skills 目录（src/skills/builtin/），随软件分发
  // 内置 skills 优先级低于用户 .routedev/skills（同名时用户覆盖内置）
  filesystemDiscovery.addSkillsRoot(path.join(__dirname, '..', 'skills', 'builtin'));
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
  //    maxOutputChars 来自配置 optimization.safety.maxToolOutputChars（默认 8000）
  const maxOutputChars = config.optimization?.safety?.maxToolOutputChars ?? 8000;
  const resultSanitizer = createToolResultSanitizer(maxOutputChars);
  // Phase 32 Task 1.2：将 sanitizer 注入 agentLoop 已迁移至 agent 子系统（Phase 94 Task 3）

  // Phase 71 Task D3/D7：注入 ToolOutputPipeline（统一 Sanitizer / Concise Thinking / Budget Offload 三阶段）
  // pipeline 未注入时 loop 走原 sanitizeToolResult 逻辑（零回归）；注入后收拢到一处编排
  // 配置消费链：phase70Integration.toolOutputBudget.enabled + optimization.conciseThinking.enabled
  // Phase 94 Task 3：ToolOutputPipeline 实例写入 ctx，供 agent 子系统注入到 agentLoop
  const p70Cfg = ctx.p70Cfg;
  const toolBudgetCfg = p70Cfg?.toolOutputBudget;
  const toolOutputPipeline = new ToolOutputPipeline({
    sanitizer: resultSanitizer,
    conciseThinkingEnabled: config.optimization?.conciseThinking?.enabled === true,
    budgetEnabled: toolBudgetCfg?.enabled === true,
    // observability 子系统已写入 offloadRootDir，此处非空
    offloadDir: offloadRootDir!,
    maxChars: toolBudgetCfg?.maxCharsPerOutput ?? 2000,
    sessionId: offloadSessionId,
    // Phase 72 Task B2：ContentRouter 按内容类型分派压缩（默认关闭，零回归）
    contentRoutingEnabled: config.optimization?.contentRouting?.enabled === true,
  });
  ctx.toolOutputPipeline = toolOutputPipeline;
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
  // Phase 94 Task 3：ctx.agentLoop 不再由 tools 子系统写入（agentLoop 创建迁移至 agent 子系统）
  ctx.profiler = profiler;
  // F-018：packRegistry 不再写入 ctx（对外暴露的僵尸字段已移除）

  return {
    registry,
    mcpManager,
    toolExecutor,
    // Phase 94 Task 3：agentLoop 不再由 tools 子系统返回（创建迁移至 agent 子系统）
    // Phase 79 Task 4：暴露 permissionEngine 供 IPC tool:execute 复用权限校验
    permissionEngine,
    // Phase 97 Part D：暴露工作区管理器（能力边界作用域）
    workspaceManager,
    skillsRouter,
    filesystemDiscovery,
    profiler,
    // F-018：packRegistry 不再对外暴露（僵尸字段已移除）
  };
}
