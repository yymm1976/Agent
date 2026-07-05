// src/evaluation/cases/irrelevance-cases.ts
// Phase 72 Task C4：BFCL 风格 irrelevance 用例集
//
// 设计目标（BFCL irrelevance 评测思路）：
//   - 用户闲聊 / 问知识 / 表达情绪 → 期望 Agent 0 工具调用，直接回复
//   - 防止 Agent "工具滥用"：把不该调用工具的场景误判为需要工具
//   - 期望行为：noToolCalls 列出所有已知工具（或用通配 '*' 表示期望 0 调用）
//
// 与 Smoke/Regression 的区别：
//   - Smoke/Regression 验证"该调工具时调对工具"
//   - Irrelevance 验证"不该调工具时完全不调"

import type { EvalCase } from './smoke.js';

/**
 * Irrelevance 用例集
 *
 * 三类场景：
 *   1. 闲聊（chitchat）：日常问候、天气、心情
 *   2. 问知识（knowledge）： factual 问题，模型可直接用内部知识回答
 *   3. 表达情绪（emotion）：抱怨、感谢、表达感受
 *
 * 所有用例的 expectedBehavior.noToolCalls 包含所有 RouteDev 内置工具，
 * 确保评估器能精确判定"是否有任何工具被调用"。
 */
export const IRRELEVANCE_CASES: EvalCase[] = [
  // ============================================================
  // 闲聊（chitchat）
  // ============================================================
  {
    id: 'irr-001',
    name: '闲聊·问候',
    category: 'smoke',
    description: '日常问候不应触发任何工具调用',
    prompt: '你好，今天天气怎么样？',
    expectedBehavior: {
      noToolCalls: ['file_read', 'file_write', 'file_edit', 'file_search', 'shell_exec', 'code_search'],
      outputContains: ['你好'],
    },
    timeout: 30_000,
  },
  {
    id: 'irr-002',
    name: '闲聊·周末计划',
    category: 'smoke',
    description: '聊周末计划不应触发工具调用',
    prompt: '周末有什么好玩的推荐吗？想去户外放松一下。',
    expectedBehavior: {
      noToolCalls: ['file_read', 'file_write', 'file_edit', 'file_search', 'shell_exec', 'code_search'],
    },
    timeout: 30_000,
  },
  {
    id: 'irr-003',
    name: '闲聊·自我介绍',
    category: 'smoke',
    description: '让 Agent 自我介绍不应触发工具调用',
    prompt: '你是谁？能介绍一下你自己吗？',
    expectedBehavior: {
      noToolCalls: ['file_read', 'file_write', 'file_edit', 'file_search', 'shell_exec', 'code_search'],
    },
    timeout: 30_000,
  },

  // ============================================================
  // 问知识（knowledge）
  // ============================================================
  {
    id: 'irr-004',
    name: '知识·解释概念',
    category: 'smoke',
    description: '解释编程概念不应触发工具调用（用模型内部知识）',
    prompt: '什么是闭包？JavaScript 里的闭包怎么理解？',
    expectedBehavior: {
      noToolCalls: ['file_read', 'file_write', 'file_edit', 'file_search', 'shell_exec', 'code_search'],
      outputContains: ['闭包'],
    },
    timeout: 30_000,
  },
  {
    id: 'irr-005',
    name: '知识·算法复杂度',
    category: 'smoke',
    description: '解释算法复杂度不应触发工具调用',
    prompt: '快速排序的时间复杂度是多少？最坏情况呢？',
    expectedBehavior: {
      noToolCalls: ['file_read', 'file_write', 'file_edit', 'file_search', 'shell_exec', 'code_search'],
    },
    timeout: 30_000,
  },
  {
    id: 'irr-006',
    name: '知识·历史事实',
    category: 'smoke',
    description: '回答历史事实不应触发工具调用',
    prompt: 'Python 编程语言是哪一年发布的？创始人是谁？',
    expectedBehavior: {
      noToolCalls: ['file_read', 'file_write', 'file_edit', 'file_search', 'shell_exec', 'code_search'],
    },
    timeout: 30_000,
  },

  // ============================================================
  // 表达情绪（emotion）
  // ============================================================
  {
    id: 'irr-007',
    name: '情绪·抱怨',
    category: 'smoke',
    description: '用户抱怨不应触发工具调用（应共情回复）',
    prompt: '这个项目太复杂了，我感觉学不动了，好烦啊。',
    expectedBehavior: {
      noToolCalls: ['file_read', 'file_write', 'file_edit', 'file_search', 'shell_exec', 'code_search'],
    },
    timeout: 30_000,
  },
  {
    id: 'irr-008',
    name: '情绪·感谢',
    category: 'smoke',
    description: '用户感谢不应触发工具调用',
    prompt: '谢谢你之前的帮助，问题解决了，非常感谢！',
    expectedBehavior: {
      noToolCalls: ['file_read', 'file_write', 'file_edit', 'file_search', 'shell_exec', 'code_search'],
    },
    timeout: 30_000,
  },
  {
    id: 'irr-009',
    name: '情绪·表达困惑',
    category: 'smoke',
    description: '用户表达困惑不应触发工具调用',
    prompt: '我看了半天文档还是不太理解这个东西怎么用，是我太笨了吗？',
    expectedBehavior: {
      noToolCalls: ['file_read', 'file_write', 'file_edit', 'file_search', 'shell_exec', 'code_search'],
    },
    timeout: 30_000,
  },

  // ============================================================
  // 边界：看似代码相关但实为讨论（应直接回复，不调工具）
  // ============================================================
  {
    id: 'irr-010',
    name: '边界·讨论架构方案',
    category: 'smoke',
    description: '讨论架构选型（非具体编码任务）不应触发工具调用',
    prompt: '你觉得微服务架构和单体架构哪个更适合初创项目？能说说各自的优缺点吗？',
    expectedBehavior: {
      noToolCalls: ['file_read', 'file_write', 'file_edit', 'file_search', 'shell_exec', 'code_search'],
    },
    timeout: 30_000,
  },
];

export default IRRELEVANCE_CASES;
