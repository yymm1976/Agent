// src/code-map/extractor.ts
// AST 符号/边提取器（dispatcher：按语言分派到对应 extractor）

import type {
  CodeMapNode,
  CodeMapEdge,
  Language,
} from './schema.js';
import { EDGE_WEIGHTS } from './schema.js';
import type { TSTree } from './parser.js';
import type { TSNode } from './parser.js';
import { extractTsNode } from './extractor-ts.js';
import { extractPyNode } from './extractor-py.js';
import { extractJavaNode } from './extractor-java.js';
import { extractGoNode } from './extractor-go.js';
import {
  makeEdgeId,
} from './extractor-utils.js';
import type {
  PendingReference,
  ExtractionResult,
} from './extractor-utils.js';

// 类型 re-export 保持公共 API 兼容（其他模块仍可从 './extractor.js' 导入 PendingReference / ExtractionResult）
export type { PendingReference, ExtractionResult } from './extractor-utils.js';

/** 递归遍历 AST 提取符号和边（dispatcher：按 language 分派到对应语言的 extractor） */
function walkAndExtract(
  node: TSNode,
  filePath: string,
  language: Language,
  parentClass: string | null,
  nodes: CodeMapNode[],
  edges: CodeMapEdge[],
  fileNodeId: string,
  pendingReferences: PendingReference[],
): void {
  let shortCircuit = false;

  // ---- 符号提取：按语言分派 ----
  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    shortCircuit = extractTsNode(
      node,
      filePath,
      language,
      parentClass,
      nodes,
      edges,
      fileNodeId,
      pendingReferences,
      walkAndExtract,
    );
  } else if (language === 'python') {
    shortCircuit = extractPyNode(
      node,
      filePath,
      language,
      parentClass,
      nodes,
      edges,
      fileNodeId,
      pendingReferences,
      walkAndExtract,
    );
  } else if (language === 'java') {
    shortCircuit = extractJavaNode(
      node,
      filePath,
      language,
      parentClass,
      nodes,
      edges,
      fileNodeId,
      pendingReferences,
      walkAndExtract,
    );
  } else if (language === 'go') {
    shortCircuit = extractGoNode(
      node,
      filePath,
      language,
      parentClass,
      nodes,
      edges,
      fileNodeId,
      pendingReferences,
      walkAndExtract,
    );
  }

  // 递归遍历子节点（除非语言 extractor 已自行处理递归并短路）
  if (!shortCircuit) {
    for (const child of node.children) {
      walkAndExtract(child, filePath, language, parentClass, nodes, edges, fileNodeId, pendingReferences);
    }
  }
}

/** 从 AST 树提取符号和边 */
export function extractFromTree(
  tree: TSTree,
  filePath: string,
  language: Language,
): ExtractionResult {
  const nodes: CodeMapNode[] = [];
  const edges: CodeMapEdge[] = [];
  const pendingReferences: PendingReference[] = [];
  const unresolvedRefs: PendingReference[] = [];
  const fileNodeId = `file:${filePath}`;

  walkAndExtract(tree.rootNode, filePath, language, null, nodes, edges, fileNodeId, pendingReferences);

  // Phase 72 Task D4：构建当前文件的 importedName → sourceModule 映射
  // 用于给 unresolved refs 附加 importSource，供 indexer.resolveCrossFileCalls 精确解析
  const localImportMap = new Map<string, string>(); // importedName → sourceModule
  for (const node of nodes) {
    if (node.kind !== 'import' || !node.sourceModule || !node.importedNames) continue;
    for (const name of node.importedNames) {
      // 同名 import 取第一个（覆盖语义暂不处理，影响可忽略）
      if (!localImportMap.has(name)) localImportMap.set(name, node.sourceModule);
    }
  }

  // 解析 pendingReferences：按名字匹配定义节点，匹配成功生成 CALLS 边（target=节点 ID），未匹配存入 unresolvedRefs
  for (const ref of pendingReferences) {
    // 优先精确匹配：同文件作用域内或跨文件 exported
    const def = nodes.find(n =>
      n.name === ref.calleeName &&
      (n.filePath === ref.filePath || n.exported === true),
    );
    if (def) {
      edges.push({
        id: makeEdgeId(ref.sourceId, def.id, 'CALLS'),
        source: ref.sourceId,
        target: def.id, // 修复：target 是节点 ID，不是字符串名字
        kind: 'CALLS',
        weight: EDGE_WEIGHTS.CALLS,
      });
    } else {
      // Phase 72 Task D4：附加 importSource（若 calleeName 来自当前文件 import）
      const importSource = localImportMap.get(ref.calleeName);
      unresolvedRefs.push(importSource ? { ...ref, importSource } : ref);
    }
  }

  return { nodes, edges, unresolvedRefs };
}
