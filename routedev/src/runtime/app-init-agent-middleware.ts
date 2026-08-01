// src/runtime/app-init-agent-middleware.ts
// Agent 中间件子系统装配：插件系统 + 各类中间件 + Hooks
// 从 app-init-agent.ts 拆分（Phase 92 / TD-08），保持功能完全等价
//
// 职责：
//   1. 插件系统创建（createPluginSystem）+ 注入 Agent Loop
//   2. LoopDetection / MentionResolver / ExplorationBudget / SkillMention 中间件注册
//   3. CodeMapContextMiddleware 动态 import 接线（fail-open）
//   4. QualitySignalMiddleware + ExpertisePromptMiddleware 动态 import 接线（fail-open）
//   5. Hook 系统（HookRunner + registerBuiltinHooks + HookConfigRegistry + HookEnhancementManager）
//
// 依赖：tools 子系统（registry/agentLoop）、observability 子系统（trace/audit）

import { createPluginSystem } from './plugin-init.js';
import { LoopDetectionMiddleware } from '../agent/middleware/loop-detection.js';
import { MentionResolverMiddleware } from '../agent/middleware/mention-resolver.js';
import { ExplorationBudgetMiddleware } from '../agent/middleware/exploration-budget-middleware.js';
import { SkillMentionMiddleware } from '../agent/middleware/skill-mention-middleware.js';
import { HookRunner } from '../agent/hooks.js';
import { registerBuiltinHooks } from '../hooks/built-in.js';
import { HookEnhancementManager } from '../hooks/hook-enhancement.js';
import { getHookTemplates } from '../hooks/templates.js';
// F-001 修复：Hook 路径越界校验 + 命令安全扫描（共享模块）
import { resolveHookConfigPath, assertHookCommandSafe } from '../hooks/security.js';
import { logger } from '../utils/logger.js';
import * as path from 'node:path';
import type { InitContext } from './app-init.js';

/**
 * 装配 Agent 中间件子系统
 * 包含：插件系统 + 各类中间件 + Hook 系统
 *
 * @param ctx 共享装配上下文（读取 config/cwd/registry/agentLoop/trace/audit/currentModel，写入 hookRunner）
 * @returns pluginSystem（供 trust/loop 复用）+ hookRunner（最终依赖片段）
 */
