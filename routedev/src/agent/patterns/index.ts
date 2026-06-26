// src/agent/patterns/index.ts
// Phase 49 Task 6.3：Agent 五大设计模式——提示链 + 反思模式统一导出
//
// 五大设计模式（知识库）：
//   1. 提示链（PromptChain）——本目录
//   2. 路由（RoutingFunnel）——src/router/routing-funnel.ts
//   3. 并行（ReActAgentLoop.parallelToolExecution + multi/orchestrator）——已有
//   4. 反思（ReflectionPattern + 双循环）——本目录 + dual-loop-orchestrator.ts
//   5. 护栏（PermissionEngine + Hook + loop-detection）——已有
//
// 覆盖检查见 ./coverage-check.ts

export { PromptChain } from './prompt-chain.js';
export type {
  ChainStep,
  ChainStepResult,
  ChainEvent,
  ExecuteStepCallback,
} from './prompt-chain.js';

export { ReflectionPattern } from './reflection.js';
export type {
  ReflectionParams,
  ReviewResult,
  ReflectionEvent,
  ReviewCallback,
  ReviseCallback,
} from './reflection.js';

export { checkPatternCoverage } from './coverage-check.js';
export type { PatternCoverageReport } from './coverage-check.js';
