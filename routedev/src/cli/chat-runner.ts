// src/cli/chat-runner.ts
// 聊天运行器：从 App.tsx 提取的非命令输入处理逻辑
// 负责：分类路由 → 视觉处理 → Agent Loop 迭代 → Token 统计 → 检查点/压缩

import type { LLMMessage, ILLMClient, ScenarioTier, RoutingResult } from '../router/types.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { TokenTracker } from '../router/tracker.js';
import type { ReActAgentLoop } from '../agent/loop.js';
import type { TokenProfiler } from '../agent/token-profiler.js';
import type { ContextManager } from '../agent/memory/context-manager.js';
import { VisionAssistant, type ImageInput } from '../agent/vision.js';
import type { AppConfig, OutputStyle } from '../config/schema.js';
import type { ChatMessage } from './components/ChatView.js';
import type { TraceCollector } from '../harness/trace-collector.js';
import type { AuditLogger } from '../harness/audit-logger.js';
// Phase 37：SkillsRouter——按用户消息匹配已启用 Skill，注入到 system prompt
import type { SkillsRouter } from '../plugins/filesystem-discovery.js';
// Phase 34 Task 3：动作动词体系
import { formatToolFeedback, getToolRunningMessageId } from './tool-verb.js';
// Phase 34 Task 2：微摘要
import { generateMicroSummary } from '../agent/micro-summary.js';
import { shouldAutoCollapseOnComplete } from './output-style.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { estimateTokens } from '../utils/token-estimate.js';
import { notifyRoutingFallback } from './notification.js';

/**
 * Phase 32 Task 4.6：检测项目上下文，为分类器提供背景信息
 * 检测项目类型（基于标志性文件）和 git 工作区状态
 *
 * M7 修复：添加 TTL 缓存，避免每条用户消息都 spawnSync git status
 * 原实现每条消息都同步调用 spawnSync，阻塞事件循环 3 秒（最坏情况）
 * 修复：缓存结果 30 秒，同一会话内不重复检测
 */
const PROJECT_CONTEXT_CACHE_TTL_MS = 30000; // 30 秒
const projectContextCache = new Map<string, { result: { projectType: string; hasGitChanges: boolean }; timestamp: number }>();

function detectProjectContext(cwd: string): { projectType: string; hasGitChanges: boolean } {
  // M7 修复：检查缓存
  const cached = projectContextCache.get(cwd);
  if (cached && Date.now() - cached.timestamp < PROJECT_CONTEXT_CACHE_TTL_MS) {
    return cached.result;
  }

  // 项目类型检测：通过标志性文件判断
  let projectType = 'unknown';
  const checks: Array<[string, string]> = [
    ['package.json', 'nodejs'],
    ['pom.xml', 'java-maven'],
    ['build.gradle', 'java-gradle'],
    ['Cargo.toml', 'rust'],
    ['go.mod', 'go'],
    ['pyproject.toml', 'python'],
    ['setup.py', 'python'],
  ];
  for (const [file, type] of checks) {
    if (fs.existsSync(path.join(cwd, file))) {
      projectType = type;
      break;
    }
  }

  // git 工作区状态检测（spawnSync 快速检查，失败时默认 false）
  let hasGitChanges = false;
  try {
    const result = spawnSync('git', ['status', '--porcelain'], { cwd, timeout: 3000, encoding: 'utf-8' });
    if (result.status === 0) {
      hasGitChanges = result.stdout.trim().length > 0;
    }
  } catch {
    // git 不可用或非 git 仓库，默认无更改
  }

  const result = { projectType, hasGitChanges };
  // M7 修复：写入缓存
  projectContextCache.set(cwd, { result, timestamp: Date.now() });
  return result;
}

