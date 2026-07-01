// src/agent/patterns/coverage-check.ts
// Phase 49 Task 6.4：五大设计模式覆盖检查
//
// 知识库原文：
//   "五大核心模式：提示链、路由、并行、反思、护栏
//    ——覆盖了从任务拆解到安全防护的完整链路。"
//
// 实现方式：静态检查（文件存在 + 类导出）
//   - 本目录的 PromptChain / ReflectionPattern：通过 import 后 typeof 检查
//   - 路由：RoutingFunnel 已移除，路由由 ModelRouter + ScenarioClassifier 承担
//   - 并行/护栏已有实现：通过文件存在性检查（避免引入重型依赖）
//
// 用途：
//   - 上线前自检——确认五大模式全部覆盖
//   - 架构审计——快速定位缺失模式
//   - 文档生成——输出覆盖报告

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PromptChain } from './prompt-chain.js';
import { ReflectionPattern } from './reflection.js';
import { logger } from '../../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 单个模式的覆盖状态 */
export interface PatternCoverageReport {
  /** 各模式覆盖状态 */
  patterns: {
    /** 提示链：PromptChain（本 Phase 实现） */
    promptChain: boolean;
    /** 路由：RoutingFunnel 已移除，路由由 ModelRouter + ScenarioClassifier 承担 */
    routing: boolean;
    /** 并行：ReActAgentLoop.parallelToolExecution + multi/orchestrator（已有） */
    parallel: boolean;
    /** 反思：ReflectionPattern + 双循环（本 Phase 实现） */
    reflection: boolean;
    /** 护栏：PermissionEngine + Hook + middleware/loop-detection（已有） */
    guardrail: boolean;
  };
  /** 审计说明（每个模式的判定依据） */
  notes: string[];
}

// ============================================================
// 静态检查辅助
// ============================================================

/** 当前模块所在目录（src/agent/patterns/） */
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
/** 项目根目录（routedev/） */
const PROJECT_ROOT = resolve(CURRENT_DIR, '..', '..', '..');

/**
 * 检查相对于项目根的文件是否存在
 * @param relativePath 相对于项目根的路径（如 'src/agent/loop.ts'）
 */
function fileExists(relativePath: string): boolean {
  return existsSync(resolve(PROJECT_ROOT, relativePath));
}

/** 检查给定的类/函数是否已导出（typeof === 'function'） */
function isExported(target: unknown): boolean {
  return typeof target === 'function';
}

// ============================================================
// 主检查函数
// ============================================================

/**
 * 检查五大设计模式的覆盖情况
 *
 * 判定依据：
 *   1. promptChain：PromptChain 类已导出（src/agent/patterns/prompt-chain.ts）
 *   2. routing：RoutingFunnel 已移除，路由由 ModelRouter + ScenarioClassifier 承担
 *   3. parallel：ReActAgentLoop 所在文件 + multi/orchestrator 文件均存在
 *      —— ReActAgentLoop.parallelToolExecution 是 Phase 49 之前已有的并行工具执行能力
 *      —— multi/orchestrator 提供多 Worker 并行编排能力
 *   4. reflection：ReflectionPattern 类已导出 + DualLoopOrchestrator 文件存在
 *      —— ReflectionPattern 是轻量反思（本 Phase）
 *      —— DualLoopOrchestrator 是反思的工程化实现（双循环，Phase 49 Task 2）
 *   5. guardrail：PermissionEngine + Hook + middleware/loop-detection 三个文件均存在
 *      —— PermissionEngine 提供工具调用权限管控
 *      —— Hook 提供执行前后挂钩门禁
 *      —— middleware/loop-detection 提供内循环工具调用循环检测
 *
 * @returns PatternCoverageReport 覆盖报告
 */
export function checkPatternCoverage(): PatternCoverageReport {
  const notes: string[] = [];

  // ===== 1. 提示链 =====
  const promptChainOk = isExported(PromptChain);
  notes.push(
    promptChainOk
      ? '[promptChain] ✓ PromptChain 类已导出（src/agent/patterns/prompt-chain.ts）'
      : '[promptChain] ✗ PromptChain 类未导出——缺失提示链模式',
  );

  // ===== 2. 路由 =====
  // RoutingFunnel 模块已移除（路由由 ModelRouter + ScenarioClassifier 承担）
  const routingOk = false;
  notes.push(
    '[routing] ℹ RoutingFunnel 已移除——路由由 ModelRouter + ScenarioClassifier 承担',
  );

  // ===== 3. 并行 =====
  // ReActAgentLoop.parallelToolExecution（src/agent/loop.ts）+ multi/orchestrator.ts
  const loopExists = fileExists('src/agent/loop.ts');
  const orchestratorExists = fileExists('src/agent/multi/orchestrator.ts');
  const parallelOk = loopExists && orchestratorExists;
  notes.push(
    parallelOk
      ? '[parallel] ✓ ReActAgentLoop.parallelToolExecution（src/agent/loop.ts）+ multi/orchestrator.ts 均存在'
      : `[parallel] ✗ 并行组件缺失——loop.ts=${loopExists}, orchestrator.ts=${orchestratorExists}`,
  );

  // ===== 4. 反思 =====
  // ReflectionPattern（本目录）+ DualLoopOrchestrator（src/agent/dual-loop-orchestrator.ts）
  const reflectionPatternOk = isExported(ReflectionPattern);
  const dualLoopExists = fileExists('src/agent/dual-loop-orchestrator.ts');
  const reflectionOk = reflectionPatternOk && dualLoopExists;
  notes.push(
    reflectionOk
      ? '[reflection] ✓ ReflectionPattern 类已导出 + DualLoopOrchestrator（src/agent/dual-loop-orchestrator.ts）文件存在（双循环是反思的工程化实现）'
      : `[reflection] ✗ 反思组件缺失——ReflectionPattern=${reflectionPatternOk}, dual-loop-orchestrator.ts=${dualLoopExists}`,
  );

  // ===== 5. 护栏 =====
  // PermissionEngine + Hook + middleware/loop-detection
  const permissionEngineExists = fileExists('src/tools/permission-engine.ts');
  const hookExists = fileExists('src/agent/hooks.ts');
  const loopDetectionExists = fileExists('src/agent/middleware/loop-detection.ts');
  const guardrailOk = permissionEngineExists && hookExists && loopDetectionExists;
  notes.push(
    guardrailOk
      ? '[guardrail] ✓ PermissionEngine（src/tools/permission-engine.ts）+ Hook（src/agent/hooks.ts）+ middleware/loop-detection（src/agent/middleware/loop-detection.ts）三层护栏均存在'
      : `[guardrail] ✗ 护栏组件缺失——permission-engine.ts=${permissionEngineExists}, hooks.ts=${hookExists}, loop-detection.ts=${loopDetectionExists}`,
  );

  const allCovered =
    promptChainOk && routingOk && parallelOk && reflectionOk && guardrailOk;

  logger.info('checkPatternCoverage: 五大模式覆盖检查完成', { allCovered });

  return {
    patterns: {
      promptChain: promptChainOk,
      routing: routingOk,
      parallel: parallelOk,
      reflection: reflectionOk,
      guardrail: guardrailOk,
    },
    notes,
  };
}