export function setupAgentMiddleware(ctx: InitContext): {
  pluginSystem: ReturnType<typeof createPluginSystem>;
  hookRunner: HookRunner;
} {
  const { config, cwd, registry, agentLoop, trace, audit, currentModel } = ctx;

  // ===== 插件系统 =====
  const pluginSystem = createPluginSystem(cwd, registry!);
  // 将插件系统的中间件管线注入 Agent Loop
  agentLoop!.setMiddlewarePipeline(pluginSystem.middlewarePipeline);

  const loopDetectionCfg = config.middleware?.loopDetection;
  if (loopDetectionCfg?.enabled !== false) {
    const loopDetection = new LoopDetectionMiddleware({
      windowSize: loopDetectionCfg?.windowSize,
      maxRepeats: loopDetectionCfg?.maxRepeats,
    });
    pluginSystem.middlewarePipeline.register('onReasoning', loopDetection.getHandler());
    logger.info('LoopDetectionMiddleware registered', {
      windowSize: loopDetectionCfg?.windowSize ?? 10,
      maxRepeats: loopDetectionCfg?.maxRepeats ?? 3,
    });
  }

  const mentionResolver = new MentionResolverMiddleware(cwd);
  pluginSystem.middlewarePipeline.register('onUserMessage', mentionResolver.getHandler());
  logger.info('MentionResolverMiddleware registered', { cwd });

  // Phase 94：注册 ExplorationBudgetMiddleware 到 onActing 阶段
  // 主 Agent 连续调用 N 次只读工具未分发时，注入提示建议改用 spawn_agent
  const explorationMiddleware = new ExplorationBudgetMiddleware();
  pluginSystem.middlewarePipeline.register('onActing', explorationMiddleware.getHandler());
  logger.info('ExplorationBudgetMiddleware registered', { budget: 5 });

  // Phase 94：注册 SkillMentionMiddleware 到 onUserMessage 阶段
  // 用户消息提及"按 XXX Skill 流程执行"时，注入 spawn_agent 强约束提示
  const skillMentionMiddleware = new SkillMentionMiddleware();
  pluginSystem.middlewarePipeline.register('onUserMessage', skillMentionMiddleware.getHandler());
  logger.info('SkillMentionMiddleware registered');

  // ===== Phase 39：CodeMapContextMiddleware 接线（fail-open 动态 import） =====
  // Phase 81 Task 4：packs.codeMap.enabled 门控（standard-pack，默认 false 退出装配）
  const codegraphCfg = config.codegraph;
  if (codegraphCfg && ctx.enabledPacks.codeMap) {
    const codeMapModulePath = '../agent/middleware/code-map-context.js';
    import(codeMapModulePath)
      .then((mod: { CodeMapContextMiddleware: new (cwd: string, budgetTokens?: number) => { getHandler: () => import('../agent/middleware.js').MiddlewareHandler } }) => {
        const budgetTokens = config.codeMap?.budgetTokens ?? 2048;
        const codeMapMiddleware = new mod.CodeMapContextMiddleware(cwd, budgetTokens);
        pluginSystem.middlewarePipeline.register('onSystemPrompt', codeMapMiddleware.getHandler());
        logger.info('CodeMapContextMiddleware registered', {
          budgetTokens,
          enabled: codegraphCfg.enabled,
        });
      })
      .catch((err: unknown) => {
        logger.debug('CodeMapContextMiddleware not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 4.2 QualitySignalMiddleware 接线（Implicit Feedback，freeze 层 F-02）
  // Phase 81 Task 3：packs.trustGradient.enabled 门控 + enableImplicitFeedback 默认 false
  const qualityCfg = config.quality;
  if (qualityCfg?.enableImplicitFeedback !== false && ctx.enabledPacks.trustGradient) {
    const qualityModulePath = '../agent/middleware/quality-signal.js';
    import(qualityModulePath)
      .then((mod: { QualitySignalMiddleware: new (opts?: unknown) => { getHandler: () => import('../agent/middleware.js').MiddlewareHandler } }) => {
        const qualityMiddleware = new mod.QualitySignalMiddleware({
          negativeSignalThreshold: qualityCfg.negativeSignalThreshold,
          signalRetentionDays: qualityCfg.signalRetentionDays,
          autoImproveKnowledgeGraph: qualityCfg.autoImproveKnowledgeGraph,
          debounceMs: qualityCfg.debounceMs,
        });
        pluginSystem.middlewarePipeline.register('onActing', qualityMiddleware.getHandler());
        logger.info('QualitySignalMiddleware registered', {
          negativeSignalThreshold: qualityCfg.negativeSignalThreshold,
          signalRetentionDays: qualityCfg.signalRetentionDays,
        });
      })
      .catch((err: unknown) => {
        logger.debug('QualitySignalMiddleware not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 4.3 ExpertisePromptMiddleware 接线（Experience Adaptation，freeze 层 F-06）
  // Phase 81 Task 3：packs.trustGradient.enabled 门控
  const expertiseCfg = config.expertise;
  if (expertiseCfg && ctx.enabledPacks.trustGradient) {
    const expertiseManagerPath = '../config/expertise-manager.js';
    const expertiseMiddlewarePath = '../agent/middleware/expertise-prompt.js';
    Promise.all([
      import(expertiseManagerPath),
      import(expertiseMiddlewarePath),
    ])
      .then(async ([mgrMod, mwMod]: [unknown, unknown]) => {
        const ManagerCtor = (mgrMod as { ExpertiseManager: new (p: string) => { load: () => Promise<void> } }).ExpertiseManager;
        const MiddlewareCtor = (mwMod as { ExpertisePromptMiddleware: new (m: unknown) => { getHandler: () => import('../agent/middleware.js').MiddlewareHandler } }).ExpertisePromptMiddleware;
        const expertiseManager = new ManagerCtor(path.join(cwd, '.routedev', 'expertise.json'));
        await expertiseManager.load();
        const expertiseMiddleware = new MiddlewareCtor(expertiseManager);
        pluginSystem.middlewarePipeline.register('onSystemPrompt', expertiseMiddleware.getHandler());
        logger.info('ExpertisePromptMiddleware registered', {
          level: expertiseCfg.level,
          enableAutoSuggestion: expertiseCfg.enableAutoSuggestion,
        });
      })
      .catch((err: unknown) => {
        logger.debug('ExpertisePromptMiddleware not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  const hookRunner = new HookRunner();
  hookRunner.setTraceCollector(trace!);
  registerBuiltinHooks(hookRunner, audit!, cwd, currentModel);
  // C6 修复：将 HookRunner 注入 agentLoop
  agentLoop!.setHookRunner(hookRunner);

  // ===== Phase 39：HookConfigRegistry → HookRunner 接线（fail-open 动态 import） =====
  const hooksCfg = config.hooks;
  if (hooksCfg?.enabled !== false) {
    const registryModulePath = '../hooks/registry.js';
    import(registryModulePath)
      .then(async (mod: { HookConfigRegistry: new (configPath: string) => { load: () => Promise<void>; list: () => Array<{ id: string; enabled: boolean; [key: string]: unknown }>; get: (id: string) => { id: string; enabled: boolean; [key: string]: unknown } | undefined; add: (config: { id: string; enabled: boolean; [key: string]: unknown }) => void } }) => {
        // F-001 修复：路径越界校验（拒绝绝对路径和穿越 cwd 的相对路径）
        const configPath = resolveHookConfigPath(cwd, hooksCfg.configPath);
        if (!configPath) {
          logger.warn('hooks.configPath 越界，跳过 Hook 加载', { configPath: hooksCfg.configPath });
          return;
        }
        const hookRegistry = new mod.HookConfigRegistry(configPath);
        await hookRegistry.load();

        // 注册内置 Hook 模板到 HookConfigRegistry
        const templates = getHookTemplates();
        let templatesAdded = 0;
        for (const template of templates) {
          if (hookRegistry.get(template.id)) continue;
          hookRegistry.add({
            id: template.id,
            name: template.name,
            event: template.event,
            enabled: false,
            condition: template.condition,
            command: template.code,
            failBehavior: template.failBehavior,
            isTemplate: true,
            priority: template.priority,
          });
          templatesAdded++;
        }
        if (templatesAdded > 0) {
          logger.info('Hook 模板已注册到 Registry', { count: templatesAdded });
        }

        const configs = hookRegistry.list();
        let registered = 0;
        for (const cfg of configs) {
          if (cfg.enabled === false) continue;
          // F-001 修复：注册前对 Hook 命令执行安全扫描，拒绝危险命令
          const cmd = typeof cfg.command === 'string' ? cfg.command : '';
          if (cmd) {
            const safety = assertHookCommandSafe(cmd);
            if (!safety.ok) {
              logger.warn('Hook 命令被安全策略拒绝，跳过注册', {
                hookId: cfg.id,
                reason: safety.reason,
              });
              continue;
            }
          }
          try {
            const adapterModulePath = '../hooks/adapter.js';
            const adapterMod = await import(adapterModulePath) as { configToDefinition: (cfg: unknown) => import('../agent/hooks.js').HookDefinition };
            const def = adapterMod.configToDefinition(cfg);
            hookRunner.register(def);
            registered++;
          } catch (err) {
            logger.warn('Hook 注册失败，跳过', {
              hookId: cfg.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        logger.info('HookConfigRegistry 接线完成', {
          configPath: hooksCfg.configPath,
          total: configs.length,
          registered,
        });
      })
      .catch((err: unknown) => {
        logger.debug('HookConfigRegistry not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

 const hookEnhancementCfg = config.hookEnhancement;
 // 注册命令安全审查钩子：对 shell_exec / git_op 的命令参数进行危险模式检测
  hookRunner.register({
    event: 'post-tool-call',
    name: 'builtin:command-safety-review',
    priority: 40,
    handler: async (hookCtx) => {
      const toolName = hookCtx.toolName;
      const command = hookCtx.toolArgs?.command as string | undefined;
      if (!command || (toolName !== 'shell_exec' && toolName !== 'git_op')) {
        return { action: 'continue' };
      }
      const { safe, risks } = HookEnhancementManager.analyzeCommand(command);
      if (!safe) {
        return {
          action: 'warn',
          message: `⚠️ 命令安全警告: ${risks.join('; ')}`,
        };
      }
      return { action: 'continue' };
    },
  });
  logger.info('HookEnhancementManager registered', {
    functionHooks: hookEnhancementCfg?.functionHooks,
    sandbox: hookEnhancementCfg?.sandbox,
    trialDays: hookEnhancementCfg?.trialDays,
    hookGroups: hookEnhancementCfg?.hookGroups,
  });

  // 写回共享上下文，供门面模块或其他子系统消费
  ctx.hookRunner = hookRunner;

  return { pluginSystem, hookRunner };
}