/** ChatRunner 依赖的外部对象（由 App.tsx 注入） */
export interface ChatRunnerDeps {
  classifier: ScenarioClassifier;
  modelRouter: ModelRouter;
  clientManager: LLMClientManager;
  tracker: TokenTracker;
  agentLoop: ReActAgentLoop;
  contextManager: ContextManager;
  visionAssistant: VisionAssistant;
  config: AppConfig;
  /** Phase 30：系统提示词改为 ref（支持 PromptTemplateManager 异步渲染后更新） */
  systemPromptRef: { current: string };
  /** 对话历史 ref（会被读写） */
  conversationHistoryRef: { current: LLMMessage[] };
  /** 工具确认 pending ref（会被读写） */
  pendingConfirmRef: { current: { resolve: (approved: boolean) => void; toolName: string } | null };
  /** 中断控制器 ref（会被读写） */
  abortControllerRef: { current: AbortController | null };
  /** 设置消息（用于追加/更新消息） */
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  /** 设置处理状态 */
  setIsProcessing: (v: boolean) => void;
  /** 设置当前模型 */
  setCurrentModel: (m: string) => void;
  /** 设置当前场景层级 */
  setCurrentTier: (t: ScenarioTier) => void;
  /** 设置降级标志 */
  setIsDegraded: (v: boolean) => void;
  /** 累加今日 Token 用量 */
  setTodayTokensUsed: (updater: (prev: number) => number) => void;
  /** Phase 30：Token Profiler（可选） */
  profiler?: TokenProfiler;
  /** Phase 34：Trace 收集器（可选，用于 trajectory 汇总） */
  trace?: TraceCollector;
  /** Phase 34：审计日志器（可选，用于 trajectory 汇总落盘） */
  audit?: AuditLogger;
  /** Phase 34：运行时获取当前 outputStyle（支持 /output-style 切换） */
  getOutputStyle?: () => OutputStyle;
  /** Phase 37 P0-1：SkillsRouter——按用户消息匹配已启用 Skill，注入到 system prompt（可选） */
  skillsRouter?: SkillsRouter;
  /** 生成消息 ID */
  nextId: () => string;
}

