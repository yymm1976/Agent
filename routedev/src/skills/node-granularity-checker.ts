// src/skills/node-granularity-checker.ts
// 节点粒度检查器（Phase 49 Task 1.9 — 2-5 分钟粒度原则）
//
// 知识库原文（主题-AI项目长期迭代）：
//   "任务粒度 2-5 分钟：太粗 AI 走偏，不好 review；
//    太细上下文频繁切换，效率低。
//    2-5 分钟 = 刚好一次对话能完成。"
//
// 启发式判定：
//   - prompt 中包含"重构整个""重写所有""全面"等词 → 疑似太粗
//   - prompt 仅是"运行某命令并检查输出"且无 allowedTools → 疑似太细
//
// 粒度检查是警告而非阻断——只是提示用户"这个节点可能太粗/太细"，
// 不阻止 SkillFlow 加载。最终是否拆分由用户决定。

import type { FlowNode, GranularityWarning } from './skill-flow-types.js';

/** 太粗关键词正则（>5 分钟工作量的信号词） */
const TOO_COARSE_PATTERN = /重构整个|重写所有|全面|complete\s+all|refactor\s+(?:the\s+)?module/i;

/** 太细关键词正则（<2 分钟工作量的信号词） */
const TOO_FINE_PATTERN = /运行.*命令|执行.*脚本|run.*command|execute.*script/i;

/**
 * 节点粒度检查器——确保 step 节点是一次对话能完成的粒度
 *
 * 设计原则：
 *   - 太粗（>5分钟工作量）：AI 容易走偏，checkpoint 难以判定
 *   - 太细（<2分钟工作量）：上下文频繁切换，SkillFlow 流转开销 > 执行开销
 *   - 2-5 分钟 = 刚好一次 ReAct 循环能完成
 */
export class NodeGranularityChecker {
  /**
   * 检查单个节点的粒度
   *
   * @param node 待检查节点
   * @returns 警告列表（可能为空，表示粒度合理）
   */
  static check(node: FlowNode): GranularityWarning[] {
    const warnings: GranularityWarning[] = [];

    // 只检查 step 节点（其他类型节点不需要 2-5 分钟粒度）
    if (node.type !== 'step') {
      return warnings;
    }

    // 太粗检查：prompt 含"重构整个/重写所有/全面"等词
    if (TOO_COARSE_PATTERN.test(node.prompt)) {
      warnings.push({
        nodeId: node.id,
        level: 'too-coarse',
        message: '节点疑似粒度过粗（>5分钟工作量），建议拆分为多个 step',
      });
    }

    // 太细检查：prompt 含"运行命令/执行脚本"且无 allowedTools 配置
    // 启发式：单纯运行命令的节点应合并到上一步，避免上下文频繁切换
    if (TOO_FINE_PATTERN.test(node.prompt) && (!node.allowedTools || node.allowedTools.length === 0)) {
      warnings.push({
        nodeId: node.id,
        level: 'too-fine',
        message: '节点疑似粒度过细（<2分钟工作量），建议合并到上游 step',
      });
    }

    return warnings;
  }

  /**
   * 批量检查多个节点
   *
   * @param nodes 节点列表
   * @returns 所有节点的警告汇总
   */
  static checkAll(nodes: FlowNode[]): GranularityWarning[] {
    return nodes.flatMap((n) => NodeGranularityChecker.check(n));
  }
}
