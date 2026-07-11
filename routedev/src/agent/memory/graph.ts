// src/agent/memory/graph.ts
// 轻量知识图谱组合入口（保持对外 API 不变）
//
// 本文件不包含业务逻辑，仅组合三个职责模块：
//   1. graph-core.ts        — 核心结构 + PPR + 知识生命周期（节点/边存储、PPR 算法、置信度、improve/forget）
//   2. graph-community.ts   — Label Propagation 社区检测 + Jaccard 相似度聚类
//   3. graph-recall.ts      — 双路径召回 + recallV2 多策略召回
//
// 组合方式：declaration merging + prototype 注入。
// 先应用 community（recall 依赖 detectCommunities），再应用 recall。
// 对外导出的 KnowledgeGraph 已具备全部能力，所有 `import { KnowledgeGraph } from './graph.js'`
// 的代码无需修改。
//
// Phase 81 Task 3：KG 高级算法（社区检测，freeze 层 F-03）默认不装配
//   - recall 方法始终装配（Core MemoryRecallInjector C-35 依赖，Core 场景不受影响）
//   - community 方法（detectCommunities / clusterSimilarNodes）改为条件装配
//   - 未装配 community 时，recall 内部对 detectCommunities 做 typeof 守卫，退化为精确路径召回
//   - 由 initKnowledgeGraphAdvanced() 显式调用装配，app-init-memory.ts 根据 packs.kgAdvanced.enabled 决定

import { KnowledgeGraph } from './graph-core.js';
import { applyCommunityMethods } from './graph-community.js';
import { applyRecallMethods } from './graph-recall.js';

// recall 方法始终装配（Core 依赖）：提供 recall / recallV2 等方法
// recall 内部对 detectCommunities 做 typeof 守卫，未装配 community 时退化为精确路径召回
applyRecallMethods(KnowledgeGraph);

// KG 高级算法（社区检测）条件装配标志
let kgAdvancedApplied = false;

/**
 * 装配 KG 高级算法（社区检测 + 聚类）
 * Phase 81 Task 3：freeze 层 F-03，默认不装配
 * 仅当 config.packs.kgAdvanced.enabled 时由 app-init-memory 调用
 */
export function initKnowledgeGraphAdvanced(): void {
  if (kgAdvancedApplied) return;
  // 先应用 community 方法注入（提供 detectCommunities / clusterSimilarNodes）
  applyCommunityMethods(KnowledgeGraph);
  kgAdvancedApplied = true;
}

export { KnowledgeGraph };
export type { NodeType, EdgeType, GraphNode, GraphEdge, RecallStrategy, ForgetResult, ImproveResult } from './graph-core.js';