/** 创建聊天运行器 */
export function createChatRunner(deps: ChatRunnerDeps) {
  const {
    classifier, modelRouter, clientManager, tracker, agentLoop,
    contextManager, visionAssistant, config, systemPromptRef,
    conversationHistoryRef, pendingConfirmRef, abortControllerRef,
    setMessages, setIsProcessing, setCurrentModel, setCurrentTier,
    setIsDegraded, setTodayTokensUsed, profiler, trace, audit,
    getOutputStyle, nextId, skillsRouter,
  } = deps;

  // Phase 34：获取当前 outputStyle（未传入时回退到 config）
  function currentOutputStyle(): OutputStyle {
    return getOutputStyle ? getOutputStyle() : config.ui.outputStyle;
  }

  /**
   * 处理非命令输入：分类路由 → 视觉处理 → Agent Loop → Token 统计 → 检查点/压缩
   * 调用方需在调用前已将用户消息追加到 messages，并设置 isProcessing=true
   */
  async function runChat(text: string): Promise<void> {
    // Phase 34：将 finally 块需要用到的变量提升到 try 外部，确保汇总逻辑可访问
    let routeDecision: RoutingResult | null = null;
    let accumulatedContent = '';
    let actualUserMessage = text;
    let chatAbort: AbortController | null = null;
    let hasTaskError = false;
    try {
      // Phase 32 Task 4.6：传入项目上下文，帮助 LLM 分类器做出更准确的判断
      const projectContext = detectProjectContext(process.cwd());
      const classifyResult = await classifier.classify({ query: text, context: projectContext });
      setCurrentTier(classifyResult.tier);
      const routeDecisionResult = await modelRouter.route(classifyResult);
      routeDecision = routeDecisionResult;
      // 局部常量，供 try 块内使用（避免 null 收窄问题）；外层 routeDecision 供 finally 使用
      const rd = routeDecisionResult;
      const fallbackNotice = notifyRoutingFallback(rd);
      if (fallbackNotice) {
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: fallbackNotice }]);
      }
      setCurrentModel(rd.model.id);
      setIsDegraded(rd.degraded);

      const client = clientManager.get(rd.providerId);
      if (!client || !client.isReady()) {
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `错误: 提供商 ${rd.providerId} 不可用。请检查 API Key 配置。` }]);
        setIsProcessing(false);
        return;
      }

      const assistantId = nextId();
      setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', tier: classifyResult.tier, modelId: rd.model.id, isStreaming: true }]);

      accumulatedContent = '';
      let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      // 处理 @图片引用
      actualUserMessage = text;
      const imageRefs = VisionAssistant.extractImageReferences(text);
      if (imageRefs.length > 0) {
        const loadedImages: ImageInput[] = [];
        for (const ref of imageRefs) {
          const img = await VisionAssistant.loadImage(ref, process.cwd());
          if (img) loadedImages.push(img);
        }
        if (loadedImages.length > 0) {
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `📷 正在分析 ${loadedImages.length} 张图片...` }]);
          const visionResult = await visionAssistant.analyze(loadedImages, `用户问题: ${text}`);
          if (visionResult) {
            for (const img of loadedImages) {
              if (img.fileName) actualUserMessage = actualUserMessage.replace(`@${img.fileName}`, `[图片:${img.fileName}]`);
            }
            actualUserMessage = `[图片分析结果]\n${visionResult.description}\n\n[用户原问题]\n${actualUserMessage}`;
            setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `✓ 图片分析完成（${visionResult.modelId}，${visionResult.inputTokens + visionResult.outputTokens} tokens）` }]);
          }
        }
      }

      chatAbort = new AbortController();
      abortControllerRef.current = chatAbort;
      try {
        // Phase 37 P0-1：Skill 路由——按用户消息匹配已启用 Skill，将内容追加到 systemPrompt
        // 与 engine-bridge.ts sendChat 路径对齐，避免 CLI 端 Skill 永不生效
        let skillPromptSuffix = '';
        if (skillsRouter) {
          const matchedSkills = skillsRouter.route(actualUserMessage, 3);
          if (matchedSkills.length > 0) {
            const skillBlocks = matchedSkills.map((s) =>
              `## Skill: ${s.name}\n${s.content}`,
            );
            skillPromptSuffix = `\n\n---\n# 已激活的 Skill（根据任务自动匹配）\n${skillBlocks.join('\n\n')}`;
          }
        }
        for await (const event of agentLoop.run({
          userMessage: actualUserMessage, llmClient: client, routeDecision: rd,
          conversationHistory: conversationHistoryRef.current, systemPrompt: systemPromptRef.current + skillPromptSuffix,
          signal: chatAbort.signal,
          onModelSuccess: modelId => modelRouter.recordModelSuccess(modelId),
          onModelFailure: modelId => modelRouter.recordModelFailure(modelId),
          onConfirmTool: async (toolName, args) => new Promise<boolean>(resolve => {
            pendingConfirmRef.current = { resolve, toolName };
            const argsStr = JSON.stringify(args, null, 2).slice(0, 200);
            setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `⚠️  工具 ${toolName} 需要确认 [y/n]\n参数: ${argsStr}` }]);
            setIsProcessing(false);
          }),
        })) {
          const outputStyle = currentOutputStyle();
          switch (event.type) {
            case 'text_delta':
              accumulatedContent += event.text;
              setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accumulatedContent } : m));
              break;
            case 'tool_call_start': {
              // Phase 34 Task 3：动词体系 + 待执行状态
              const runningId = getToolRunningMessageId(event.toolCallId);
              const content = formatToolFeedback(
                event.toolName,
                'running',
                event.args,
                undefined,
                false,
                outputStyle,
              );
              setMessages(prev => {
                // 避免重复添加同一 toolCallId 的运行中消息
                if (prev.some(m => m.id === runningId)) return prev;
                return [...prev, {
                  id: runningId,
                  role: 'system',
                  content,
                  isPending: true,
                  pendingSince: Date.now(),
                }];
              });
              break;
            }
            case 'tool_call_result': {
              // Phase 34 Task 3：用过去时动词替换运行中消息
              const runningId = getToolRunningMessageId(event.toolCallId);
              const content = formatToolFeedback(
                event.toolName,
                'completed',
                {},
                event.result,
                event.isError,
                outputStyle,
              );
              if (event.isError) hasTaskError = true;
              setMessages(prev => prev.map(m => {
                if (m.id !== runningId) return m;
                return { ...m, content, isPending: false };
              }));
              // 若未找到运行中消息（如从旧事件流降级），追加一条
              setMessages(prev => {
                if (prev.some(m => m.id === runningId)) return prev;
                return [...prev, { id: nextId(), role: 'system', content }];
              });
              break;
            }
            case 'error':
              hasTaskError = true;
              setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accumulatedContent + `\n⚠️ ${event.error}` } : m));
              break;
            case 'done':
              finalUsage = event.usage;
              break;
            // Phase 30：token_profile 事件由 profiler 内部记录，这里无需额外处理
            // 但保留 case 防止 default 分支告警
            case 'token_profile':
              break;
          }
        }

        // 更新 Token 统计 + 对话历史
        setTodayTokensUsed(prev => prev + finalUsage.totalTokens);
        tracker.record(finalUsage, { modelId: rd.model.id, agentId: 'default', stepId: 'chat' });

        // Phase 30：Token 预算检查（接入 checkBudget）
        const budgetOk = tracker.checkBudget();
        if (!budgetOk) {
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `⚠️ Token 预算已达 ${Math.round(tracker.getUsagePercent() * 100)}%，后续调用可能被限制` }]);
        }

        // Phase 30：持久化 Token Profile 快照
        if (profiler && config.optimization?.tokenTracking?.persistSession) {
          const outputDir = config.optimization.tokenTracking.outputDir;
          const fullDir = path.isAbsolute(outputDir) ? outputDir : path.join(process.cwd(), outputDir);
          await profiler.persistSession(fullDir, `chat-${Date.now()}`);
        }
        conversationHistoryRef.current.push({ role: 'user', content: actualUserMessage });
        conversationHistoryRef.current.push({ role: 'assistant', content: accumulatedContent });
        if (conversationHistoryRef.current.length > 20) {
          conversationHistoryRef.current = conversationHistoryRef.current.slice(-20);
        }

        // 增量 Checkpoint + 压缩
        if (config.checkpoint.enabled) {
          const usagePercent = tracker.getUsagePercent();
          const triggers = config.checkpoint.triggers.map(t => ({ level: t.level, action: t.action as 'initial' | 'incremental' | 'compress' }));
          const triggerAction = contextManager.shouldTriggerCheckpoint(usagePercent, triggers);
          if (triggerAction) {
            const cp = await contextManager.triggerCheckpoint(triggerAction, conversationHistoryRef.current, usagePercent);
            if (cp) {
              setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `🧠 记忆已保存 (${triggerAction}): ${cp.currentIntent}` }]);
              await contextManager.saveCheckpoint();
            }
          }
          const estimatedTokens = conversationHistoryRef.current.reduce((acc, msg) => {
            const t = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            return acc + estimateTokens(t);
          }, 0);
          if (contextManager.shouldCompress(conversationHistoryRef.current.length, estimatedTokens)) {
            const { compressed, result } = contextManager.compress(conversationHistoryRef.current);
            conversationHistoryRef.current = compressed;
            setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `📦 上下文已压缩: ${result.originalCount} → ${result.compressedCount} 条` }]);
          }
        }

        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accumulatedContent, isStreaming: false } : m));
        // CONCERN 修复：CircuitBreaker 接入——成功时重置失败计数
        modelRouter.recordModelSuccess(rd.model.id);
      } catch (error) {
        // CONCERN 修复：CircuitBreaker 接入——LLM 调用失败时记录
        if (routeDecision?.model?.id) modelRouter.recordModelFailure(routeDecision.model.id);
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: `错误: ${error instanceof Error ? error.message : String(error)}`, isStreaming: false } : m));
      }
    } catch (error) {
      // CONCERN 修复：CircuitBreaker 接入——路由或其他失败时记录
      if (routeDecision?.model?.id) modelRouter.recordModelFailure(routeDecision.model.id);
      setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `错误: ${error instanceof Error ? error.message : String(error)}` }]);
    } finally {
      setIsProcessing(false);
      // Phase 34：任务结束时记录 trajectory 级过程评测汇总
      let trajectorySummary = null;
      if (trace && audit) {
        try {
          trajectorySummary = trace.summarizeTrajectory({
            success: chatAbort ? !chatAbort.signal.aborted && !hasTaskError : !hasTaskError,
            terminationReason: chatAbort && chatAbort.signal.aborted ? 'cancelled' : (hasTaskError ? 'error' : 'completed'),
            modelId: routeDecision?.model.id,
            tier: routeDecision?.originalTier,
          });
          audit.logTrajectorySummary(trajectorySummary);
        } catch (err) {
          logger.warn('ChatRunner: failed to log trajectory summary', { error: String(err) });
        }
      }

      // Phase 34 Task 2：生成并展示微摘要
      try {
        if (trace) {
          const status: 'success' | 'failure' = hasTaskError ? 'failure' : 'success';
          const microSummary = generateMicroSummary(
            actualUserMessage,
            accumulatedContent,
            trace.getSpans(),
            trajectorySummary,
            status,
          );
          // 只有确实存在工具调用或关键决策时才展示微摘要，避免空卡片
          const hasMeaningfulSummary =
            microSummary.stepCount > 0 ||
            microSummary.keyDecisions.length > 0 ||
            microSummary.fileChanges.length > 0;
          if (hasMeaningfulSummary) {
            const outputStyle = currentOutputStyle();
            const collapsed = status === 'success'
              ? shouldAutoCollapseOnComplete(outputStyle)
              : false;
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: '',
              microSummary,
              collapsed,
            }]);
          }
        }
      } catch (err) {
        logger.warn('ChatRunner: failed to generate micro summary', { error: String(err) });
      }
    }
  }

  return { runChat };
}
