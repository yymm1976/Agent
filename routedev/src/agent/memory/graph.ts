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

import { KnowledgeGraph } from './graph-core.js';
import { applyCommunityMethods } from './graph-community.js';
import { applyRecallMethods } from './graph-recall.js';

// 先应用 community 方法注入（提供 detectCommunities / clusterSimilarNodes）
applyCommunityMethods(KnowledgeGraph);
// 再应用 recall 方法注入（依赖 detectCommunities，提供 recall / recallV2 等方法）
applyRecallMethods(KnowledgeGraph);

export { KnowledgeGraph };
export type { NodeType, EdgeType, GraphNode, GraphEdge, RecallStrategy, ForgetResult, ImproveResult } from './graph-core.js';
